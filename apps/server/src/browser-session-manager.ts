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

export interface BrowserScope {
  projectId: string;
  agentId: string;
  runId: string;
  conversationId?: string;
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

function sameScope(dto: BrowserSessionDto, scope: BrowserScope): boolean {
  return dto.projectId === scope.projectId && dto.agentId === scope.agentId && dto.runId === scope.runId &&
    (dto.conversationId ?? "") === (scope.conversationId ?? "");
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();

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

  async open(scope: BrowserScope, url?: string): Promise<BrowserSessionDto> {
    const existing = this.sessions.get(scope.agentId);
    if (existing?.dto.status === "ready") {
      if (!sameScope(existing.dto, scope)) {
        throw new BrowserSessionError("another run owns this agent's browser session", 409);
      }
      if (url) await this.navigate(scope, url, "agent");
      return publicDto(existing);
    }
    if (existing?.driver) await existing.driver.close().catch(() => undefined);
    const now = new Date().toISOString();
    const session: ManagedSession = {
      dto: {
        id: randomUUID(),
        ...scope,
        status: "opening",
        controlOwner: "agent",
        controlEpoch: 1,
        frameRevision: 0,
        openedAt: now,
        updatedAt: now,
      },
      queue: Promise.resolve(),
    };
    this.sessions.set(scope.agentId, session);
    this.lifecycle(session, "open_requested");
    try {
      session.driver = await this.createDriver(session.dto.id, (level, text) => {
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "ready") return;
        this.emit(scope, {
          type: "browser_console",
          sessionId: session.dto.id,
          executionId: scope.runId,
          level,
          text: text.slice(0, MAX_CONSOLE_TEXT),
        });
      });
      if (url) await session.driver.navigate(validateBrowserUrl(url));
      const info = await session.driver.pageInfo();
      session.dto = { ...session.dto, status: "ready", ...info, updatedAt: new Date().toISOString() };
      this.lifecycle(session, "opened");
      return publicDto(session);
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      await session.driver?.close().catch(() => undefined);
      session.driver = undefined;
      session.dto = { ...session.dto, status: "failed", failure, updatedAt: new Date().toISOString() };
      this.lifecycle(session, failure);
      throw new BrowserSessionError(failure, 503);
    }
  }

  async reconnect(scope: BrowserScope): Promise<BrowserSessionDto> {
    const session = this.owned(scope);
    const previousUrl = session.dto.url;
    const previousDriver = session.driver;
    session.driver = undefined;
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
    try {
      // Fence new commands before waiting for an in-flight command to settle,
      // then replace the process. This keeps reconnect from racing a frame or
      // input request issued by another tab.
      await session.queue.catch(() => undefined);
      await previousDriver?.close().catch(() => undefined);
      session.driver = await this.createDriver(session.dto.id, (level, text) => {
        if (this.sessions.get(scope.agentId) !== session || session.dto.status !== "ready") return;
        this.emit(scope, {
          type: "browser_console", sessionId: session.dto.id, executionId: scope.runId,
          level, text: text.slice(0, MAX_CONSOLE_TEXT),
        });
      });
      if (previousUrl && previousUrl !== "about:blank") await session.driver.navigate(validateBrowserUrl(previousUrl));
      const info = await session.driver.pageInfo();
      session.dto = { ...session.dto, status: "ready", ...info, frameRevision: session.dto.frameRevision + 1, updatedAt: new Date().toISOString() };
      this.lifecycle(session, "reconnected");
      return publicDto(session);
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      await session.driver?.close().catch(() => undefined);
      session.driver = undefined;
      session.dto = { ...session.dto, status: "failed", failure, updatedAt: new Date().toISOString() };
      this.lifecycle(session, failure);
      throw new BrowserSessionError(failure, 503);
    }
  }

  async setControl(scope: BrowserScope, owner: BrowserControlOwner, expectedEpoch?: number): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
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
    session.dto = {
      ...session.dto, ...info, frameRevision: session.dto.frameRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    session.lastFrame = undefined;
  }

  async navigate(scope: BrowserScope, url: string, owner: BrowserControlOwner): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    this.assertControl(session, owner);
    const target = validateBrowserUrl(url);
    const info = await this.serialized(session, () => session.driver.navigate(target));
    this.updateInfo(session, info);
    this.emit(scope, {
      type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
      actor: owner, action: "navigate", summary: `navigated to ${info.url}`, url: info.url,
    });
    this.lifecycle(session, "navigated");
    return publicDto(session);
  }

  async inspect(scope: BrowserScope): Promise<string> {
    const session = this.ready(scope);
    const { snapshot, info } = await this.serialized(session, async () => ({
      snapshot: await session.driver.inspect(),
      info: await session.driver.pageInfo(),
    }));
    this.updateInfo(session, info);
    this.emit(scope, {
      type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
      actor: "agent", action: "inspect", summary: `inspected ${info.url}`, url: info.url,
    });
    return snapshot.slice(0, MAX_SNAPSHOT_TEXT);
  }

  async act(scope: BrowserScope, input: { action?: unknown; selector?: unknown; text?: unknown; key?: unknown }): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    this.assertControl(session, "agent");
    const action = input.action;
    let info: BrowserPageInfo;
    let summary: string;
    if (action === "click" && typeof input.selector === "string" && input.selector.length > 0 && input.selector.length <= MAX_SELECTOR_TEXT) {
      info = await this.serialized(session, () => session.driver.click(input.selector as string));
      summary = `clicked ${input.selector}`;
    } else if (action === "fill" && typeof input.selector === "string" && input.selector.length > 0 && input.selector.length <= MAX_SELECTOR_TEXT && typeof input.text === "string") {
      if (input.text.length > 4_000) throw new BrowserSessionError("browser fill text exceeds 4000 characters");
      info = await this.serialized(session, () => session.driver.fill(input.selector as string, input.text as string));
      summary = `filled ${input.selector}`;
    } else if (action === "key" && typeof input.key === "string" && input.key.length > 0 && input.key.length <= 40) {
      info = await this.serialized(session, () => session.driver.key(input.key as string));
      summary = `pressed ${input.key}`;
    } else {
      throw new BrowserSessionError("browser action requires click(selector), fill(selector,text), or key(key)");
    }
    this.updateInfo(session, info);
    this.emit(scope, {
      type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
      actor: "agent", action: action === "fill" ? "type" : action, summary, url: info.url,
    });
    return publicDto(session);
  }

  async operatorInput(scope: BrowserScope, input: BrowserOperatorInputRequest): Promise<BrowserSessionDto> {
    const session = this.ready(scope);
    this.assertControl(session, "operator", input.expectedControlEpoch);
    let info: BrowserPageInfo;
    let summary: string;
    if (input.kind === "click") {
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x > VIEWPORT.width || input.y > VIEWPORT.height) {
        throw new BrowserSessionError("browser click coordinates are outside the viewport");
      }
      info = await this.serialized(session, () => session.driver.pointer(input.x, input.y));
      summary = `clicked viewport at ${Math.round(input.x)},${Math.round(input.y)}`;
    } else if (input.kind === "type") {
      if (!input.text || input.text.length > 4_000) throw new BrowserSessionError("browser type text must contain 1 to 4000 characters");
      info = await this.serialized(session, () => session.driver.type(input.text));
      summary = "typed into the focused page control";
    } else if (input.kind === "key") {
      if (!input.key || input.key.length > 40) throw new BrowserSessionError("browser key is invalid");
      info = await this.serialized(session, () => session.driver.key(input.key));
      summary = `pressed ${input.key}`;
    } else {
      if (![input.deltaX, input.deltaY].every(Number.isFinite) || Math.abs(input.deltaX) > 4_000 || Math.abs(input.deltaY) > 4_000) {
        throw new BrowserSessionError("browser scroll delta is invalid");
      }
      info = await this.serialized(session, () => session.driver.scroll(input.deltaX, input.deltaY));
      summary = `scrolled viewport by ${Math.round(input.deltaX)},${Math.round(input.deltaY)}`;
    }
    this.updateInfo(session, info);
    this.emit(scope, {
      type: "browser_action", sessionId: session.dto.id, executionId: scope.runId,
      actor: "operator", action: input.kind, summary, url: info.url,
    });
    return publicDto(session);
  }

  async captureFrame(scope: BrowserScope): Promise<{ body: Buffer; revision: number }> {
    const session = this.ready(scope);
    if (session.lastFrame && Date.now() - session.lastFrame.capturedAt < 250) {
      return { body: session.lastFrame.body, revision: session.lastFrame.revision };
    }
    if (session.frameCapture) return session.frameCapture;
    session.frameCapture = this.serialized(session, () => session.driver.capture()).then((body) => {
      if (session.dto.status !== "ready" || !session.driver) throw new BrowserSessionError("browser session closed while capturing", 409);
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
    const body = await this.serialized(session, () => session.driver.capture());
    if (session.dto.status !== "ready" || !session.driver) throw new BrowserSessionError("browser session closed while capturing", 409);
    if (!body.length || body.length > MAX_FRAME_BYTES) throw new BrowserSessionError("browser screenshot exceeds the 16 MiB limit", 503);
    const relative = path.posix.join("browser", `${session.dto.id}-${Date.now()}-${randomUUID()}.png`);
    const directory = artifactsDir(this.dataDir, scope.projectId, scope.agentId);
    const file = path.join(directory, ...relative.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, body, { mode: 0o600, flag: "wx" });
    session.dto = { ...session.dto, frameRevision: session.dto.frameRevision + 1, updatedAt: new Date().toISOString() };
    this.emit(scope, {
      type: "browser_screenshot", sessionId: session.dto.id, executionId: scope.runId,
      path: relative, width: VIEWPORT.width, height: VIEWPORT.height,
    });
    return { path: relative, ...VIEWPORT };
  }

  async close(scope: BrowserScope, reason = "explicit_close"): Promise<BrowserSessionDto> {
    const session = this.owned(scope);
    if (session.dto.status === "closed") return publicDto(session);
    const driver = session.driver;
    session.driver = undefined;
    session.lastFrame = undefined;
    session.dto = {
      ...session.dto, status: "closed", controlEpoch: session.dto.controlEpoch + 1,
      updatedAt: new Date().toISOString(),
    };
    this.lifecycle(session, reason);
    await driver?.close().catch(() => undefined);
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

class CdpConnection {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(message: CdpReply) => void>();

  constructor(private readonly input: Writable, output: Readable) {
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
    try {
      const input = child.stdio[3] as Writable | null;
      const output = child.stdio[4] as Readable | null;
      if (!input || !output) throw new Error("browser debugging pipe could not be created");
      child.stderr?.resume();
      const connection = new CdpConnection(input, output);
      const created = await connection.send("Target.createTarget", { url: "about:blank", width: VIEWPORT.width, height: VIEWPORT.height, newWindow: false });
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
      if (child.exitCode === null) child.kill("SIGKILL");
      await fs.rm(profileDir, { recursive: true, force: true });
      throw error;
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
    if (this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.child.kill("SIGKILL"); resolve(); }, 2_000);
        this.child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    await fs.rm(this.profileDir, { recursive: true, force: true });
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
