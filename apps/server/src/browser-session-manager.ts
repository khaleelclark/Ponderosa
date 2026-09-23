import { createHash, randomUUID } from "node:crypto";
import { promises as fs, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type {
  AgentEvent,
  ArtifactDto,
  BrowserControlOwner,
  BrowserOperatorInputRequest,
  BrowserUploadResponseDto,
  BrowserSessionDto,
  BrowserFrameMetadata,
  BrowserViewportSize,
  BrowserActivityDto,
} from "@ponderosa/core";
import { publishManagedArtifactContentAsync, type ManagedArtifactContentHandle } from "@ponderosa/agents";
import { assetExtensionsForMediaType } from "./assets.js";
import type {
  BrowserDriver,
  BrowserDriverFactory,
  BrowserPageEvent,
  BrowserPageInfo,
  BrowserPagesInfo,
  BrowserUploadResult,
  BrowserSpawnPublicationOptions,
  BrowserTerminationHandle,
} from "./chrome-cdp-driver.js";
import { browserRuntimeCapabilities, BrowserDriverActionError } from "./chrome-cdp-driver.js";
import {
  BrowserProfileError,
  type BrowserProfileAuthority,
  type BrowserLaunchDescription,
  type BrowserLaunchLease,
} from "./browser-profile-authority.js";
import {
  boundBrowserSnapshot,
  BrowserSessionError,
  redactBrowserText,
  redactPageInfo,
  validateBrowserUrl,
} from "./browser-security.js";
import { recoverBrowserResidue } from "./browser-session-residue.js";

export { BrowserSessionError, redactBrowserUrl, validateBrowserUrl } from "./browser-security.js";
export type { RedactedBrowserUrl } from "./browser-security.js";

const VIEWPORT = { width: 1280, height: 720 } as const;
const MAX_CONSOLE_TEXT = 4_000;
const MAX_SNAPSHOT_TEXT = 16_000;
const MAX_SELECTOR_TEXT = 500;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const PDF_MEDIA_TYPE = "application/pdf";
const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
function uploadDisplayName(artifact: ArtifactDto): string {
  const original = path.basename(artifact.path).normalize("NFC");
  const cleaned = original
    .replace(/[<>:"/\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "_")
    .replace(/[. ]+$/gu, "");
  const extension = path.extname(cleaned);
  const extensionLength = Array.from(extension).length;
  const stem = extension ? cleaned.slice(0, -extension.length) : cleaned;
  const boundedStem = Array.from(stem).slice(0, Math.max(1, 160 - extensionLength)).join("");
  let bounded = (boundedStem + extension) || "upload";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(bounded)) bounded = "_" + bounded;
  return bounded;
}

function validateUploadArtifactName(artifact: ArtifactDto): void {
  const mediaType = artifact.mediaType?.toLowerCase().split(";", 1)[0]!.trim();
  const extension = path.extname(uploadDisplayName(artifact)).toLowerCase();
  const expectedExtensions = mediaType === PDF_MEDIA_TYPE
    ? assetExtensionsForMediaType("application/pdf")
    : mediaType === DOCX_MEDIA_TYPE
      ? [".docx"]
      : mediaType === "text/plain"
        ? assetExtensionsForMediaType("text/plain")
        : undefined;
  if (!expectedExtensions?.includes(extension)) {
    throw new BrowserSessionError(
      "The artifact filename extension does not match its supported media type.",
      415,
      "unsupported_upload_type",
    );
  }
}

function validateUploadArtifact(artifact: ArtifactDto, body: Buffer): void {
  if (!artifact.size || !artifact.sha256 || !artifact.mediaType) {
    throw new BrowserSessionError("Managed artifact metadata is incomplete.", 409, "artifact_content_changed");
  }
  if (artifact.size > MAX_UPLOAD_BYTES || body.length > MAX_UPLOAD_BYTES) {
    throw new BrowserSessionError("This artifact exceeds the 10 MiB browser upload limit.", 413, "upload_too_large");
  }
  if (body.length !== artifact.size ||
      createHash("sha256").update(body).digest("hex") !== artifact.sha256) {
    throw new BrowserSessionError("The managed artifact no longer matches its immutable catalog entry.", 409, "artifact_content_changed");
  }
  const mediaType = artifact.mediaType.toLowerCase().split(";", 1)[0]!.trim();
  if (mediaType === PDF_MEDIA_TYPE) {
    if (!body.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new BrowserSessionError("The artifact does not contain a valid PDF signature.", 415, "unsupported_upload_type");
    }
    return;
  }
  if (mediaType === DOCX_MEDIA_TYPE) {
    const hasZipSignature = body.length >= 4 && body[0] === 0x50 && body[1] === 0x4b &&
      (body[2] === 0x03 || body[2] === 0x05 || body[2] === 0x07) &&
      (body[3] === 0x04 || body[3] === 0x06 || body[3] === 0x08);
    if (!hasZipSignature || !body.includes(Buffer.from("[Content_Types].xml")) ||
        !body.includes(Buffer.from("word/"))) {
      throw new BrowserSessionError("The artifact does not contain a valid DOCX container.", 415, "unsupported_upload_type");
    }
    return;
  }
  if (mediaType === "text/plain") {
    if (body.includes(0)) {
      throw new BrowserSessionError("The artifact is not valid plain text.", 415, "unsupported_upload_type");
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new BrowserSessionError("The artifact is not valid UTF-8 plain text.", 415, "unsupported_upload_type");
    }
    return;
  }
  throw new BrowserSessionError("Only PDF, DOCX, and plain-text artifacts can be attached.", 415, "unsupported_upload_type");
}
export function browserUploadEligibility(
  artifact: ArtifactDto,
  body: Buffer,
): { eligible: true } | { eligible: false; reason: string; code: string } {
  try {
    validateUploadArtifactName(artifact);
    validateUploadArtifact(artifact, body);
    return { eligible: true };
  } catch (error) {
    if (error instanceof BrowserSessionError) {
      return { eligible: false, reason: error.message, code: error.code ?? "unsupported_upload" };
    }
    throw error;
  }
}


export interface BrowserUploadArtifact {
  artifact: ArtifactDto;
  content: ManagedArtifactContentHandle;
}

export type BrowserUploadArtifactResolver = (
  scope: BrowserScope,
  owner: BrowserControlOwner,
  artifactId: string,
) => Promise<BrowserUploadArtifact | undefined>;

export interface BrowserScope {
  projectId: string;
  agentId: string;
  runId: string;
  conversationId?: string;
  /** Optional real Run receiving audit/artifact records for a borrowed browser. */
  actorAgentId?: string;
  actorRunId?: string;
}

type BrowserAuditEvent = Extract<AgentEvent, {
  type: "browser_session" | "browser_action" | "browser_console" | "browser_screenshot";
}>;

interface ManagedSession {
  safeForRestart?: boolean;
  detaching?: Promise<void>;
  nextRun?: { agentId: string; epoch: number; runId?: string; conversationId?: string; claim?: Promise<boolean> };
  localRevision?: number;
  dto: BrowserSessionDto;
  driver?: BrowserDriver;
  /** Retained until driver shutdown succeeds so a timed-out Project deletion
   * can retry without losing the browser authority handle. */
  closingDriver?: BrowserDriver;
  /** Registered synchronously by the factory when a browser process spawns,
   * before CDP readiness can succeed or fail. A Set preserves every late or
   * duplicate publication until whole-process shutdown is observed. */
  spawnHandles: Set<BrowserTerminationHandle>;
  cleanupError?: string;
  cleanup?: Promise<void>;
  /** Authority-specific cleanup started by a distinct callback after the
   * factory has already produced a healthy ready driver. */
  lateCleanups: Set<Promise<void>>;
  stagedUploadDirs: Map<string, { pageId: string; uploadId: string }>;
  queue: Promise<unknown>;
  lifecycleEpoch: number;
  opening?: Promise<BrowserSessionDto>;
  spawnPublication?: SpawnPublication;
  /** A URL is replayable only when it contains no credential-bearing query. */
  replayUrl?: string;
  lastFrame?: { body: Buffer; revision: number; capturedAt: number; metadata: BrowserFrameMetadata };
  frameCapture?: Promise<{ body: Buffer; revision: number; metadata: BrowserFrameMetadata }>;
  framePageId?: string;
  agentActivity?: BrowserActivityDto;
  launchAbort: AbortController;
  launchLease?: BrowserLaunchLease;
  /** True only while an acquired launch lease can still produce process
   * authority that has not yet been returned or synchronously sealed. */
  launchFactoryPending: boolean;
}

interface SpawnPublication {
  promise: Promise<void>;
  readonly sealed: boolean;
  readonly coversReturnedDriver: boolean;
  finish(coversReturnedDriver?: boolean): void;
}

function spawnPublication(): SpawnPublication {
  let finishPromise!: () => void;
  let complete = false;
  let coversReturnedDriver = false;
  const promise = new Promise<void>((resolve) => { finishPromise = resolve; });
  return {
    promise,
    get sealed() { return complete; },
    get coversReturnedDriver() { return coversReturnedDriver; },
    finish(coversDriver = false) {
      if (complete) return;
      complete = true;
      coversReturnedDriver = coversDriver;
      finishPromise();
    },
  };
}

function publicDto(session: ManagedSession): BrowserSessionDto {
  return { ...session.dto };
}

function sameScope(dto: BrowserSessionDto, scope: BrowserScope): boolean {
  return dto.projectId === scope.projectId && dto.agentId === scope.agentId && dto.runId === scope.runId &&
    (dto.conversationId ?? "") === (scope.conversationId ?? "");
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly closingAuthorities = new WeakMap<object, Promise<void>>();

  constructor(
    private readonly dataDir: string,
    private readonly createDriver: BrowserDriverFactory,
    private readonly emit: (scope: BrowserScope, event: BrowserAuditEvent) => void | Promise<void>,
    private readonly resolveUploadArtifact?: BrowserUploadArtifactResolver,
    private readonly launchAuthority?: Pick<BrowserProfileAuthority, "description" | "acquire">,
    private readonly admissionAllowed: (scope: BrowserScope) => boolean = () => true,
    private readonly retainShared = false,
  ) {}

  private launchDescription(scope: BrowserScope): BrowserLaunchDescription {
    try {
      return this.launchAuthority?.description(scope) ?? { profileMode: "disposable" };
    } catch (error) {
      if (error instanceof BrowserProfileError) {
        throw new BrowserSessionError(error.message, error.statusCode);
      }
      throw error;
    }
  }

  private assertAdmission(scope: BrowserScope): void {
    if (!this.admissionAllowed(scope)) {
      throw new BrowserSessionError(
        "browser admission is unavailable while its Project or Agent is being deleted",
        409,
        "browser_owner_deleting",
      );
    }
  }

  private async acquireLaunch(
    scope: BrowserScope,
    session: ManagedSession,
    description: BrowserLaunchDescription,
  ): Promise<BrowserLaunchLease | undefined> {
    if (!this.launchAuthority) return undefined;
    const lease = await this.launchAuthority.acquire(
      session.dto.id,
      description,
      session.launchAbort.signal,
      (queuePosition, queueReason) => {
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening") return;
        session.dto = {
          ...session.dto,
          queuePosition,
          queueReason,
          updatedAt: new Date().toISOString(),
        };
      },
    );
    session.launchLease = lease;
    session.dto = {
      ...session.dto,
      profileMode: lease.profileMode,
      ...(lease.profileId ? { profileId: lease.profileId } : { profileId: undefined }),
      ...(lease.profileName ? { profileName: lease.profileName } : { profileName: undefined }),
      queuePosition: undefined,
      queueReason: undefined,
      updatedAt: new Date().toISOString(),
    };
    return lease;
  }

  get(agentId: string): BrowserSessionDto | undefined {
    const session = this.sessions.get(agentId);
    if (session) this.syncLocalState(session);
    return session ? publicDto(session) : undefined;
  }

  async promote(scope: BrowserScope, destination: BrowserScope, sessionId: string, expectedControlEpoch: number, persist: (profileId: string) => void): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    return this.serialized(session, async () => {
      this.assertAdmission(scope);
      if (this.ready(scope) !== session || session.dto.id !== sessionId) throw new BrowserSessionError("The browser changed before promotion.", 409);
      if (session.dto.controlOwner !== "operator" || session.dto.controlEpoch !== expectedControlEpoch) throw new BrowserSessionError("Take control of the current browser before saving it.", 409);
      if (session.dto.manualControl === "connecting") throw new BrowserSessionError("Finish or cancel the browser connection before saving it.", 409);
      if (session.dto.nextRunAgentId) throw new BrowserSessionError("Cancel pending agent access before saving this browser.", 409);
      if (session.dto.profileMode !== "trusted" || !session.dto.profileId || !session.dto.manualControl) throw new BrowserSessionError("This first saved-browser experiment requires a hosted browser opened with Remember sign-ins enabled. This browser has not been changed.", 409);
      if (this.sessions.has(destination.agentId)) throw new BrowserSessionError("A saved browser session already exists.", 409);
      persist(session.dto.profileId);
      this.sessions.delete(scope.agentId);
      session.dto = { ...session.dto, ...destination, controlEpoch: session.dto.controlEpoch + 1 };
      this.sessions.set(destination.agentId, session);
      this.lifecycle(session, "promoted_to_saved_browser");
      return publicDto(session);
    });
  }

  listActive(projectId: string, conversationId?: string): BrowserSessionDto[] {
    return [...this.sessions.values()]
      .map(publicDto)
      .filter((session) =>
        session.projectId === projectId
        && (conversationId === undefined || session.conversationId === conversationId)
        && (session.status === "opening" || session.status === "ready"),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  authorityStatus(allowRetained = false): { openings: number; active: number; pendingCleanup: number; retainedFailures: number } {
    const sessions = [...this.sessions.values()];
    return {
      openings: sessions.filter((session) => Boolean(session.opening)).length,
      active: sessions.filter((session) => Boolean(session.driver) && !(allowRetained && session.driver?.suspend && session.safeForRestart)).length,
      pendingCleanup: sessions.filter((session) => Boolean(
        session.closingDriver || session.cleanup || session.lateCleanups.size || session.cleanupError ||
        ((session.dto.status === "closed" || session.dto.status === "failed") &&
          (session.spawnHandles.size || (session.launchLease && session.launchFactoryPending))),
      )).length,
      retainedFailures: sessions.filter((session) => Boolean(session.cleanupError)).length,
    };
  }

  authorityBlockers(kind: "run_browser" | "project_browser", allowRetained = false): Array<{
    kind: "run_browser" | "project_browser";
    reason: string;
    projectId: string;
    agentId: string;
    runId: string;
    sessionId: string;
    status: string;
  }> {
    return [...this.sessions.values()].flatMap((session) => {
      const reasons = [
        session.opening ? "launch opening" : undefined,
        session.driver && !(allowRetained && session.driver.suspend && session.safeForRestart) ? "live browser authority" : undefined,
        session.closingDriver || session.cleanup || session.lateCleanups.size ? "cleanup pending" : undefined,
        session.cleanupError ? `cleanup failed: ${session.cleanupError}` : undefined,
        (session.dto.status === "closed" || session.dto.status === "failed") &&
          (session.spawnHandles.size || (session.launchLease && session.launchFactoryPending))
          ? "published launch authority pending cleanup"
          : undefined,
      ].filter((reason): reason is string => Boolean(reason));
      if (reasons.length === 0) return [];
      return [{
        kind,
        reason: reasons.join("; "),
        projectId: session.dto.projectId,
        agentId: session.dto.agentId,
        runId: session.dto.runId,
        sessionId: session.dto.id,
        status: session.dto.status,
      }];
    });
  }

  private owned(scope: BrowserScope): ManagedSession {
    const session = this.sessions.get(scope.agentId);
    if (!session || !sameScope(session.dto, scope)) {
      throw new BrowserSessionError("browser session does not belong to this project, agent, conversation, and run", 404);
    }
    return session;
  }

  private syncLocalState(session: ManagedSession): void {
    if (session.dto.status === "ready" && session.driver?.suspend && !session.driver.isAlive()) {
      session.nextRun = undefined;
      session.dto = { ...session.dto, status: "failed", controlOwner: "operator", controlEpoch: session.dto.controlEpoch + 1, nextRunAgentId: undefined,
        failure: "The browser or its display is unavailable. This can happen if Chrome exits or the browser service cannot be reached. No replacement was opened. Reopening does not guarantee recovery of unsaved forms." };
      this.lifecycle(session, "browser_service_unavailable");
      return;
    }
    const revision = session.driver?.controlRevision?.();
    if (revision === undefined || session.dto.status !== "ready") return;
    const changed = session.localRevision !== undefined && session.localRevision !== revision;
    session.localRevision = revision;
    const manualControl = session.driver?.manualState?.();
    session.dto = { ...session.dto, localPaused: session.driver?.paused?.(), manualControl,
      controlOwner: manualControl && manualControl !== "automation" ? "operator" : session.dto.controlOwner,
      controlEpoch: session.dto.controlEpoch + (changed ? 1 : 0) };
    if (changed) {
      session.nextRun = undefined;
      session.dto = { ...session.dto, nextRunAgentId: undefined };
      session.lastFrame = undefined;
      session.agentActivity = undefined;
      this.lifecycle(session, session.dto.manualControl ? `hosted_${session.dto.manualControl}` : session.dto.localPaused ? "local_manual_pause" : "local_explicit_resume");
    }
  }

  private ready(scope: BrowserScope): ManagedSession & { driver: BrowserDriver } {
    const session = this.owned(scope);
    this.syncLocalState(session);
    if (session.dto.status !== "ready" || !session.driver) {
      throw new BrowserSessionError("browser session is not ready", 409);
    }
    return session as ManagedSession & { driver: BrowserDriver };
  }

  private lifecycle(session: ManagedSession, reason?: string): void {
    session.safeForRestart = false;
    if ((session.driver?.suspend || this.retainShared) && session.dto.location === "hosted" && (session.dto.status === "opening" || session.dto.status === "ready")) {
      const directory = path.join(this.dataDir, "retained-browser-sessions");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const filename = path.join(directory, `${session.dto.id}.json`);
      // Checkpoint identity, not page content, credentials, or outstanding grants.
      const { id, projectId, agentId, runId, profileId, profileMode, controlEpoch, openedAt, privateSignIn } = session.dto;
      writeFileSync(`${filename}.next`, JSON.stringify({ id, projectId, agentId, runId, profileId, profileMode, controlEpoch, openedAt, privateSignIn }), { mode: 0o600 });
      renameSync(`${filename}.next`, filename);
    }
    this.emit(session.dto, {
      type: "browser_session",
      sessionId: session.dto.id,
      executionId: session.dto.runId,
      status: session.dto.status,
      controlOwner: session.dto.controlOwner,
      controlEpoch: session.dto.controlEpoch,
      ...(session.dto.url ? { url: session.dto.url } : {}),
      ...(session.dto.title ? { title: session.dto.title } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  private async serialized<T>(session: ManagedSession, work: () => Promise<T>): Promise<T> {
    const result = session.queue.then(work, work);
    session.queue = result.catch(() => undefined);
    return result;
  }

  private authority(handle: BrowserTerminationHandle): object {
    return handle.terminationAuthority ?? handle;
  }

  private async closeHandle(handle: BrowserTerminationHandle | undefined): Promise<void> {
    if (!handle) return;
    const authority = this.authority(handle);
    const inProgress = this.closingAuthorities.get(authority);
    if (inProgress) return inProgress;
    const closing = handle.close().catch((error) => {
      this.closingAuthorities.delete(authority);
      throw error;
    });
    this.closingAuthorities.set(authority, closing);
    await closing;
  }

  private retainedHandles(session: ManagedSession): BrowserTerminationHandle[] {
    const byAuthority = new Map<object, BrowserTerminationHandle>();
    // Prefer a ready/closing driver over its spawn-time fallback handle so an
    // ordinary close performs the driver's complete protocol exactly once.
    for (const handle of [session.driver, session.closingDriver, ...session.spawnHandles]) {
      if (handle) byAuthority.set(this.authority(handle), byAuthority.get(this.authority(handle)) ?? handle);
    }
    return [...byAuthority.values()];
  }

  private hasAuthority(session: ManagedSession, authority: object): boolean {
    return this.retainedHandles(session).some((handle) => this.authority(handle) === authority);
  }

  private discardSpawnAuthority(session: ManagedSession, authority: object): void {
    for (const published of session.spawnHandles) {
      if (this.authority(published) === authority) session.spawnHandles.delete(published);
    }
  }

  /** A factory callback after readiness cannot expand the ready driver's
   * process authority. Contain only the newly published distinct authority so
   * the canonical ready session remains usable and truthful. */
  private closeLateSpawnAuthority(session: ManagedSession, handle: BrowserTerminationHandle): void {
    const authority = this.authority(handle);
    const cleanup = this.closeHandle(handle).then(
      () => this.discardSpawnAuthority(session, authority),
      (error: unknown) => {
        session.cleanupError = error instanceof Error ? error.message : String(error);
        this.lifecycle(session, `late browser authority cleanup did not complete: ${session.cleanupError}`);
        throw error;
      },
    );
    session.lateCleanups.add(cleanup);
    void cleanup.finally(() => session.lateCleanups.delete(cleanup)).catch(() => undefined);
  }

  /** Close every process authority retained by a session, clearing only handles
   * whose whole-process shutdown was observed. Failed handles remain attached
   * to the session so later cleanup and readiness checks cannot lose them. */
  private async performRetainedCleanup(session: ManagedSession): Promise<void> {
    while (true) {
      // A full lifecycle close joins any authority-specific late cleanup first.
      // If it failed, closeHandle released its coalescing entry and this pass
      // retries that exact retained authority alongside the session driver.
      const lateCleanups = [...session.lateCleanups];
      if (lateCleanups.length) await Promise.allSettled(lateCleanups);
      const handles = this.retainedHandles(session);
      if (!handles.length) {
        const uploadDirs = [...session.stagedUploadDirs.keys()];
        const uploadResults = await Promise.allSettled(
          uploadDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })),
        );
        const uploadFailures = uploadResults.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        uploadResults.forEach((result, index) => {
          if (result.status === "fulfilled") session.stagedUploadDirs.delete(uploadDirs[index]!);
        });
        if (uploadFailures.length) {
          session.cleanupError = uploadFailures
            .map((error) => error instanceof Error ? error.message : String(error))
            .join("; ");
          throw new AggregateError(uploadFailures, "browser upload cleanup did not complete");
        }
        const publication = session.spawnPublication;
        if (session.launchLease && session.launchFactoryPending &&
            !(publication?.sealed && publication.coversReturnedDriver)) {
          // Cancellation may arrive before a delayed factory publishes a
          // process. Retain the exclusive trusted-profile lease until that
          // factory settles, or until a final published authority proves it
          // covers every process the factory can still return.
          return;
        }
        session.cleanupError = undefined;
        session.launchLease?.release();
        session.launchLease = undefined;
        return;
      }
      const results = await Promise.allSettled(handles.map((handle) => this.closeHandle(handle)));
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      results.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        const handle = handles[index]!;
        const authority = this.authority(handle);
        if (session.driver && this.authority(session.driver) === authority) session.driver = undefined;
        if (session.closingDriver && this.authority(session.closingDriver) === authority) session.closingDriver = undefined;
        this.discardSpawnAuthority(session, authority);
      });
      if (failures.length) {
        session.cleanupError = failures.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
        throw new AggregateError(failures, `browser cleanup did not complete: ${session.cleanupError}`);
      }
      // A spawn callback can publish another handle while an earlier close is
      // in flight. Loop until one pass observes the retained set empty.
    }
  }

  private closeRetainedHandles(session: ManagedSession): Promise<void> {
    if (session.cleanup) return session.cleanup;
    const cleanup = this.performRetainedCleanup(session);
    session.cleanup = cleanup;
    cleanup.then(
      () => { if (session.cleanup === cleanup) session.cleanup = undefined; },
      () => { if (session.cleanup === cleanup) session.cleanup = undefined; },
    );
    return cleanup;
  }

  private registerSpawnHandle(
    scope: BrowserScope,
    session: ManagedSession,
    lifecycleEpoch: number,
    publication: SpawnPublication,
    handle: BrowserTerminationHandle,
    options: BrowserSpawnPublicationOptions = {},
  ): void {
    const wasSealed = publication.sealed;
    if (options.complete) publication.finish(options.coversReturnedDriver);
    const authority = this.authority(handle);
    // Duplicate callbacks and spawn/driver handles sharing one explicit
    // termination authority never create another close obligation.
    if (this.hasAuthority(session, authority)) return;
    session.spawnHandles.add(handle);
    if (this.sessions.get(scope.agentId) === session &&
        (wasSealed || session.dto.status === "ready" ||
          (session.dto.status === "opening" && session.lifecycleEpoch !== lifecycleEpoch))) {
      this.closeLateSpawnAuthority(session, handle);
      return;
    }
    if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening" ||
        session.lifecycleEpoch !== lifecycleEpoch) {
      // Cleanup has already fenced this opening. Start closing immediately;
      // close() observes the same coalesced authority attempt.
      void this.closeRetainedHandles(session).catch(() => undefined);
    }
  }

  private assertLifecycle(
    scope: BrowserScope,
    session: ManagedSession,
    driver: BrowserDriver,
    lifecycleEpoch: number,
  ): void {
    if (this.sessions.get(scope.agentId) !== session || session.driver !== driver ||
        session.dto.status !== "ready" || session.lifecycleEpoch !== lifecycleEpoch) {
      throw new BrowserSessionError("browser session changed while the action was running", 409);
    }
  }

  private pageAction<T>(
    scope: BrowserScope,
    session: ManagedSession & { driver: BrowserDriver },
    owner: BrowserControlOwner | undefined,
    expectedControlEpoch: number | undefined,
    work: (driver: BrowserDriver) => Promise<T>,
  ): Promise<T>;
  private pageAction<T, U>(
    scope: BrowserScope,
    session: ManagedSession & { driver: BrowserDriver },
    owner: BrowserControlOwner | undefined,
    expectedControlEpoch: number | undefined,
    work: (driver: BrowserDriver) => Promise<T>,
    commit: (result: T) => U,
  ): Promise<U>;
  private async pageAction<T, U>(
    scope: BrowserScope,
    session: ManagedSession & { driver: BrowserDriver },
    owner: BrowserControlOwner | undefined,
    expectedControlEpoch: number | undefined,
    work: (driver: BrowserDriver) => Promise<T>,
    commit?: (result: T) => U,
  ): Promise<T | U> {
    const driver = session.driver;
    this.syncLocalState(session);
    const driverRevision = driver.controlRevision?.();
    const lifecycleEpoch = session.lifecycleEpoch;
    const controlEpoch = expectedControlEpoch ?? session.dto.controlEpoch;
    return this.serialized(session, async (): Promise<T | U> => {
      this.syncLocalState(session);
      if (driver.controlRevision?.() !== driverRevision || (owner && driver.paused?.())) throw new BrowserSessionError("Local browser control paused or changed. This action was discarded.", 409);
      this.assertLifecycle(scope, session, driver, lifecycleEpoch);
      if (owner) this.assertControl(session, owner, controlEpoch);
      const result = await work(driver);
      this.syncLocalState(session);
      if (driver.controlRevision?.() !== driverRevision) throw new BrowserSessionError("Local browser control changed. This result was discarded.", 409);
      this.assertLifecycle(scope, session, driver, lifecycleEpoch);
      if (owner) this.assertControl(session, owner, controlEpoch);
      return commit ? commit(result) : result;
    });
  }

  open(scope: BrowserScope, url?: string, initialOwner: BrowserControlOwner = "agent", localFactory?: BrowserDriverFactory, nativeManual = false): Promise<BrowserSessionDto> {
    this.assertAdmission(scope);
    if (nativeManual && (localFactory || initialOwner !== "operator")) throw new BrowserSessionError("Manual hosted sessions must be opened by the operator.", 409);
    const initialUrl = nativeManual && url ? validateBrowserUrl(url) : undefined;
    const existing = this.sessions.get(scope.agentId);
    if (existing?.dto.status === "ready") {
      if (!sameScope(existing.dto, scope)) {
        return Promise.reject(new BrowserSessionError("another run owns this agent's browser session", 409));
      }
      return url ? this.navigate(scope, url, initialOwner) : Promise.resolve(publicDto(existing));
    }
    if (existing?.opening) {
      if (!sameScope(existing.dto, scope)) {
        return Promise.reject(new BrowserSessionError("another run owns this agent's browser session", 409));
      }
      return existing.opening;
    }
    const now = new Date().toISOString();
    const launchDescription = localFactory ? { profileMode: "disposable" as const } : this.launchDescription(scope);
    const session: ManagedSession = {
      dto: {
        id: randomUUID(),
        ...scope,
        status: "opening",
        location: localFactory ? "local" : "hosted",
        ...launchDescription,
        controlOwner: initialOwner,
        controlEpoch: 1,
        capabilities: localFactory ? { multiPage: true, fileUpload: true, hostedHeaded: false, persistentProfiles: false } : browserRuntimeCapabilities(),
        pages: [],
        pageRevision: 0,
        frameRevision: 0,
        openedAt: now,
        updatedAt: now,
      },
      spawnHandles: new Set(),
      lateCleanups: new Set(),
      stagedUploadDirs: new Map(),
      queue: Promise.resolve(),
      lifecycleEpoch: 1,
      launchAbort: new AbortController(),
      launchFactoryPending: false,
    };
    const publication = spawnPublication();
    session.spawnPublication = publication;
    const replacementEpoch = existing ? ++existing.lifecycleEpoch : undefined;
    let installed = false;
    let opening!: Promise<BrowserSessionDto>;
    opening = (async () => {
      let createdDriver: BrowserDriver | undefined;
      try {
        if (existing) {
          await existing.queue.catch(() => undefined);
          await this.closeRetainedHandles(existing);
          if (this.sessions.get(scope.agentId) !== existing || existing.lifecycleEpoch !== replacementEpoch) {
            throw new BrowserSessionError("browser session changed while replacement cleanup was running", 409);
          }
        }
        await recoverBrowserResidue(this.dataDir);
        // No await may separate this deletion fence from installing the session.
        // A deletion beginning afterward will observe the installed opening in
        // its identity-based browser scan and abort it.
        this.assertAdmission(scope);
        this.sessions.set(scope.agentId, session);
        installed = true;
        this.lifecycle(session, "open_requested");
        const launch = localFactory ? undefined : await this.acquireLaunch(scope, session, launchDescription);
        this.assertAdmission(scope);
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening") {
          launch?.release();
          session.launchLease = undefined;
          throw new BrowserSessionError("browser session closed while it was waiting to open", 409);
        }
        session.launchFactoryPending = true;
        try {
          createdDriver = await (localFactory ?? this.createDriver)(session.dto.id, (level, text) => {
            if (this.sessions.get(session.dto.agentId) !== session || session.dto.status !== "ready") return;
            this.emit(session.dto, {
              type: "browser_console",
              sessionId: session.dto.id,
              executionId: scope.runId,
              level,
              text: redactBrowserText(text).slice(0, MAX_CONSOLE_TEXT),
            });
          }, (handle, options) => this.registerSpawnHandle(session.dto, session, 1, publication, handle, options),
          (event) => this.commitPageEvent(session.dto, session, 1, event), {
            ...(nativeManual ? { ...launch?.driver, nativeManual: true, initialUrl } : launch?.driver),
            signal: session.launchAbort.signal,
          });
        } finally {
          session.launchFactoryPending = false;
        }
        publication.finish();
        this.assertAdmission(scope);
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was opening", 409);
        }
        session.driver = createdDriver;
        session.dto.capabilities = { ...session.dto.capabilities, retainedAcrossAppRestart: Boolean(createdDriver.suspend), nativeDisplay: Boolean(createdDriver.resizeDesktop) };
        if (url && !nativeManual) await createdDriver.navigate(validateBrowserUrl(url));
        if (this.sessions.get(scope.agentId) !== session || session.driver !== createdDriver || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was opening", 409);
        }
        const pages = await createdDriver.pages();
        this.assertAdmission(scope);
        if (this.sessions.get(scope.agentId) !== session || session.driver !== createdDriver || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was opening", 409);
        }
        session.dto = { ...session.dto, status: "ready", localPaused: createdDriver.paused?.(), manualControl: createdDriver.manualState?.() };
        session.localRevision = createdDriver.controlRevision?.();
        this.updatePages(session, pages);
        this.lifecycle(session, "opened");
        return publicDto(session);
      } catch (error) {
        publication.finish();
        if (!installed) throw error;
        if (createdDriver) session.closingDriver = createdDriver;
        let cleanupError: unknown;
        try {
          await this.closeRetainedHandles(session);
        } catch (closeError) {
          cleanupError = closeError;
        }
        if (session.driver === createdDriver) session.driver = undefined;
        const failure = redactBrowserText(error instanceof Error ? error.message : String(error));
        if (this.sessions.get(scope.agentId) === session && session.dto.status === "opening") {
          session.dto = { ...session.dto, status: "failed", failure, updatedAt: new Date().toISOString() };
          this.lifecycle(session, failure);
        }
        if (cleanupError) {
          throw new AggregateError([error, cleanupError], "browser readiness and cleanup failed");
        }
        if (error instanceof BrowserSessionError) throw error;
        throw new BrowserSessionError(failure, 503);
      } finally {
        if (session.opening === opening) session.opening = undefined;
        if (session.spawnPublication === publication) session.spawnPublication = undefined;
        if (existing?.opening === opening) existing.opening = undefined;
      }
    })();
    session.opening = opening;
    if (existing) existing.opening = opening;
    return opening;
  }

  async reconnect(scope: BrowserScope): Promise<BrowserSessionDto> {
    if (this.owned(scope).dto.manualControl) throw new BrowserSessionError("Use Resume automation to keep this manual browser and its open tabs. Close it explicitly before starting a replacement.", 409);
    this.assertAdmission(scope);
    const session = this.owned(scope);
    if (session.dto.location === "local") throw new BrowserSessionError("Disconnect and reconnect the tab from the local browser extension.", 409);
    if (session.dto.status === "opening" && session.opening) return session.opening;
    const previousUrl = session.replayUrl;
    const previousDriver = session.driver;
    session.driver = undefined;
    if (previousDriver) session.closingDriver = previousDriver;
    session.lifecycleEpoch += 1;
    const reconnectEpoch = session.lifecycleEpoch;
    const publication = spawnPublication();
    session.launchAbort = new AbortController();
    session.spawnPublication = publication;
    session.dto = {
      ...session.dto,
      status: "opening",
      failure: undefined,
      // Reconnection replaces process authority, not interaction authority.
      // Preserve the explicit operator/Agent owner across the restart.
      controlEpoch: session.dto.controlEpoch + 1,
      updatedAt: new Date().toISOString(),
    };
    session.lastFrame = undefined;
    session.frameCapture = undefined;
    this.lifecycle(session, "reconnect_requested");
    let reconnecting!: Promise<BrowserSessionDto>;
    reconnecting = (async () => {
      let createdDriver: BrowserDriver | undefined;
      try {
        // The epoch/status fence rejects completion from the old driver before
        // we wait for its queued command and replace the process.
        await session.queue.catch(() => undefined);
        await this.closeRetainedHandles(session);
        this.assertAdmission(scope);
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was reconnecting", 409);
        }
        const launchDescription: BrowserLaunchDescription = {
          profileMode: session.dto.profileMode,
          ...(session.dto.profileId ? { profileId: session.dto.profileId } : {}),
          ...(session.dto.profileName ? { profileName: session.dto.profileName } : {}),
        };
        const launch = await this.acquireLaunch(scope, session, launchDescription);
        this.assertAdmission(scope);
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening") {
          launch?.release();
          session.launchLease = undefined;
          throw new BrowserSessionError("browser session closed while it was waiting to reconnect", 409);
        }
        session.launchFactoryPending = true;
        try {
          createdDriver = await this.createDriver(session.dto.id, (level, text) => {
            if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "ready") return;
            this.emit(scope, {
              type: "browser_console", sessionId: session.dto.id, executionId: scope.runId,
              level, text: redactBrowserText(text).slice(0, MAX_CONSOLE_TEXT),
            });
          }, (handle, options) => this.registerSpawnHandle(scope, session, reconnectEpoch, publication, handle, options),
          (event) => this.commitPageEvent(scope, session, reconnectEpoch, event), {
            ...launch?.driver,
            signal: session.launchAbort.signal,
          });
        } finally {
          session.launchFactoryPending = false;
        }
        publication.finish();
        this.assertAdmission(scope);
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was reconnecting", 409);
        }
        session.driver = createdDriver;
        if (previousUrl && previousUrl !== "about:blank") await createdDriver.navigate(validateBrowserUrl(previousUrl));
        const pages = await createdDriver.pages();
        this.assertAdmission(scope);
        if (this.sessions.get(scope.agentId) !== session || session.driver !== createdDriver || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was reconnecting", 409);
        }
        session.dto = { ...session.dto, status: "ready" };
        this.updatePages(session, pages);
        this.lifecycle(session, "reconnected");
        return publicDto(session);
      } catch (error) {
        publication.finish();
        if (createdDriver) session.closingDriver = createdDriver;
        let cleanupError: unknown;
        try {
          await this.closeRetainedHandles(session);
        } catch (closeError) {
          cleanupError = closeError;
        }
        if (session.driver === createdDriver) session.driver = undefined;
        const failure = redactBrowserText(error instanceof Error ? error.message : String(error));
        if (this.sessions.get(scope.agentId) === session && session.dto.status === "opening") {
          session.dto = { ...session.dto, status: "failed", failure, updatedAt: new Date().toISOString() };
          this.lifecycle(session, failure);
        }
        if (cleanupError) {
          throw new AggregateError([error, cleanupError], "browser readiness and cleanup failed");
        }
        if (error instanceof BrowserSessionError) throw error;
        throw new BrowserSessionError(failure, 503);
      } finally {
        if (session.opening === reconnecting) session.opening = undefined;
        if (session.spawnPublication === publication) session.spawnPublication = undefined;
      }
    })();
    session.opening = reconnecting;
    return reconnecting;
  }

  private async clearRetainedUploads(
    session: ManagedSession,
    driver: BrowserDriver | undefined,
    pageId?: string,
    uploadId?: string,
  ): Promise<void> {
    const uploadDirs = [...session.stagedUploadDirs.entries()]
      .filter(([, assignment]) =>
        (pageId === undefined || assignment.pageId === pageId)
        && (uploadId === undefined || assignment.uploadId === uploadId),
      )
      .map(([directory]) => directory);
    if (!uploadDirs.length) return;
    if (driver) await driver.clearUploadedFiles(pageId, uploadId);
    const results = await Promise.allSettled(
      uploadDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    results.forEach((result, index) => {
      if (result.status === "fulfilled") session.stagedUploadDirs.delete(uploadDirs[index]!);
    });
    if (failures.length) throw new AggregateError(failures, "browser upload cleanup did not complete");
  }

  authorizeNextRun(scope: BrowserScope, agentId: string | undefined, expectedEpoch: number): BrowserSessionDto {
    const session = this.ready(scope);
    this.assertControl(session, "operator", expectedEpoch);
    session.dto = { ...session.dto, nextRunAgentId: agentId, controlEpoch: session.dto.controlEpoch + 1 };
    session.nextRun = agentId ? { agentId, epoch: session.dto.controlEpoch } : undefined;
    this.lifecycle(session, agentId ? "next_run_authorized" : "next_run_revoked");
    return publicDto(session);
  }

  bindNextRun(scope: BrowserScope, agentId: string, runId: string, conversationId?: string): void {
    const session = this.sessions.get(scope.agentId), grant = session?.nextRun;
    if (!session || !sameScope(session.dto, scope) || !grant || grant.agentId !== agentId) return;
    if (grant.runId && grant.runId !== runId) { this.expireNextRun(scope, agentId); return; }
    grant.runId = runId; grant.conversationId = conversationId;
  }

  expireNextRun(scope: BrowserScope, agentId: string, runId?: string): void {
    const session = this.sessions.get(scope.agentId), grant = session?.nextRun;
    if (!session || !grant || grant.agentId !== agentId || (runId && grant.runId !== runId)) return;
    session.nextRun = undefined; session.dto = { ...session.dto, nextRunAgentId: undefined };
  }

  async claimNextRun(scope: BrowserScope, agentId: string, runId: string, conversationId?: string): Promise<boolean> {
    const session = this.sessions.get(scope.agentId), grant = session?.nextRun;
    if (!session || !sameScope(session.dto, scope) || !grant || grant.agentId !== agentId || grant.runId !== runId || grant.conversationId !== conversationId) return false;
    if (grant.claim) return grant.claim;
    grant.claim = (async () => {
      try { await this.setControl(scope, "agent", grant.epoch); return true; }
      finally { if (session.nextRun === grant) { session.nextRun = undefined; session.dto = { ...session.dto, nextRunAgentId: undefined }; } }
    })();
    return grant.claim;
  }

  /** Internal transport capability: never serialize this path into a DTO. */
  manualDesktopSocket(scope: BrowserScope, sessionId: string, expectedEpoch: number): string {
    const session = this.ready(scope);
    if (session.dto.id !== sessionId || session.dto.controlEpoch !== expectedEpoch || !session.driver.manualSocket) throw new BrowserSessionError("Manual browser access changed. Reconnect the view.", 409);
    if (session.dto.capabilities.nativeDisplay) return session.driver.manualSocket(session.dto.controlOwner !== "operator");
    if (session.dto.controlOwner !== "operator") throw new BrowserSessionError("Take control before using the manual browser.", 409);
    const state = session.driver.manualState?.();
    if (state !== "manual" && state !== "connecting") throw new BrowserSessionError("Manual browser access is not active.", 409);
    return session.driver.manualSocket();
  }

  async resizeDesktop(scope: BrowserScope, sessionId: string, expectedEpoch: number, size: BrowserViewportSize): Promise<void> {
    const session = this.ready(scope);
    if (session.dto.id !== sessionId || session.dto.controlEpoch !== expectedEpoch || session.dto.controlOwner !== "operator" || !session.driver.resizeDesktop) throw new BrowserSessionError("Browser display control changed.", 409);
    // Native display geometry is permitted while automation is disconnected.
    // Keep queue/lifecycle fencing, but do not apply the automation-only guard.
    await this.pageAction(scope, session, undefined, expectedEpoch, async driver => {
      if (session.dto.controlEpoch !== expectedEpoch || session.dto.controlOwner !== "operator") throw new BrowserSessionError("Browser display control changed.", 409);
      await driver.resizeDesktop!(size);
      if (session.dto.controlEpoch !== expectedEpoch || session.dto.controlOwner !== "operator") throw new BrowserSessionError("Browser display control changed.", 409);
    });
  }

  async pauseHostedAutomation(scope: BrowserScope, expectedEpoch: number): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    if (session.dto.controlEpoch !== expectedEpoch || !session.driver.pauseAutomation) throw new BrowserSessionError("Browser control changed or native manual control is unavailable.", 409);
    const driver = session.driver, lifecycleEpoch = session.lifecycleEpoch;
    // Disconnect immediately, ahead of the action queue: pending input must not
    // complete after the user starts entering credentials in the native view.
    session.dto.privateSignIn = true;
    this.lifecycle(session, "hosted_private_sign_in");
    await driver.pauseAutomation!();
    this.assertLifecycle(scope, session, driver, lifecycleEpoch);
    this.syncLocalState(session);
    session.dto = { ...session.dto, controlOwner: "operator", pendingFileChooser: undefined };
    session.lastFrame = undefined;
    session.agentActivity = undefined;
    this.lifecycle(session, "hosted_manual_takeover");
    return publicDto(session);
  }

  async resumeHostedAutomation(scope: BrowserScope, expectedEpoch: number, automatic = false): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    if (automatic && session.dto.privateSignIn) throw new BrowserSessionError("Private sign-in is active. Choose Done signing in to return to browsing.", 409);
    if (session.dto.controlEpoch !== expectedEpoch || session.dto.controlOwner !== "operator" || session.driver.manualState?.() !== "manual" || !session.driver.resumeAutomation) throw new BrowserSessionError("Browser control changed or this browser is not awaiting an explicit resume.", 409);
    const driver = session.driver, lifecycleEpoch = session.lifecycleEpoch;
    const resuming = driver.resumeAutomation!();
    this.syncLocalState(session);
    try {
      await resuming;
      this.assertLifecycle(scope, session, driver, lifecycleEpoch);
      this.syncLocalState(session);
      const pages = await driver.pages();
      this.assertLifecycle(scope, session, driver, lifecycleEpoch);
      if (driver.manualState?.() !== "automation") throw new BrowserSessionError("Browser resume was cancelled.", 409);
      session.dto.privateSignIn = false;
      this.updatePages(session, pages);
      this.lifecycle(session, "hosted_explicit_resume");
      return publicDto(session);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      if (detail.includes("Enable remote debugging")) throw new BrowserSessionError(detail, 409, "chrome_connection_setup_required");
      if (detail.includes("timed out")) throw new BrowserSessionError(detail, 504, "chrome_connection_timeout");
      if (detail.includes("declined")) throw new BrowserSessionError(detail, 409, "chrome_connection_declined");
      if (detail.includes("automation endpoint is unavailable")) throw new BrowserSessionError(detail, 409, "chrome_endpoint_unavailable");
      if (detail.includes("Browser service did not respond")) throw new BrowserSessionError("The browser service did not respond. The saved browser was not replaced; retry after checking its status.", 504, "browser_service_timeout");
      throw new BrowserSessionError("Chrome could not connect for agent use. The browser and its tabs were not replaced; check Chrome and retry.", 409, "chrome_connection_failed");
    } finally { this.syncLocalState(session); }
  }

  async setControl(scope: BrowserScope, owner: BrowserControlOwner, expectedEpoch?: number): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    if (owner === "agent" && session.driver.manualState?.() && session.driver.manualState() !== "automation") throw new BrowserSessionError("Resume automation explicitly before giving an agent control.", 409);
    if (expectedEpoch !== undefined && expectedEpoch !== session.dto.controlEpoch) {
      throw new BrowserSessionError("browser control changed in another tab; refresh before interacting", 409);
    }
    return this.pageAction(scope, session, undefined, undefined, async () => {
      if (expectedEpoch !== undefined && expectedEpoch !== session.dto.controlEpoch) {
        throw new BrowserSessionError("browser control changed in another tab; refresh before interacting", 409);
      }
      if (session.dto.controlOwner !== owner) {
        session.agentActivity = undefined;
        session.lastFrame = undefined;
        // A control handoff is not navigation or teardown. Keep attached files
        // and their staging alive so taking over cannot destroy an open draft.
        await session.driver!.cancelPendingFileChooser("control_changed");
        session.dto = {
          ...session.dto, controlOwner: owner, controlEpoch: session.dto.controlEpoch + 1,
          pendingFileChooser: undefined,
          updatedAt: new Date().toISOString(),
        };
        this.emit(scope, {
          type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
          actor: owner, action: "control", summary: `${owner} took browser control`, url: session.dto.url,
        });
        this.lifecycle(session, "control_changed");
      }
      return publicDto(session);
    });
  }

  /** Fence queued Agent input synchronously when permission is revoked.
   * Disconnect native automation as well, so an already-started browser
   * command cannot continue into the operator's private session. */
  async revokeAgentControl(scope: BrowserScope): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    if (session.dto.controlOwner !== "agent") return publicDto(session);
    session.dto = {
      ...session.dto,
      controlOwner: "operator",
      controlEpoch: session.dto.controlEpoch + 1,
      nextRunAgentId: undefined,
      pendingFileChooser: undefined,
      updatedAt: new Date().toISOString(),
    };
    session.nextRun = undefined;
    session.lastFrame = undefined;
    session.agentActivity = undefined;
    this.lifecycle(session, "control_revoked");
    if (session.driver?.pauseAutomation) await session.driver.pauseAutomation();
    await session.driver?.cancelPendingFileChooser("control_changed");
    this.syncLocalState(session);
    return publicDto(session);
  }

  private assertControl(session: ManagedSession, owner: BrowserControlOwner, expectedEpoch?: number): void {
    if (session.driver?.manualState?.() && session.driver.manualState() !== "automation") throw new BrowserSessionError("This browser is under native manual control. Resume automation explicitly before interacting.", 409);
    if (session.dto.controlOwner !== owner) {
      throw new BrowserSessionError(`browser input is controlled by the ${session.dto.controlOwner}`, 409);
    }
    if (expectedEpoch !== undefined && expectedEpoch !== session.dto.controlEpoch) {
      throw new BrowserSessionError("browser control changed in another tab; refresh before interacting", 409);
    }
  }

  private updatePages(session: ManagedSession, info: BrowserPagesInfo): void {
    const pages = info.pages.map((page) => {
      const safe = redactPageInfo(page);
      return {
        id: page.pageId,
        loading: page.loading ?? false,
        ...(safe.title ? { title: safe.title } : {}),
        ...(safe.url ? { url: safe.url } : {}),
        ...(page.openerPageId ? { openerPageId: page.openerPageId } : {}),
        active: page.active,
        isNew: page.isNew,
        closable: page.closable,
      };
    });
    const active = pages.find((page) => page.id === info.activePageId);
    const pendingFileChooser = info.pendingFileChooser ? {
      pageId: info.pendingFileChooser.pageId,
      mode: info.pendingFileChooser.mode === "selectMultiple" ? "selectMultiple" as const : "selectSingle" as const,
      requestedAt: new Date(info.pendingFileChooser.createdAt).toISOString(),
      expiresAt: new Date(info.pendingFileChooser.expiresAt).toISOString(),
      controlOwner: session.dto.controlOwner,
      controlEpoch: session.dto.controlEpoch,
    } : undefined;
    const unchanged = session.dto.activePageId === info.activePageId
      && JSON.stringify(session.dto.pages) === JSON.stringify(pages)
      && JSON.stringify(session.dto.pendingFileChooser) === JSON.stringify(pendingFileChooser);
    const activeSafe = info.pages.find((page) => page.pageId === info.activePageId);
    session.replayUrl = activeSafe ? redactPageInfo(activeSafe).replayUrl : undefined;
    session.dto = {
      ...session.dto,
      ...(info.activePageId ? { activePageId: info.activePageId } : { activePageId: undefined }),
      pages,
      pendingFileChooser,
      pageRevision: unchanged ? session.dto.pageRevision : session.dto.pageRevision + 1,
      ...(active?.url ? { url: active.url } : { url: undefined }),
      ...(active?.title ? { title: active.title } : { title: undefined }),
      frameRevision: unchanged ? session.dto.frameRevision : session.dto.frameRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    if (!unchanged) session.lastFrame = undefined;
  }

  private commitPageEvent(
    scope: BrowserScope,
    session: ManagedSession,
    lifecycleEpoch: number,
    event: BrowserPageEvent,
  ): void {
    const queued = session.queue.then(async () => {
      if (this.sessions.get(scope.agentId) !== session || session.lifecycleEpoch !== lifecycleEpoch || session.dto.status === "closed") return;
      if ((event.type === "page_close" || event.type === "page_navigate") && event.pageId) {
        await this.clearRetainedUploads(session, undefined, event.pageId);
      } else if (event.type === "file_chooser_clear" && event.reason !== "selected") {
        await this.clearRetainedUploads(session, session.driver, event.pageId);
      }
      this.updatePages(session, event.pages);
      const action = event.type === "page_open" ? "page_open"
        : event.type === "page_activate" ? "page_activate"
          : event.type === "page_close" ? "page_close"
            : event.type === "page_limit" ? "page_limit"
              : event.type === "file_chooser_clear" && event.reason !== "selected" ? "upload_cancel"
                : undefined;
      const pageSuffix = event.pageId ? " " + event.pageId : "";
      const reasonSuffix = event.reason ? " (" + redactBrowserText(event.reason) + ")" : "";
      if (action) {
        await this.emit(scope, {
          type: "browser_action",
          sessionId: session.dto.id,
          executionId: scope.runId,
          actor: session.dto.controlOwner,
          action,
          summary: action + pageSuffix + reasonSuffix,
          url: session.dto.url,
        });
      }
    });
    session.queue = queued.catch(() => undefined);
  }

  private updateInfo(session: ManagedSession, info: BrowserPageInfo): void {
    if (session.dto.status !== "ready" || !session.driver) {
      throw new BrowserSessionError("browser session closed while the action was running", 409);
    }
    const safe = redactPageInfo(info);
    session.replayUrl = safe.replayUrl;
    session.dto = {
      ...session.dto, url: safe.url, title: safe.title, frameRevision: session.dto.frameRevision + 1,
      pages: session.dto.pages.map(page => page.id === session.dto.activePageId ? { ...page, url: safe.url, title: safe.title } : page),
      updatedAt: new Date().toISOString(),
    };
    session.lastFrame = undefined;
  }

  async refreshLocalPages(scope: BrowserScope): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    if (!session.driver.isAlive()) return this.close(scope, "local_window_disconnected");
    try {
      return await this.pageAction(scope, session, undefined, undefined, driver => driver.pages(), pages => {
        session.dto = { ...session.dto, localPaused: session.driver.paused?.() };
        this.updatePages(session, pages);
        return publicDto(session);
      });
    } catch (error) {
      if (!session.driver?.isAlive()) return this.close(scope, "local_window_disconnected");
      if (session.driver.paused?.()) { session.dto = { ...session.dto, localPaused: true }; return publicDto(session); }
      throw error;
    }
  }

  async activatePage(
    scope: BrowserScope,
    pageId: string,
    owner: BrowserControlOwner,
    expectedControlEpoch?: number,
  ): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    this.assertControl(session, owner, expectedControlEpoch);
    return this.pageAction(scope, session, owner, expectedControlEpoch, async (driver) => {
      try {
        return await driver.activatePage(pageId);
      } catch (error) {
        if (error instanceof BrowserDriverActionError && error.reason === "page_not_found") {
          throw new BrowserSessionError("browser page not found", 404);
        }
        throw error;
      }
    }, (pages) => {
      this.updatePages(session, pages);
      return publicDto(session);
    });
  }

  async closePage(
    scope: BrowserScope,
    pageId: string,
    owner: BrowserControlOwner,
    expectedControlEpoch?: number,
  ): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    this.assertControl(session, owner, expectedControlEpoch);
    return this.pageAction(scope, session, owner, expectedControlEpoch, async (driver) => {
      try {
        await this.clearRetainedUploads(session, driver, pageId);
        return await driver.closePage(pageId);
      } catch (error) {
        if (error instanceof BrowserDriverActionError && error.reason === "page_not_found") {
          throw new BrowserSessionError("browser page not found", 404);
        }
        if (error instanceof BrowserDriverActionError && error.reason === "last_page") {
          throw new BrowserSessionError("the last browser page cannot be closed", 409);
        }
        throw error;
      }
    }, (pages) => {
      this.updatePages(session, pages);
      return publicDto(session);
    });
  }

  async upload(
    scope: BrowserScope,
    artifactId: string,
    selector: string | undefined,
    owner: BrowserControlOwner,
    expectedControlEpoch?: number,
  ): Promise<BrowserUploadResponseDto> {
    const session = this.ready(scope);
    this.assertControl(session, owner, expectedControlEpoch);
    if (!this.resolveUploadArtifact) {
      throw new BrowserSessionError("Browser file upload is unavailable.", 503, "upload_not_retained");
    }
    const resolved = await this.resolveUploadArtifact(scope, owner, artifactId);
    if (!resolved) {
      throw new BrowserSessionError("Managed artifact was not found or is not authorized.", 404, "artifact_not_found");
    }
    const artifact = resolved.artifact;
    if (!artifact.size || !artifact.sha256 || !artifact.mediaType) {
      await resolved.content.close();
      throw new BrowserSessionError("Managed artifact metadata is incomplete.", 409, "artifact_content_changed");
    }
    if (artifact.size > MAX_UPLOAD_BYTES) {
      await resolved.content.close();
      throw new BrowserSessionError("This artifact exceeds the 10 MiB browser upload limit.", 413, "upload_too_large");
    }
    try {
      validateUploadArtifactName(artifact);
    } catch (error) {
      await resolved.content.close().catch(() => undefined);
      throw error;
    }

    let body: Buffer;
    try {
      body = await resolved.content.readRange(MAX_UPLOAD_BYTES + 1);
      validateUploadArtifact(artifact, body);
    } catch (error) {
      await resolved.content.close().catch(() => undefined);
      throw error;
    }
    const uploadId = randomUUID();
    const uploadRoot = path.join(this.dataDir, session.driver.suspend ? "retained-browser-uploads" : "browser-sessions", session.dto.id, "uploads");
    const uploadDir = path.join(uploadRoot, uploadId);
    const safeName = uploadDisplayName(artifact);
    const temporaryPath = path.join(uploadDir, "." + randomUUID() + ".part");
    const stagedPath = path.join(uploadDir, safeName);
    let retained = false;
    let ambiguousAssignment = false;
    try {
      await fs.mkdir(uploadRoot, { recursive: true, mode: 0o700 });
      await fs.mkdir(uploadDir, { recursive: false, mode: 0o700 });
      const output = await fs.open(temporaryPath, "wx", 0o600);
      try {
        await output.writeFile(body);
        await output.sync();
      } finally {
        await output.close();
      }
      await fs.rename(temporaryPath, stagedPath);
      await fs.chmod(stagedPath, 0o400);
      const installed = await fs.readFile(stagedPath);
      if (installed.length !== artifact.size ||
          createHash("sha256").update(installed).digest("hex") !== artifact.sha256) {
        throw new BrowserSessionError("The staged upload could not be retained safely.", 409, "upload_not_retained");
      }

      let result: { uploaded: BrowserUploadResult; pages: BrowserPagesInfo };
      try {
        result = await this.pageAction(
          scope,
          session,
          owner,
          expectedControlEpoch,
          async (driver) => {
            const uploaded = await driver.upload({
              uploadId,
              stagedPath,
              expectedName: safeName,
              expectedSize: artifact.size!,
              expectedMediaType: artifact.mediaType!,
              selector,
            });
            const pages = await driver.pages();
            if (pages.activePageId !== uploaded.pageId) {
              throw new BrowserSessionError(
                "The active browser page changed while the file was being attached.",
                409,
                "browser_page_changed",
              );
            }
            return { uploaded, pages };
          },
        );
      } catch (error) {
        ambiguousAssignment =
          (error instanceof BrowserDriverActionError && error.reason === "upload_verification_failed") ||
          (error instanceof BrowserSessionError && error.code === "browser_page_changed");
        throw error;
      }
      if (result.uploaded.input.count !== 1 || result.uploaded.input.name !== safeName ||
          result.uploaded.input.size !== artifact.size) {
        ambiguousAssignment = true;
        throw new BrowserSessionError("The browser could not verify the attached file.", 409, "upload_not_retained");
      }
      session.stagedUploadDirs.set(uploadDir, { pageId: result.uploaded.pageId, uploadId });
      retained = true;
      this.updatePages(session, result.pages);
      this.updateInfo(session, result.uploaded);
      const attachedAt = new Date().toISOString();
      await this.emit(scope, {
        type: "browser_action",
        sessionId: session.dto.id,
        executionId: scope.runId,
        actor: owner,
        action: "upload",
        summary: [
          "attached managed artifact",
          artifact.id,
          safeName,
          String(artifact.size),
          artifact.mediaType,
          artifact.sha256,
          selector ? "selector" : "chooser",
        ].join(" · "),
        url: session.dto.url,
      });
      return {
        session: publicDto(session),
        upload: {
          artifactId: artifact.id,
          displayName: safeName,
          mediaType: artifact.mediaType,
          size: artifact.size,
          sha256: artifact.sha256,
          attachedAt,
        },
      };
    } catch (error) {
      if (ambiguousAssignment) {
        const assignedPageId = session.dto.activePageId ?? "*";
        session.stagedUploadDirs.set(uploadDir, { pageId: assignedPageId, uploadId });
        retained = true;
        try {
          await this.clearRetainedUploads(
            session,
            session.driver,
            undefined,
            uploadId,
          );
          retained = session.stagedUploadDirs.has(uploadDir);
        } catch {
          // Keep the durable staging directory registered when the browser or
          // filesystem cannot prove cleanup. Session teardown and restart
          // recovery will retry it without exposing it as a successful upload.
        }
      }
      if (error instanceof BrowserDriverActionError) {
        const status = error.reason === "upload_disabled" ? 503
          : error.reason === "selector_not_found" ? 404
            : 409;
        throw new BrowserSessionError(
          error.reason.replaceAll("_", " "),
          status,
          error.reason,
        );
      }
      throw error;
    } finally {
      await resolved.content.close().catch(() => undefined);
      if (!retained) await fs.rm(uploadDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async cancelFileChooser(
    scope: BrowserScope,
    owner: BrowserControlOwner,
    expectedControlEpoch?: number,
  ): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    this.assertControl(session, owner, expectedControlEpoch);
    return this.pageAction(scope, session, owner, expectedControlEpoch, async (driver) => {
      await this.clearRetainedUploads(session, driver, session.dto.activePageId);
      await driver.cancelPendingFileChooser("explicit");
      return driver.pages();
    }, (pages) => {
      this.updatePages(session, pages);
      return publicDto(session);
    });
  }

  async navigate(scope: BrowserScope, url: string, owner: BrowserControlOwner): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    this.assertControl(session, owner);
    const target = validateBrowserUrl(url);
    return this.pageAction(scope, session, owner, undefined, async (driver) => {
      session.agentActivity = undefined;
      await this.clearRetainedUploads(session, driver, session.dto.activePageId);
      return driver.navigate(target);
    }, (info) => {
      this.updateInfo(session, info);
      this.emit(scope, {
        type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
        actor: owner, action: "navigate", summary: `navigated to ${session.dto.url}`, url: session.dto.url,
      });
      this.lifecycle(session, "navigated");
      return publicDto(session);
    });
  }

  async openLink(scope: BrowserScope, url: string): Promise<BrowserSessionDto> {
    const target = validateBrowserUrl(url);
    const session = this.ready(scope), epoch = session.dto.controlEpoch;
    return this.serialized(session, async () => {
      if (this.ready(scope) !== session || session.dto.controlOwner !== "operator" || session.dto.controlEpoch !== epoch || session.dto.manualControl === "connecting") throw new BrowserSessionError("Take control before opening a link. Existing tabs were preserved.", 409);
      if (session.driver.openLink) await session.driver.openLink(target);
      else {
        if (!session.driver.newPage) throw new BrowserSessionError("This browser cannot open a new tab. Existing tabs were preserved.", 409);
        await session.driver.newPage(); await session.driver.navigate(target);
      }
      this.updatePages(session, await session.driver.pages());
      this.lifecycle(session, "link_opened_in_new_tab");
      return publicDto(session);
    });
  }

  async inspect(scope: BrowserScope, selector?: string): Promise<string> {
    const session = this.ready(scope);
    this.assertControl(session, "agent");
    return this.pageAction(scope, session, "agent", undefined, async (driver) => ({
      snapshot: await driver.inspect(selector),
      info: await driver.pageInfo(),
    }), ({ snapshot, info }) => {
      this.updateInfo(session, info);
      this.emit(scope, {
        type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
        actor: "agent", action: "inspect", summary: `inspected ${session.dto.url}`, url: session.dto.url,
      });
      return { snapshot: boundBrowserSnapshot(snapshot, MAX_SNAPSHOT_TEXT), info };
    }).then(({ snapshot }) => snapshot);
  }

  async act(scope: BrowserScope, input: {
    action?: unknown;
    page_id?: unknown;
    x?: unknown;
    y?: unknown;
    delta_x?: unknown;
    delta_y?: unknown;
    selector?: unknown;
    text?: unknown;
    key?: unknown;
    consequence?: unknown;
    attempt_id?: unknown;
  }): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    this.assertControl(session, "agent");
    const action = input.action;
    const consequence = ["submission", "purchase", "message", "account_change", "other"].includes(String(input.consequence ?? ""))
      ? input.consequence as "submission" | "purchase" | "message" | "account_change" | "other"
      : undefined;
    const attemptId = typeof input.attempt_id === "string" && input.attempt_id.length > 0 && input.attempt_id.length <= 120
      ? input.attempt_id
      : undefined;
    if ((input.consequence !== undefined && !consequence) || (input.attempt_id !== undefined && !attemptId) || Boolean(consequence) !== Boolean(attemptId)) {
      throw new BrowserSessionError("consequential browser actions require both a valid consequence and attempt_id");
    }
    let work: (driver: BrowserDriver) => Promise<BrowserPageInfo>;
    let summary: string;
    if (action === "click" && typeof input.selector === "string" && input.selector.length > 0 && input.selector.length <= MAX_SELECTOR_TEXT) {
      work = (driver) => driver.click(input.selector as string);
      summary = `clicked ${input.selector}`;
    } else if (action === "fill" && typeof input.selector === "string" && input.selector.length > 0 && input.selector.length <= MAX_SELECTOR_TEXT && typeof input.text === "string") {
      work = (driver) => driver.fill(input.selector as string, input.text as string);
      summary = `filled ${input.selector}`;
    } else if (action === "key" && typeof input.key === "string" && input.key.length > 0 && input.key.length <= 40) {
      work = (driver) => driver.key(input.key as string);
      summary = `pressed ${input.key}`;
    } else if (action === "pointer" || action === "scroll") {
      if (typeof input.page_id !== "string" || input.page_id !== session.dto.activePageId) throw new BrowserSessionError("Inspect the active page again before coordinate actions.", 409);
      if (action === "scroll" && input.delta_x === undefined && input.delta_y === undefined) throw new BrowserSessionError("scroll requires delta_x or delta_y");
      const pageId = input.page_id;
      const x = action === "pointer" ? input.x : input.delta_x === undefined ? 0 : input.delta_x;
      const y = action === "pointer" ? input.y : input.delta_y === undefined ? 0 : input.delta_y;
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) throw new BrowserSessionError("Finite coordinates are required.");
      const size = session.driver.viewport?.() ?? VIEWPORT;
      if (action === "pointer" ? x < 0 || y < 0 || x > size.width || y > size.height : Math.abs(x) > 4000 || Math.abs(y) > 4000) throw new BrowserSessionError("Coordinates are outside the supported range.");
      work = async driver => {
        if ((await driver.pages()).activePageId !== pageId) throw new BrowserSessionError("The active tab changed; coordinate action discarded.", 409);
        return action === "pointer" ? driver.pointer(x, y) : driver.scroll(x, y);
      };
      summary = action === "pointer" ? `clicked viewport at ${x},${y}` : `scrolled viewport by ${x},${y}`;
    } else {
      throw new BrowserSessionError("browser action requires click, fill, key, pointer, or scroll");
    }
    const contextualWork = async (driver: BrowserDriver): Promise<BrowserPageInfo> => {
      try {
        return await work(driver);
      } catch (error) {
        if (!(error instanceof BrowserDriverActionError)) throw error;
        const selector = typeof input.selector === "string" ? input.selector : "";
        const detail = error.reason === "invalid_selector" ? "is not valid CSS"
          : error.reason === "selector_not_found" ? "matched no element"
            : error.reason === "selector_ambiguous" ? "matched multiple elements; inspect and use a unique selector"
              : error.reason === "selector_not_interactable" ? "is covered or not currently interactable; inspect before retrying"
                : error.reason === "click_unconfirmed" ? "could not be confirmed and may have taken effect; inspect before any retry"
                  : error.reason === "fill_unconfirmed" ? "could not be confirmed and may have partially changed the field; inspect before retrying"
                    : "is not editable";
        const status = error.reason === "selector_not_found" ? 404
          : error.reason === "invalid_selector" ? 400 : 409;
        throw new BrowserSessionError(`browser ${String(action)} selector ${JSON.stringify(selector)} ${detail}`, status, error.reason);
      }
    };
    return this.pageAction(scope, session, "agent", undefined, contextualWork, (info) => {
      session.agentActivity = session.driver?.activity?.();
      this.updateInfo(session, info);
      this.emit(scope, {
        type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
        actor: "agent", action: action === "fill" ? "type" : action === "pointer" ? "click" : action, summary, url: session.dto.url,
        ...(consequence ? { consequence, attemptId } : {}),
      });
      return publicDto(session);
    });
  }

  async operatorInput(scope: BrowserScope, input: BrowserOperatorInputRequest): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    this.assertControl(session, "operator", input.expectedControlEpoch);
    let work: (driver: BrowserDriver) => Promise<BrowserPageInfo>;
    let summary: string;
    if (input.kind === "click") {
      const size = session.driver?.viewport?.() ?? VIEWPORT;
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x > size.width || input.y > size.height) {
        throw new BrowserSessionError("browser click coordinates are outside the viewport");
      }
      work = (driver) => driver.pointer(input.x, input.y);
      summary = `clicked viewport at ${Math.round(input.x)},${Math.round(input.y)}`;
    } else if (input.kind === "type") {
      if (!input.text) throw new BrowserSessionError("browser type text must not be empty");
      work = (driver) => driver.type(input.text);
      summary = "typed into the focused page control";
    } else if (input.kind === "key") {
      if (!input.key || input.key.length > 40) throw new BrowserSessionError("browser key is invalid");
      work = (driver) => driver.key(input.key);
      summary = `pressed ${input.key}`;
    } else {
      if (![input.deltaX, input.deltaY].every(Number.isFinite) || Math.abs(input.deltaX) > 4_000 || Math.abs(input.deltaY) > 4_000) {
        throw new BrowserSessionError("browser scroll delta is invalid");
      }
      work = (driver) => driver.scroll(input.deltaX, input.deltaY);
      summary = `scrolled viewport by ${Math.round(input.deltaX)},${Math.round(input.deltaY)}`;
    }
    const guardedWork = async (driver: BrowserDriver) => {
      const pages = await driver.pages();
      const size = driver.viewport?.() ?? VIEWPORT;
      if ((input.expectedPageId && input.expectedPageId !== pages.activePageId) ||
          (input.expectedViewport && (input.expectedViewport.width !== size.width || input.expectedViewport.height !== size.height))) {
        throw new BrowserSessionError("The browser tab or size changed. Check the page before continuing.", 409);
      }
      session.agentActivity = undefined;
      return work(driver);
    };
    return this.pageAction(scope, session, "operator", input.expectedControlEpoch, guardedWork, (info) => {
      this.updateInfo(session, info);
      this.emit(scope, {
        type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
        actor: "operator", action: input.kind, summary, url: session.dto.url,
      });
      return publicDto(session);
    });
  }

  async newPage(scope: BrowserScope, expectedControlEpoch: number, owner: BrowserControlOwner = "operator"): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    return this.pageAction(scope, session, owner, expectedControlEpoch, async driver => {
      if (!driver.newPage) throw new BrowserSessionError("New tabs are unavailable.");
      return driver.newPage();
    }, pages => { this.updatePages(session, pages); return publicDto(session); });
  }

  async resizeViewport(scope: BrowserScope, pageId: string, size: BrowserViewportSize, expectedControlEpoch: number): Promise<void> {
    if (![size?.width, size?.height].every(Number.isSafeInteger) || size.width < 320 || size.width > 2560 || size.height < 200 || size.height > 1600) throw new BrowserSessionError("Invalid browser viewport size.");
    const session = this.ready(scope);
    // Resizing can reflow targets: only the current operator may change geometry.
    await this.pageAction(scope, session, "operator", expectedControlEpoch, async driver => {
      if (!driver.resizeViewport) throw new BrowserSessionError("Browser resizing is unavailable.");
      await driver.resizeViewport(pageId, size);
      session.lastFrame = undefined;
      session.agentActivity = undefined;
    });
  }

  async captureFrame(scope: BrowserScope, requestedPageId?: string): Promise<{ body: Buffer; revision: number; metadata: BrowserFrameMetadata }> {
    const session = this.ready(scope);
    const pageId = requestedPageId ?? session.dto.activePageId ?? "";
    if (session.lastFrame?.metadata.pageId === pageId && Date.now() - session.lastFrame.capturedAt < 250) {
      return session.lastFrame;
    }
    if (session.frameCapture) {
      if (session.framePageId === pageId) return session.frameCapture;
      await session.frameCapture;
      return this.captureFrame(scope, requestedPageId);
    }
    session.framePageId = pageId;
    session.frameCapture = this.pageAction(scope, session, undefined, undefined, async driver => {
      const body = await driver.capture(pageId || undefined);
      const activity = session.agentActivity;
      return { body, metadata: { pageId, viewport: driver.viewport?.(pageId) ?? VIEWPORT,
        ...(session.dto.controlOwner === "agent" && activity?.pageId === pageId && Date.now() - activity.at < 2_500 ? { activity } : {}) } };
    }, ({ body, metadata }) => {
      if (!body.length || body.length > MAX_FRAME_BYTES) throw new BrowserSessionError("browser frame exceeds the 16 MiB limit", 503);
      session.dto = { ...session.dto, frameRevision: session.dto.frameRevision + 1, updatedAt: new Date().toISOString() };
      session.lastFrame = { body, revision: session.dto.frameRevision, capturedAt: Date.now(), metadata };
      return { body, revision: session.dto.frameRevision, metadata };
    }).finally(() => { session.frameCapture = undefined; });
    return session.frameCapture;
  }

  async captureArtifact(scope: BrowserScope): Promise<{
    artifactId: string;
    artifactRef: string;
    path: string;
    width: number;
    height: number;
  }> {
    const session = this.ready(scope);
    this.assertControl(session, "agent");
    const { body, size } = await this.pageAction(scope, session, "agent", undefined, async (driver) => ({ captured: await driver.capture(), size: driver.viewport?.() ?? VIEWPORT }), ({ captured, size }) => {
      if (!captured.length || captured.length > MAX_FRAME_BYTES) throw new BrowserSessionError("browser screenshot exceeds the 16 MiB limit", 503);
      session.dto = { ...session.dto, frameRevision: session.dto.frameRevision + 1, updatedAt: new Date().toISOString() };
      // Captures use device pixels while pointer coordinates stay CSS pixels.
      const imageSize = captured.length >= 24 && captured.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? { width: captured.readUInt32BE(16), height: captured.readUInt32BE(20) } : size;
      return { body: captured, size: imageSize };
    });
    const artifactId = randomUUID();
    const relative = path.posix.join("browser", `${artifactId}.png`);
    const published = await publishManagedArtifactContentAsync(
      this.dataDir,
      scope.projectId,
      artifactId,
      body,
    );
    await this.emit(scope, {
      type: "browser_screenshot", sessionId: session.dto.id, executionId: scope.actorRunId ?? scope.runId,
      artifactId, path: relative, width: size.width, height: size.height,
      size: published.size, sha256: published.sha256,
    });
    return {
      artifactId,
      artifactRef: `ponderosa://artifact/${artifactId}`,
      path: relative,
      ...size,
    };
  }

  async close(scope: BrowserScope, reason = "explicit_close"): Promise<BrowserSessionDto> {
    const session = this.owned(scope);
    if (session.dto.status === "closed" && !session.closingDriver && !session.spawnHandles.size &&
        !session.opening && !session.cleanup) return publicDto(session);
    const opening = session.opening;
    const publication = session.spawnPublication;
    const driver = session.driver ?? session.closingDriver;
    session.launchAbort.abort();
    session.driver = undefined;
    session.closingDriver = driver;
    session.lifecycleEpoch += 1;
    session.replayUrl = undefined;
    session.lastFrame = undefined;
    session.frameCapture = undefined;
    session.dto = {
      ...session.dto, status: "closed", controlEpoch: session.dto.controlEpoch + 1,
      updatedAt: new Date().toISOString(),
    };
    this.lifecycle(session, reason);

    // A spawn-time handle is actionable even while readiness is stalled. Close
    // it before awaiting the factory so deletion/shutdown cannot be held hostage
    // by an initialization Promise whose process is already known.
    try {
      await this.closeRetainedHandles(session);
      if (opening) {
        // A factory may never settle after publishing its process handles. The
        // final synchronous publication explicitly seals the authority set, so
        // cleanup need not guess from the timing of the first callback.
        const openingSettled = opening.then(() => undefined, () => undefined);
        await Promise.race([
          openingSettled,
          ...(publication ? [publication.promise.then(() =>
            publication.coversReturnedDriver ? undefined : openingSettled)] : []),
        ]);
        await this.closeRetainedHandles(session);
      }
      rmSync(path.join(this.dataDir, "retained-browser-sessions", `${session.dto.id}.json`), { force: true });
      await fs.rm(path.join(this.dataDir, "retained-browser-uploads", session.dto.id), { recursive: true, force: true });
      return publicDto(session);
    } finally {
      if (session.dto.status === "closed" && session.opening === opening) session.opening = undefined;
      if (session.spawnPublication === publication) session.spawnPublication = undefined;
    }
  }

  async closeRun(scope: BrowserScope, reason: string): Promise<void> {
    const session = this.sessions.get(scope.agentId);
    if (!session || !sameScope(session.dto, scope)) return;
    await this.close(scope, reason);
  }

  async closeAgent(agentId: string, reason: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) return;
    await this.close(session.dto, reason);
  }

  async closeAll(reason: string): Promise<void> {
    const retaining = reason === "server_shutdown" || reason === "deployment_drain";
    const results = await Promise.allSettled([...this.sessions.values()].map(async session => {
      if (session.detaching) return session.detaching;
      if (this.retainShared && retaining && session.driver?.suspend && session.dto.status === "ready" && !session.cleanupError) {
        const driver = session.driver;
        const operation = (async () => {
          if (reason === "server_shutdown") ++session.lifecycleEpoch;
          session.nextRun = undefined;
          session.dto = { ...session.dto, controlOwner: "operator", controlEpoch: session.dto.controlEpoch + 1, nextRunAgentId: undefined };
          await session.queue.catch(() => undefined);
          if (reason === "deployment_drain") {
            await driver.cancelPendingFileChooser("deployment_drain");
            this.lifecycle(session, "prepared_for_application_restart");
            session.safeForRestart = true;
          } else {
            this.lifecycle(session, "application_detached");
            await driver.suspend!();
            session.driver = undefined;
            session.spawnHandles.clear();
            session.launchLease?.release(); session.launchLease = undefined;
            session.dto = { ...session.dto, status: "closed" };
          }
        })();
        session.detaching = operation;
        try { await operation; } finally { session.detaching = undefined; }
        return;
      }
      await this.close(session.dto, reason);
      rmSync(path.join(this.dataDir, "retained-browser-sessions", `${session.dto.id}.json`), { force: true });
    }));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "browser cleanup did not complete");
  }

  async restoreRetained(ids: string[], factory: BrowserDriverFactory, resolveOwner: (dto: BrowserSessionDto) => BrowserScope = dto => dto): Promise<void> {
    for (const id of ids) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid retained browser identity.");
      const recorded = JSON.parse(await fs.readFile(path.join(this.dataDir, "retained-browser-sessions", `${id}.json`), "utf8")) as BrowserSessionDto;
      const dto = { ...recorded, ...resolveOwner(recorded) };
      if (dto.id !== id || dto.agentId !== `project-browser:${dto.projectId}` || dto.runId !== `project:${dto.projectId}` || this.sessions.has(dto.agentId)) throw new Error("Retained browser ownership could not be verified.");
      this.assertAdmission(dto);
      const session: ManagedSession = {
        dto: { ...dto, status: "ready", location: "hosted", controlOwner: "operator", controlEpoch: dto.controlEpoch + 1, nextRunAgentId: undefined, pages: [], pageRevision: 0, frameRevision: 0, capabilities: { ...browserRuntimeCapabilities(), retainedAcrossAppRestart: true }, updatedAt: new Date().toISOString() },
        spawnHandles: new Set(), lateCleanups: new Set(), stagedUploadDirs: new Map(), queue: Promise.resolve(), lifecycleEpoch: 1, launchAbort: new AbortController(), launchFactoryPending: false,
      };
      this.sessions.set(dto.agentId, session);
      try {
        await this.acquireLaunch(dto, session, { profileMode: dto.profileMode, profileId: dto.profileId });
        session.driver = await factory(id, () => {}, undefined, event => this.commitPageEvent(session.dto, session, 1, event));
        session.dto.manualControl = session.driver.manualState?.();
        session.dto.capabilities.nativeDisplay = Boolean(session.driver.resizeDesktop);
        session.localRevision = session.driver.controlRevision?.();
        this.updatePages(session, await session.driver.pages());
        this.lifecycle(session, "application_reattached");
      } catch (error) {
        session.launchLease?.release();
        this.sessions.delete(dto.agentId);
        throw error;
      }
    }
    const directory = path.join(this.dataDir, "retained-browser-sessions");
    const checkpoints = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const filename of checkpoints) {
      if (!/^[a-f0-9-]{36}\.json$/.test(filename) || ids.includes(filename.slice(0, -5))) continue;
      const recorded = JSON.parse(await fs.readFile(path.join(directory, filename), "utf8")) as BrowserSessionDto;
      let owner: BrowserScope;
      try { owner = resolveOwner(recorded); } catch { continue; }
      if (this.sessions.has(owner.agentId)) continue;
      this.sessions.set(owner.agentId, {
        dto: { ...recorded, ...owner, status: "failed", location: "hosted", controlOwner: "operator", controlEpoch: recorded.controlEpoch + 1, pages: [], pageRevision: 0, frameRevision: 0, capabilities: browserRuntimeCapabilities(), updatedAt: new Date().toISOString(), failure: "The browser service stopped. Live tabs and unsaved forms could not be retained. Open a new browser explicitly to continue; remembered sign-ins remain in its profile." },
        spawnHandles: new Set(), lateCleanups: new Set(), stagedUploadDirs: new Map(), queue: Promise.resolve(), lifecycleEpoch: 1, launchAbort: new AbortController(), launchFactoryPending: false,
      });
    }
  }

  async closeProject(projectId: string, reason: string): Promise<void> {
    for (let pass = 0; pass < 20; pass += 1) {
      const sessions = [...this.sessions.values()].filter((session) => session.dto.projectId === projectId);
      if (!sessions.length) return;
      const results = await Promise.allSettled(sessions.map((session) => this.close(session.dto, reason)));
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, `browser cleanup for Project ${projectId} did not complete`);
      const pending = [...this.sessions.values()].some((session) => session.dto.projectId === projectId &&
        Boolean(session.opening || session.driver || session.closingDriver || session.spawnHandles.size || session.cleanup));
      if (!pending) return;
    }
    throw new Error(`browser cleanup for Project ${projectId} did not reach a fixed point`);
  }
}
