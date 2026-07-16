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
import { artifactsDir } from "@ponderosa/agents";

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

export interface BrowserDriver {
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

export type BrowserDriverFactory = (
  sessionId: string,
  onConsole: (level: "log" | "info" | "warning" | "error", text: string) => void,
) => Promise<BrowserDriver>;

type BrowserAuditEvent = Extract<AgentEvent, {
  type: "browser_session" | "browser_action" | "browser_console" | "browser_screenshot";
}>;

interface ManagedSession {
  dto: BrowserSessionDto;
  driver?: BrowserDriver;
  queue: Promise<unknown>;
  lifecycleEpoch: number;
  opening?: Promise<BrowserSessionDto>;
  /** A URL is replayable only when it contains no credential-bearing query. */
  replayUrl?: string;
  lastFrame?: { body: Buffer; revision: number; capturedAt: number };
  frameCapture?: Promise<{ body: Buffer; revision: number }>;
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
  private readonly closingDrivers = new WeakMap<BrowserDriver, Promise<void>>();

  constructor(
    private readonly dataDir: string,
    private readonly createDriver: BrowserDriverFactory,
    private readonly emit: (scope: BrowserScope, event: BrowserAuditEvent) => void,
  ) {}

  get(agentId: string): BrowserSessionDto | undefined {
    const session = this.sessions.get(agentId);
    return session ? publicDto(session) : undefined;
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

  private async closeDriver(driver: BrowserDriver | undefined): Promise<void> {
    if (!driver) return;
    const inProgress = this.closingDrivers.get(driver);
    if (inProgress) return inProgress;
    const closing = driver.close().catch(() => undefined);
    this.closingDrivers.set(driver, closing);
    await closing;
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
    if (existing?.dto.status === "opening" && existing.opening) {
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
      queue: Promise.resolve(),
      lifecycleEpoch: 1,
    };
    this.sessions.set(scope.agentId, session);
    this.lifecycle(session, "open_requested");
    const opening = (async () => {
      let createdDriver: BrowserDriver | undefined;
      try {
        await this.closeDriver(existing?.driver);
        createdDriver = await this.createDriver(session.dto.id, (level, text) => {
          if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "ready") return;
          this.emit(scope, {
            type: "browser_console",
            sessionId: session.dto.id,
            executionId: scope.runId,
            level,
            text: redactBrowserText(text).slice(0, MAX_CONSOLE_TEXT),
          });
        });
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
        await this.closeDriver(createdDriver);
        if (session.driver === createdDriver) session.driver = undefined;
        const failure = redactBrowserText(error instanceof Error ? error.message : String(error));
        if (this.sessions.get(scope.agentId) === session && session.dto.status === "opening") {
          session.dto = { ...session.dto, status: "failed", failure, updatedAt: new Date().toISOString() };
          this.lifecycle(session, failure);
        }
        if (error instanceof BrowserSessionError) throw error;
        throw new BrowserSessionError(failure, 503);
      } finally {
        session.opening = undefined;
      }
    })();
    session.opening = opening;
    return opening;
  }

  async reconnect(scope: BrowserScope): Promise<BrowserSessionDto> {
    const session = this.owned(scope);
    if (session.dto.status === "opening" && session.opening) return session.opening;
    const previousUrl = session.replayUrl;
    const previousDriver = session.driver;
    session.driver = undefined;
    session.lifecycleEpoch += 1;
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
    const reconnecting = (async () => {
      let createdDriver: BrowserDriver | undefined;
      try {
        // The epoch/status fence rejects completion from the old driver before
        // we wait for its queued command and replace the process.
        await session.queue.catch(() => undefined);
        await this.closeDriver(previousDriver);
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "opening") {
          throw new BrowserSessionError("browser session closed while it was reconnecting", 409);
        }
        createdDriver = await this.createDriver(session.dto.id, (level, text) => {
          if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "ready") return;
          this.emit(scope, {
            type: "browser_console", sessionId: session.dto.id, executionId: scope.runId,
            level, text: redactBrowserText(text).slice(0, MAX_CONSOLE_TEXT),
          });
        });
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
        await this.closeDriver(createdDriver);
        if (session.driver === createdDriver) session.driver = undefined;
        const failure = redactBrowserText(error instanceof Error ? error.message : String(error));
        if (this.sessions.get(scope.agentId) === session && session.dto.status === "opening") {
          session.dto = { ...session.dto, status: "failed", failure, updatedAt: new Date().toISOString() };
          this.lifecycle(session, failure);
        }
        if (error instanceof BrowserSessionError) throw error;
        throw new BrowserSessionError(failure, 503);
      } finally {
        session.opening = undefined;
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
      if (input.text.length > 4_000) throw new BrowserSessionError("browser fill text exceeds 4000 characters");
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
    const relative = path.posix.join("browser", `${session.dto.id}-${Date.now()}-${randomUUID()}.png`);
    const directory = artifactsDir(this.dataDir, scope.projectId, scope.actorAgentId ?? scope.agentId);
    const file = path.join(directory, ...relative.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, body, { mode: 0o600, flag: "wx" });
    this.emit(scope, {
      type: "browser_screenshot", sessionId: session.dto.id, executionId: scope.actorRunId ?? scope.runId,
      path: relative, width: VIEWPORT.width, height: VIEWPORT.height,
    });
    return { path: relative, ...VIEWPORT };
  }

  async close(scope: BrowserScope, reason = "explicit_close"): Promise<BrowserSessionDto> {
    const session = this.owned(scope);
    if (session.dto.status === "closed") return publicDto(session);
    const driver = session.driver;
    session.driver = undefined;
    session.lifecycleEpoch += 1;
    session.replayUrl = undefined;
    session.lastFrame = undefined;
    session.frameCapture = undefined;
    session.dto = {
      ...session.dto, status: "closed", controlEpoch: session.dto.controlEpoch + 1,
      updatedAt: new Date().toISOString(),
    };
    this.lifecycle(session, reason);
    await this.closeDriver(driver);
    return publicDto(session);
  }

  async closeRun(scope: BrowserScope, reason: string): Promise<void> {
    const session = this.sessions.get(scope.agentId);
    if (!session || !sameScope(session.dto, scope)) return;
    await this.close(scope, reason);
  }

  async closeAll(reason: string): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((session) => this.close(session.dto, reason)));
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

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(false); }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateBrowserProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 2_000)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child, 2_000);
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
  ) {}

  static async create(executable: string, profileDir: string, onConsole: Parameters<BrowserDriverFactory>[1]): Promise<ChromeCdpDriver> {
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
    });
    let launchError = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      launchError = `${launchError}${chunk}`.slice(-MAX_BROWSER_LAUNCH_ERROR);
    });
    try {
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
      const driver = new ChromeCdpDriver(child, connection, sessionId, profileDir);
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
      await terminateBrowserProcess(child);
      await removeBrowserProfile(profileDir).catch(() => undefined);
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
    await this.connection.send("Browser.close").catch(() => undefined);
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
  return async (sessionId, onConsole) => {
    if (!executable) {
      throw new Error("host browser is unavailable; set PONDEROSA_BROWSER_EXECUTABLE to a Chromium/Chrome binary");
    }
    const profileDir = path.join(dataDir, "browser-sessions", sessionId);
    return ChromeCdpDriver.create(executable, profileDir, onConsole);
  };
}
