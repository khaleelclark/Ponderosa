import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type {
  AgentEvent,
  BrowserControlOwner,
  BrowserOperatorInputRequest,
  BrowserSessionDto,
} from "@ponderosa/core";
import { publishManagedArtifactContent } from "@ponderosa/agents";
import { terminateProcessGroup } from "@ponderosa/engines";

const VIEWPORT = { width: 1280, height: 720 } as const;
const MAX_CONSOLE_TEXT = 4_000;
const MAX_SNAPSHOT_TEXT = 16_000;
const MAX_NAVIGATION_URL = 2_048;
const MAX_SELECTOR_TEXT = 500;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_BROWSER_LAUNCH_ERROR = 4_000;

export interface BrowserScope {
  projectId: string;
  agentId: string;
  runId: string;
  conversationId?: string;
  /** Optional real Run receiving audit/artifact records for a borrowed browser. */
  actorAgentId?: string;
  actorRunId?: string;
}

export interface BrowserPageInfo {
  url: string;
  title: string;
}

export interface BrowserTerminationHandle {
  /** Opaque process-group authority shared by handles whose successful close
   * observes the same whole-process shutdown. Absent means this handle is its
   * own distinct authority. */
  readonly terminationAuthority?: object;
  close(): Promise<void>;
}

export interface BrowserDriver extends BrowserTerminationHandle {
  pageInfo(): Promise<BrowserPageInfo>;
  navigate(url: string): Promise<BrowserPageInfo>;
  inspect(): Promise<string>;
  click(selector: string): Promise<BrowserPageInfo>;
  fill(selector: string, text: string): Promise<BrowserPageInfo>;
  key(key: string): Promise<BrowserPageInfo>;
  pointer(x: number, y: number): Promise<BrowserPageInfo>;
  type(text: string): Promise<BrowserPageInfo>;
  scroll(deltaX: number, deltaY: number): Promise<BrowserPageInfo>;
  capture(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface BrowserSpawnPublicationOptions {
  /** This is the final process authority the factory can publish. */
  complete?: boolean;
  /** This handle explicitly covers the authority of the eventual driver. */
  coversReturnedDriver?: boolean;
}

export type BrowserDriverFactory = (
  sessionId: string,
  onConsole: (level: "log" | "info" | "warning" | "error", text: string) => void,
  /** Publish every spawned process authority synchronously. Set `complete` only
   * on the final publication; a settled factory is also implicitly complete. */
  onSpawned?: (handle: BrowserTerminationHandle, options?: BrowserSpawnPublicationOptions) => void,
) => Promise<BrowserDriver>;

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
  queue: Promise<unknown>;
  lifecycleEpoch: number;
  opening?: Promise<BrowserSessionDto>;
  spawnPublication?: SpawnPublication;
  /** A URL is replayable only when it contains no credential-bearing query. */
  replayUrl?: string;
  lastFrame?: { body: Buffer; revision: number; capturedAt: number };
  frameCapture?: Promise<{ body: Buffer; revision: number }>;
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

export class BrowserSessionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 503 = 400,
  ) {
    super(message);
  }
}

function publicDto(session: ManagedSession): BrowserSessionDto {
  return { ...session.dto };
}

export function validateBrowserUrl(value: string): string {
  if (!value || value.length > MAX_NAVIGATION_URL) {
    throw new BrowserSessionError("browser URL must contain 1 to 2048 characters");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserSessionError("browser URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserSessionError("browser navigation accepts only http(s) URLs");
  }
  if (parsed.username || parsed.password) {
    throw new BrowserSessionError("credentialed browser URLs are not allowed");
  }
  return parsed.toString();
}

const SENSITIVE_QUERY_NAME = /(?:^|[_-])(?:access|auth|authorization|bearer|code|credential|jwt|key|oauth|password|policy|refresh|secret|session|sig|signature|signed|sso|state|ticket|token)(?:$|[_-])/i;
const SENSITIVE_COMPACT_QUERY_NAMES = new Set([
  "accesstoken", "apikey", "authorizationcode", "awsaccesskeyid", "clientsecret",
  "idtoken", "keypairid", "oauthcode", "refreshtoken", "relaystate", "samlrequest",
  "samlresponse", "sessiontoken", "sharedaccesssignature",
]);

function isSensitiveQueryName(name: string): boolean {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_QUERY_NAME.test(name) || SENSITIVE_COMPACT_QUERY_NAMES.has(compact) ||
    compact.startsWith("xamz") || compact.startsWith("xgoog");
}

export interface RedactedBrowserUrl {
  url: string;
  /** Undefined when replay could repeat an OAuth callback, token, or signed URL. */
  replayUrl?: string;
}

/**
 * Browser URLs cross a canonical persistence and operator-display boundary.
 * Fragments never cross it. Known credential-bearing query values are visibly
 * redacted, and any URL containing one becomes non-replayable.
 */
export function redactBrowserUrl(value: string): RedactedBrowserUrl {
  if (value.length > MAX_NAVIGATION_URL) return { url: "redacted-browser-url" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { url: "invalid-browser-url" };
  }
  if (parsed.protocol === "about:" && parsed.pathname === "blank") return { url: "about:blank", replayUrl: "about:blank" };
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { url: `${parsed.protocol}redacted` };
  // The current page URL is untrusted: a redirect may introduce userinfo even
  // though direct navigation rejects it. Never display, persist, or replay it.
  let sensitive = Boolean(parsed.username || parsed.password);
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  for (const name of [...parsed.searchParams.keys()]) {
    if (!isSensitiveQueryName(name)) continue;
    sensitive = true;
    parsed.searchParams.set(name, "[REDACTED]");
  }
  return {
    url: parsed.toString(),
    ...(!sensitive ? { replayUrl: parsed.toString() } : {}),
  };
}

const SENSITIVE_TEXT_ASSIGNMENT = /(\b(?:access[_ -]?token|refresh[_ -]?token|id[_ -]?token|session[_ -]?token|authorization[_ -]?code|oauth[_ -]?code|client[_ -]?secret|api[_ -]?key|password|token)\b\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&#]+)/gi;
const BEARER_CREDENTIAL = /(\bbearer\s+)([a-z0-9._~+/=-]{8,})/gi;

function redactBrowserText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => redactBrowserUrl(candidate).url)
    .replace(BEARER_CREDENTIAL, "$1[REDACTED]")
    .replace(SENSITIVE_TEXT_ASSIGNMENT, (match, prefix: string, credential: string) =>
      /^(?:\[REDACTED\]|%5Bredacted%5D)$/i.test(credential) ? match : `${prefix}[REDACTED]`);
}

function redactPageInfo(info: BrowserPageInfo): BrowserPageInfo & { replayUrl?: string } {
  const redacted = redactBrowserUrl(info.url);
  return { url: redacted.url, title: redactBrowserText(info.title), ...(redacted.replayUrl ? { replayUrl: redacted.replayUrl } : {}) };
}

function redactSnapshot(snapshot: string): string {
  try {
    const redactValue = (value: unknown, key?: string): unknown => {
      if (typeof value === "string") {
        return key === "url" ? redactBrowserUrl(value).url : redactBrowserText(value);
      }
      if (Array.isArray(value)) return value.map((item) => redactValue(item));
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey)]));
      }
      return value;
    };
    return JSON.stringify(redactValue(JSON.parse(snapshot)), null, 2);
  } catch {
    return redactBrowserText(snapshot);
  }
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
    private readonly emit: (scope: BrowserScope, event: BrowserAuditEvent) => void,
  ) {}

  get(agentId: string): BrowserSessionDto | undefined {
    const session = this.sessions.get(agentId);
    return session ? publicDto(session) : undefined;
  }

  authorityStatus(): { openings: number; active: number; pendingCleanup: number; retainedFailures: number } {
    const sessions = [...this.sessions.values()];
    return {
      openings: sessions.filter((session) => Boolean(session.opening)).length,
      active: sessions.filter((session) => Boolean(session.driver)).length,
      pendingCleanup: sessions.filter((session) => Boolean(
        session.closingDriver || session.cleanup || session.lateCleanups.size || session.cleanupError ||
        ((session.dto.status === "closed" || session.dto.status === "failed") && session.spawnHandles.size),
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
        session.cleanupError = undefined;
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
    const session: ManagedSession = {
      dto: {
        id: randomUUID(),
        ...scope,
        status: "opening",
        controlOwner: initialOwner,
        controlEpoch: 1,
        frameRevision: 0,
        openedAt: now,
        updatedAt: now,
      },
      spawnHandles: new Set(),
      lateCleanups: new Set(),
      queue: Promise.resolve(),
      lifecycleEpoch: 1,
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
        this.sessions.set(scope.agentId, session);
        installed = true;
        this.lifecycle(session, "open_requested");
        createdDriver = await this.createDriver(session.dto.id, (level, text) => {
          if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "ready") return;
          this.emit(scope, {
            type: "browser_console",
            sessionId: session.dto.id,
            executionId: scope.runId,
            level,
            text: redactBrowserText(text).slice(0, MAX_CONSOLE_TEXT),
          });
        }, (handle, options) => this.registerSpawnHandle(scope, session, 1, publication, handle, options));
        publication.finish();
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was opening", 409);
        }
        session.driver = createdDriver;
        if (url) await createdDriver.navigate(validateBrowserUrl(url));
        if (this.sessions.get(scope.agentId) !== session || session.driver !== createdDriver || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was opening", 409);
        }
        const info = redactPageInfo(await createdDriver.pageInfo());
        if (this.sessions.get(scope.agentId) !== session || session.driver !== createdDriver || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was opening", 409);
        }
        session.replayUrl = info.replayUrl;
        session.dto = { ...session.dto, status: "ready", url: info.url, title: info.title, updatedAt: new Date().toISOString() };
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
        createdDriver = await this.createDriver(session.dto.id, (level, text) => {
          if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "ready") return;
          this.emit(scope, {
            type: "browser_console", sessionId: session.dto.id, executionId: scope.runId,
            level, text: redactBrowserText(text).slice(0, MAX_CONSOLE_TEXT),
          });
        }, (handle, options) => this.registerSpawnHandle(scope, session, reconnectEpoch, publication, handle, options));
        publication.finish();
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was reconnecting", 409);
        }
        session.driver = createdDriver;
        if (previousUrl && previousUrl !== "about:blank") await createdDriver.navigate(validateBrowserUrl(previousUrl));
        const info = redactPageInfo(await createdDriver.pageInfo());
        if (this.sessions.get(scope.agentId) !== session || session.driver !== createdDriver || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was reconnecting", 409);
        }
        session.replayUrl = info.replayUrl;
        session.dto = {
          ...session.dto, status: "ready", url: info.url, title: info.title,
          frameRevision: session.dto.frameRevision + 1, updatedAt: new Date().toISOString(),
        };
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
        session.dto = {
          ...session.dto, controlOwner: owner, controlEpoch: session.dto.controlEpoch + 1,
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

  async navigate(scope: BrowserScope, url: string, owner: BrowserControlOwner): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    this.assertControl(session, owner);
    const target = validateBrowserUrl(url);
    return this.pageAction(scope, session, owner, undefined, (driver) => driver.navigate(target), (info) => {
      this.updateInfo(session, info);
      this.emit(scope, {
        type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
        actor: owner, action: "navigate", summary: `navigated to ${session.dto.url}`, url: session.dto.url,
      });
      this.lifecycle(session, "navigated");
      return publicDto(session);
    });
  }

  async inspect(scope: BrowserScope): Promise<string> {
    const session = this.ready(scope);
    return this.pageAction(scope, session, undefined, undefined, async (driver) => ({
      snapshot: await driver.inspect(),
      info: await driver.pageInfo(),
    }), ({ snapshot, info }) => {
      this.updateInfo(session, info);
      this.emit(scope, {
        type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
        actor: "agent", action: "inspect", summary: `inspected ${session.dto.url}`, url: session.dto.url,
      });
      return { snapshot: redactSnapshot(snapshot), info };
    }).then(({ snapshot }) => snapshot.slice(0, MAX_SNAPSHOT_TEXT));
  }

  async act(scope: BrowserScope, input: { action?: unknown; selector?: unknown; text?: unknown; key?: unknown }): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    this.assertControl(session, "agent");
    const action = input.action;
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
    return this.pageAction(scope, session, "agent", undefined, work, (info) => {
      this.updateInfo(session, info);
      this.emit(scope, {
        type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
        actor: "agent", action: action === "fill" ? "type" : action, summary, url: session.dto.url,
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
      if (!input.text || input.text.length > 4_000) throw new BrowserSessionError("browser type text must contain 1 to 4000 characters");
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

  async captureArtifact(scope: BrowserScope): Promise<{ path: string; width: number; height: number }> {
    const session = this.ready(scope);
    this.assertControl(session, "agent");
    const body = await this.pageAction(scope, session, "agent", undefined, (driver) => driver.capture(), (captured) => {
      if (!captured.length || captured.length > MAX_FRAME_BYTES) throw new BrowserSessionError("browser screenshot exceeds the 16 MiB limit", 503);
      session.dto = { ...session.dto, frameRevision: session.dto.frameRevision + 1, updatedAt: new Date().toISOString() };
      return captured;
    });
    const artifactId = randomUUID();
    const relative = path.posix.join("browser", `${artifactId}.png`);
    const published = publishManagedArtifactContent(this.dataDir, scope.projectId, artifactId, body);
    this.emit(scope, {
      type: "browser_screenshot", sessionId: session.dto.id, executionId: scope.actorRunId ?? scope.runId,
      artifactId, path: relative, width: VIEWPORT.width, height: VIEWPORT.height,
      size: published.size, sha256: published.sha256,
    });
    return { path: relative, ...VIEWPORT };
  }

  async close(scope: BrowserScope, reason = "explicit_close"): Promise<BrowserSessionDto> {
    const session = this.owned(scope);
    if (session.dto.status === "closed" && !session.closingDriver && !session.spawnHandles.size &&
        !session.opening && !session.cleanup) return publicDto(session);
    const opening = session.opening;
    const publication = session.spawnPublication;
    const driver = session.driver ?? session.closingDriver;
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

interface CdpReply {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
}

async function terminateBrowserProcess(child: ChildProcess): Promise<void> {
  await terminateProcessGroup(child, {
    label: "browser",
    termGraceMs: 2_000,
    killConfirmationMs: 2_000,
  });
}

async function removeBrowserProfile(profileDir: string): Promise<void> {
  // Chrome can keep creating profile files for a short interval after the
  // browser process exits. Node's recursive rm otherwise exposes a transient
  // ENOTEMPTY and can mask the launch failure that actually caused teardown.
  await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
}

export function initialBrowserTargetRequest(): { url: string } {
  // Current Chrome rejects width/height when newWindow is false. The viewport
  // is established below through Emulation.setDeviceMetricsOverride instead.
  return { url: "about:blank" };
}

class CdpConnection {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(message: CdpReply) => void>();

  constructor(private readonly input: Writable, output: Readable) {
    input.on("error", (error) => this.fail(error));
    output.on("data", (chunk: Buffer) => this.consume(chunk));
    output.on("error", (error) => this.fail(error));
    output.on("end", () => this.fail(new Error("browser debugging pipe closed")));
  }

  onEvent(listener: (message: CdpReply) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const end = this.buffer.indexOf(0);
      if (end < 0) return;
      const body = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 1);
      if (!body) continue;
      let message: CdpReply;
      try { message = JSON.parse(body) as CdpReply; } catch { continue; }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message ?? "browser command failed"));
        else pending.resolve(message.result ?? {});
      } else {
        for (const listener of this.listeners) listener(message);
      }
    }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`browser command timed out: ${method}`));
      }, 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
    this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    return result;
  }
}

class ChromeCdpDriver implements BrowserDriver {
  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: CdpConnection,
    private readonly cdpSessionId: string,
    private readonly profileDir: string,
    readonly terminationAuthority: object,
  ) {}

  static async create(
    executable: string,
    profileDir: string,
    onConsole: Parameters<BrowserDriverFactory>[1],
    onSpawned?: Parameters<BrowserDriverFactory>[2],
  ): Promise<ChromeCdpDriver> {
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    const child = spawn(executable, [
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${profileDir}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-dev-shm-usage",
      "--disable-features=Translate,OptimizationHints",
      "about:blank",
    ], {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      // Browser processes do not need Ponderosa/operator/runtime secrets.
      env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "LANG", "LC_ALL"]
        .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!] as const])),
      detached: process.platform !== "win32",
    });
    let launchError = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      launchError = `${launchError}${chunk}`.slice(-MAX_BROWSER_LAUNCH_ERROR);
    });
    const terminationAuthority = {};
    const spawnHandle: BrowserTerminationHandle = {
      terminationAuthority,
      close: async () => {
        await terminateBrowserProcess(child);
        await removeBrowserProfile(profileDir);
      },
    };
    let externallyOwned = false;
    try {
      if (onSpawned) {
        onSpawned(spawnHandle, { complete: true, coversReturnedDriver: true });
        externallyOwned = true;
      }
      const input = child.stdio[3] as Writable | null;
      const output = child.stdio[4] as Readable | null;
      if (!input || !output) throw new Error("browser debugging pipe could not be created");
      const connection = new CdpConnection(input, output);
      const created = await connection.send("Target.createTarget", initialBrowserTargetRequest());
      const targetId = String(created.targetId ?? "");
      if (!targetId) throw new Error("browser did not create a page target");
      const attached = await connection.send("Target.attachToTarget", { targetId, flatten: true });
      const sessionId = String(attached.sessionId ?? "");
      if (!sessionId) throw new Error("browser did not attach to the page target");
      const driver = new ChromeCdpDriver(child, connection, sessionId, profileDir, terminationAuthority);
      connection.onEvent((message) => {
        if (message.sessionId !== sessionId || message.method !== "Runtime.consoleAPICalled") return;
        const type = String(message.params?.type ?? "log");
        const level = type === "error" ? "error" : type === "warning" || type === "warn" ? "warning" : type === "info" ? "info" : "log";
        const args = Array.isArray(message.params?.args) ? message.params.args : [];
        const text = args.map((arg) => {
          if (!arg || typeof arg !== "object") return String(arg);
          const value = (arg as { value?: unknown; description?: unknown }).value ?? (arg as { description?: unknown }).description;
          return typeof value === "string" ? value : JSON.stringify(value);
        }).join(" ");
        onConsole(level, text);
      });
      await Promise.all([
        connection.send("Page.enable", {}, sessionId),
        connection.send("Runtime.enable", {}, sessionId),
        connection.send("Console.enable", {}, sessionId),
        connection.send("Emulation.setDeviceMetricsOverride", {
          width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
        }, sessionId),
      ]);
      return driver;
    } catch (error) {
      // BrowserSessionManager owns a synchronously registered process handle
      // across readiness failure. Direct factory consumers still receive the
      // previous self-cleaning behavior.
      if (!externallyOwned) await spawnHandle.close();
      const primary = error instanceof Error ? error.message : String(error);
      const diagnostics = redactBrowserText(launchError.trim());
      throw new Error(diagnostics ? `${primary}\n${diagnostics}` : primary);
    }
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const result = await this.connection.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    }, this.cdpSessionId);
    const exception = result.exceptionDetails as { text?: string } | undefined;
    if (exception) throw new Error(exception.text ?? "browser page evaluation failed");
    const remote = result.result as { value?: T } | undefined;
    return remote?.value as T;
  }

  pageInfo(): Promise<BrowserPageInfo> {
    return this.evaluate<BrowserPageInfo>("({url: location.href, title: document.title || location.hostname || 'Untitled'})");
  }

  async navigate(url: string): Promise<BrowserPageInfo> {
    await this.connection.send("Page.navigate", { url }, this.cdpSessionId);
    await new Promise((resolve) => setTimeout(resolve, 250));
    return this.pageInfo();
  }

  async inspect(): Promise<string> {
    const snapshot = await this.evaluate<{ url: string; title: string; text: string; controls: Array<Record<string, string>> }>(`(() => {
      const selector = (el) => {
        if (el.id) return '#' + CSS.escape(el.id);
        const name = el.getAttribute('name');
        if (name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
        const parts = []; let node = el;
        while (node && node.nodeType === 1 && parts.length < 5) {
          let part = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (parent) { const peers = [...parent.children].filter(x => x.tagName === node.tagName); if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(node) + 1) + ')'; }
          parts.unshift(part); node = parent;
        }
        return parts.join(' > ');
      };
      const controls = [...document.querySelectorAll('a[href],button,input,textarea,select,[role=button]')].slice(0, 80).map(el => ({
        selector: selector(el), tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 240),
      }));
      return { url: location.href, title: document.title || '', text: (document.body?.innerText || '').slice(0, ${MAX_SNAPSHOT_TEXT}), controls };
    })()`);
    return JSON.stringify(snapshot, null, 2);
  }

  private async selectorPoint(selector: string): Promise<{ x: number; y: number }> {
    return this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('selector not found'); el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  }

  async click(selector: string): Promise<BrowserPageInfo> {
    const point = await this.selectorPoint(selector);
    await this.pointer(point.x, point.y);
    return this.pageInfo();
  }

  async fill(selector: string, text: string): Promise<BrowserPageInfo> {
    await this.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) throw new Error('selector is not editable'); el.focus(); if ('value' in el) { el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); } else { el.textContent=''; } return true; })()`);
    await this.connection.send("Input.insertText", { text }, this.cdpSessionId);
    await this.evaluate(`(() => { const el=document.activeElement; el?.dispatchEvent(new Event('input',{bubbles:true})); el?.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
    return this.pageInfo();
  }

  async key(key: string): Promise<BrowserPageInfo> {
    const text = key.length === 1 ? key : undefined;
    await this.connection.send("Input.dispatchKeyEvent", { type: "keyDown", key, ...(text ? { text } : {}) }, this.cdpSessionId);
    await this.connection.send("Input.dispatchKeyEvent", { type: "keyUp", key }, this.cdpSessionId);
    return this.pageInfo();
  }

  async pointer(x: number, y: number): Promise<BrowserPageInfo> {
    await this.connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.cdpSessionId);
    await this.connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, this.cdpSessionId);
    await this.connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, this.cdpSessionId);
    return this.pageInfo();
  }

  async type(text: string): Promise<BrowserPageInfo> {
    await this.connection.send("Input.insertText", { text }, this.cdpSessionId);
    return this.pageInfo();
  }

  async scroll(deltaX: number, deltaY: number): Promise<BrowserPageInfo> {
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: VIEWPORT.width / 2, y: VIEWPORT.height / 2, deltaX, deltaY,
    }, this.cdpSessionId);
    return this.pageInfo();
  }

  async capture(): Promise<Buffer> {
    const result = await this.connection.send("Page.captureScreenshot", { format: "png", fromSurface: true }, this.cdpSessionId);
    if (typeof result.data !== "string") throw new Error("browser did not return a screenshot");
    return Buffer.from(result.data, "base64");
  }

  async close(): Promise<void> {
    let closeTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.connection.send("Browser.close").catch(() => undefined),
        new Promise<void>((resolve) => {
          closeTimer = setTimeout(resolve, 250);
        }),
      ]);
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
    }
    await terminateBrowserProcess(this.child);
    await removeBrowserProfile(this.profileDir);
  }
}

export function findBrowserExecutable(configured = process.env.PONDEROSA_BROWSER_EXECUTABLE): string | undefined {
  const candidates = [
    configured && path.isAbsolute(configured) ? configured : undefined,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate));
}

export function chromeBrowserDriverFactory(dataDir: string, executable = findBrowserExecutable()): BrowserDriverFactory {
  return async (sessionId, onConsole, onSpawned) => {
    if (!executable) {
      throw new Error("host browser is unavailable; set PONDEROSA_BROWSER_EXECUTABLE to a Chromium/Chrome binary");
    }
    const profileDir = path.join(dataDir, "browser-sessions", sessionId);
    return ChromeCdpDriver.create(executable, profileDir, onConsole, onSpawned);
  };
}
