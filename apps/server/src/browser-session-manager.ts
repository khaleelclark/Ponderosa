import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  AgentEvent,
  ArtifactDto,
  BrowserControlOwner,
  BrowserOperatorInputRequest,
  BrowserUploadReceiptDto,
  BrowserUploadResponseDto,
  BrowserSessionDto,
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

export {
  chromeBrowserDriverFactory,
  findBrowserExecutable,
  initialBrowserTargetRequest,
} from "./chrome-cdp-driver.js";
export type {
  BrowserDriver,
  BrowserDriverFactory,
  BrowserPageEvent,
  BrowserPageInfo,
  BrowserPagesInfo,
  BrowserUploadResult,
  BrowserSpawnPublicationOptions,
  BrowserTerminationHandle,
} from "./chrome-cdp-driver.js";
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
interface BrowserResidueRecoveryState {
  attempts: number;
  running: boolean;
  lastError?: string;
  timer?: NodeJS.Timeout;
  promise?: Promise<void>;
}
const browserResidueRecovery = new Map<string, BrowserResidueRecoveryState>();
interface BrowserResidueDrainState {
  attempts: number;
  running: boolean;
  lastError?: string;
  timer?: NodeJS.Timeout;
}
const browserResidueDrains = new Map<string, BrowserResidueDrainState>();

function recoveryDirectoryPattern(root: string): RegExp {
  const base = path.basename(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${base}\\.recovery-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "i");
}

function scheduleBrowserResidueDrain(quarantine: string): void {
  const existing = browserResidueDrains.get(quarantine);
  if (existing?.running || existing?.timer) return;
  const state = existing ?? { attempts: 0, running: false };
  state.running = true;
  state.attempts += 1;
  browserResidueDrains.set(quarantine, state);
  void fs.rm(quarantine, { recursive: true, force: true }).then(
    () => {
      if (state.timer) clearTimeout(state.timer);
      browserResidueDrains.delete(quarantine);
    },
    (error: unknown) => {
      state.running = false;
      state.lastError = error instanceof Error ? error.message : String(error);
      state.timer = setTimeout(() => {
        state.timer = undefined;
        scheduleBrowserResidueDrain(quarantine);
      }, 1_000);
      state.timer.unref?.();
    },
  );
}

export function browserResidueCleanupStatus(dataDir: string): { pending: number; failed: number } {
  const root = path.join(dataDir, "browser-sessions");
  const prefix = root + ".recovery-";
  const drains = [...browserResidueDrains.entries()].filter(([directory]) => directory.startsWith(prefix));
  const discovery = browserResidueRecovery.get(root);
  return {
    pending: drains.length + (discovery ? 1 : 0),
    failed: drains.filter(([, state]) => Boolean(state.lastError)).length + (discovery?.lastError ? 1 : 0),
  };
}

function recoverBrowserResidue(dataDir: string): Promise<void> {
  const root = path.join(dataDir, "browser-sessions");
  const existing = browserResidueRecovery.get(root);
  if (existing?.promise) return existing.promise;
  const state = existing ?? { attempts: 0, running: false };
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  state.running = true;
  state.attempts += 1;
  browserResidueRecovery.set(root, state);
  const recovery = (async () => {
    const parent = path.dirname(root);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const recoveryPattern = recoveryDirectoryPattern(root);
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && recoveryPattern.test(entry.name)) {
        scheduleBrowserResidueDrain(path.join(parent, entry.name));
      }
    }
    const quarantine = root + ".recovery-" + randomUUID();
    let quarantined = false;
    try {
      await fs.rename(root, quarantine);
      quarantined = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (quarantined) {
      // Draining stale profiles must never reject without an observer or block
      // a new browser authority from becoming available. Failed drains remain
      // visible to this authority and retry without poisoning future opens.
      scheduleBrowserResidueDrain(quarantine);
    }
  })();
  state.promise = recovery;
  return recovery.then(
    () => {
      if (browserResidueRecovery.get(root) !== state) return;
      if (state.timer) clearTimeout(state.timer);
      browserResidueRecovery.delete(root);
    },
    (error: unknown) => {
      if (browserResidueRecovery.get(root) === state) {
        state.running = false;
        state.promise = undefined;
        state.lastError = error instanceof Error ? error.message : String(error);
        state.timer = setTimeout(() => {
          state.timer = undefined;
          void recoverBrowserResidue(dataDir).catch(() => undefined);
        }, 1_000);
        state.timer.unref?.();
      }
      throw error;
    },
  );
}

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
  lastFrame?: { body: Buffer; revision: number; capturedAt: number };
  frameCapture?: Promise<{ body: Buffer; revision: number }>;
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
  ) {
    // Start residue discovery at authority creation so prior recovery
    // directories are visible and draining before the next browser opens.
    void recoverBrowserResidue(this.dataDir).catch(() => undefined);
  }

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

  private async acquireLaunch(
    scope: BrowserScope,
    session: ManagedSession,
    description: BrowserLaunchDescription,
  ): Promise<BrowserLaunchLease | undefined> {
    if (!this.launchAuthority) return undefined;
    const lease = await this.launchAuthority.acquire(
      scope,
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
    return session ? publicDto(session) : undefined;
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

  authorityStatus(): { openings: number; active: number; pendingCleanup: number; retainedFailures: number } {
    const sessions = [...this.sessions.values()];
    return {
      openings: sessions.filter((session) => Boolean(session.opening)).length,
      active: sessions.filter((session) => Boolean(session.driver)).length,
      pendingCleanup: sessions.filter((session) => Boolean(
        session.closingDriver || session.cleanup || session.lateCleanups.size || session.cleanupError ||
        ((session.dto.status === "closed" || session.dto.status === "failed") &&
          (session.spawnHandles.size || (session.launchLease && session.launchFactoryPending))),
      )).length,
      retainedFailures: sessions.filter((session) => Boolean(session.cleanupError)).length,
    };
  }

  private owned(scope: BrowserScope): ManagedSession {
    const session = this.sessions.get(scope.agentId);
    if (!session || !sameScope(session.dto, scope)) {
      throw new BrowserSessionError("browser session does not belong to this project, agent, conversation, and run", 404);
    }
    return session;
  }

  private ready(scope: BrowserScope): ManagedSession & { driver: BrowserDriver } {
    const session = this.owned(scope);
    if (session.dto.status !== "ready" || !session.driver) {
      throw new BrowserSessionError("browser session is not ready", 409);
    }
    return session as ManagedSession & { driver: BrowserDriver };
  }

  private lifecycle(session: ManagedSession, reason?: string): void {
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
    const lifecycleEpoch = session.lifecycleEpoch;
    const controlEpoch = expectedControlEpoch ?? session.dto.controlEpoch;
    return this.serialized(session, async (): Promise<T | U> => {
      this.assertLifecycle(scope, session, driver, lifecycleEpoch);
      if (owner) this.assertControl(session, owner, controlEpoch);
      const result = await work(driver);
      this.assertLifecycle(scope, session, driver, lifecycleEpoch);
      if (owner) this.assertControl(session, owner, controlEpoch);
      return commit ? commit(result) : result;
    });
  }

  open(scope: BrowserScope, url?: string, initialOwner: BrowserControlOwner = "agent"): Promise<BrowserSessionDto> {
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
    const launchDescription = this.launchDescription(scope);
    const session: ManagedSession = {
      dto: {
        id: randomUUID(),
        ...scope,
        status: "opening",
        ...launchDescription,
        controlOwner: initialOwner,
        controlEpoch: 1,
        capabilities: browserRuntimeCapabilities(),
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
        this.sessions.set(scope.agentId, session);
        installed = true;
        this.lifecycle(session, "open_requested");
        const launch = await this.acquireLaunch(scope, session, launchDescription);
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening") {
          launch?.release();
          session.launchLease = undefined;
          throw new BrowserSessionError("browser session closed while it was waiting to open", 409);
        }
        session.launchFactoryPending = true;
        try {
          createdDriver = await this.createDriver(session.dto.id, (level, text) => {
            if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "ready") return;
            this.emit(scope, {
              type: "browser_console",
              sessionId: session.dto.id,
              executionId: scope.runId,
              level,
              text: redactBrowserText(text).slice(0, MAX_CONSOLE_TEXT),
            });
          }, (handle, options) => this.registerSpawnHandle(scope, session, 1, publication, handle, options),
          (event) => this.commitPageEvent(scope, session, 1, event), launch?.driver);
        } finally {
          session.launchFactoryPending = false;
        }
        publication.finish();
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was opening", 409);
        }
        session.driver = createdDriver;
        if (url) await createdDriver.navigate(validateBrowserUrl(url));
        if (this.sessions.get(scope.agentId) !== session || session.driver !== createdDriver || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was opening", 409);
        }
        const pages = await createdDriver.pages();
        if (this.sessions.get(scope.agentId) !== session || session.driver !== createdDriver || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was opening", 409);
        }
        session.dto = { ...session.dto, status: "ready" };
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
    const session = this.owned(scope);
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
      controlOwner: "agent",
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
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was reconnecting", 409);
        }
        const launchDescription: BrowserLaunchDescription = {
          profileMode: session.dto.profileMode,
          ...(session.dto.profileId ? { profileId: session.dto.profileId } : {}),
          ...(session.dto.profileName ? { profileName: session.dto.profileName } : {}),
        };
        const launch = await this.acquireLaunch(scope, session, launchDescription);
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
          (event) => this.commitPageEvent(scope, session, reconnectEpoch, event), launch?.driver);
        } finally {
          session.launchFactoryPending = false;
        }
        publication.finish();
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was reconnecting", 409);
        }
        session.driver = createdDriver;
        if (previousUrl && previousUrl !== "about:blank") await createdDriver.navigate(validateBrowserUrl(previousUrl));
        const pages = await createdDriver.pages();
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

  async setControl(scope: BrowserScope, owner: BrowserControlOwner, expectedEpoch?: number): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    if (expectedEpoch !== undefined && expectedEpoch !== session.dto.controlEpoch) {
      throw new BrowserSessionError("browser control changed in another tab; refresh before interacting", 409);
    }
    return this.pageAction(scope, session, undefined, undefined, async () => {
      if (expectedEpoch !== undefined && expectedEpoch !== session.dto.controlEpoch) {
        throw new BrowserSessionError("browser control changed in another tab; refresh before interacting", 409);
      }
      if (session.dto.controlOwner !== owner) {
        await this.clearRetainedUploads(session, session.driver);
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

  private assertControl(session: ManagedSession, owner: BrowserControlOwner, expectedEpoch?: number): void {
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
      updatedAt: new Date().toISOString(),
    };
    session.lastFrame = undefined;
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
    const uploadRoot = path.join(this.dataDir, "browser-sessions", session.dto.id, "uploads");
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

  async inspect(scope: BrowserScope, selector?: string): Promise<string> {
    const session = this.ready(scope);
    return this.pageAction(scope, session, undefined, undefined, async (driver) => ({
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
    } else {
      throw new BrowserSessionError("browser action requires click(selector), fill(selector,text), or key(key)");
    }
    const contextualWork = async (driver: BrowserDriver): Promise<BrowserPageInfo> => {
      try {
        return await work(driver);
      } catch (error) {
        if (!(error instanceof BrowserDriverActionError)) throw error;
        const selector = typeof input.selector === "string" ? input.selector : "";
        const detail = error.reason === "invalid_selector"
          ? "is not valid CSS"
          : error.reason === "selector_not_found"
            ? "matched no element"
            : "is not editable";
        throw new BrowserSessionError(`browser ${String(action)} selector ${JSON.stringify(selector)} ${detail}`);
      }
    };
    return this.pageAction(scope, session, "agent", undefined, contextualWork, (info) => {
      this.updateInfo(session, info);
      this.emit(scope, {
        type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
        actor: "agent", action: action === "fill" ? "type" : action, summary, url: session.dto.url,
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
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x > VIEWPORT.width || input.y > VIEWPORT.height) {
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
    return this.pageAction(scope, session, "operator", input.expectedControlEpoch, work, (info) => {
      this.updateInfo(session, info);
      this.emit(scope, {
        type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
        actor: "operator", action: input.kind, summary, url: session.dto.url,
      });
      return publicDto(session);
    });
  }

  async captureFrame(scope: BrowserScope): Promise<{ body: Buffer; revision: number }> {
    const session = this.ready(scope);
    if (session.lastFrame && Date.now() - session.lastFrame.capturedAt < 250) {
      return { body: session.lastFrame.body, revision: session.lastFrame.revision };
    }
    if (session.frameCapture) return session.frameCapture;
    session.frameCapture = this.pageAction(scope, session, undefined, undefined, (driver) => driver.capture(), (body) => {
      if (!body.length || body.length > MAX_FRAME_BYTES) throw new BrowserSessionError("browser frame exceeds the 16 MiB limit", 503);
      session.dto = { ...session.dto, frameRevision: session.dto.frameRevision + 1, updatedAt: new Date().toISOString() };
      session.lastFrame = { body, revision: session.dto.frameRevision, capturedAt: Date.now() };
      return { body, revision: session.dto.frameRevision };
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
    const body = await this.pageAction(scope, session, "agent", undefined, (driver) => driver.capture(), (captured) => {
      if (!captured.length || captured.length > MAX_FRAME_BYTES) throw new BrowserSessionError("browser screenshot exceeds the 16 MiB limit", 503);
      session.dto = { ...session.dto, frameRevision: session.dto.frameRevision + 1, updatedAt: new Date().toISOString() };
      return captured;
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
      artifactId, path: relative, width: VIEWPORT.width, height: VIEWPORT.height,
      size: published.size, sha256: published.sha256,
    });
    return {
      artifactId,
      artifactRef: `ponderosa://artifact/${artifactId}`,
      path: relative,
      ...VIEWPORT,
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

  async closeAll(reason: string): Promise<void> {
    const results = await Promise.allSettled([...this.sessions.values()].map((session) => this.close(session.dto, reason)));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "browser cleanup did not complete");
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
