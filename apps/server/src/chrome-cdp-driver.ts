import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { RuntimeProcessIdentity } from "@ponderosa/core";
import { processGroupAlive, runtimeProcessIdentity, terminateProcessGroup } from "@ponderosa/engines";
import { redactBrowserText } from "./browser-security.js";

const VIEWPORT = { width: 1280, height: 720 } as const;
const MAX_SNAPSHOT_TEXT = 16_000;
const MAX_BROWSER_LAUNCH_ERROR = 4_000;

export interface BrowserRuntimeCapabilities {
  multiPage: boolean;
  fileUpload: boolean;
}

export function browserRuntimeCapabilities(env: NodeJS.ProcessEnv = process.env): BrowserRuntimeCapabilities {
  return {
    multiPage: env.PONDEROSA_BROWSER_MULTI_PAGE === "1" || env.NODE_ENV === "development",
    fileUpload: env.PONDEROSA_BROWSER_FILE_UPLOAD === "1" || env.NODE_ENV === "development",
  };
}

export class BrowserDriverActionError extends Error {
  constructor(
    readonly reason: "invalid_selector" | "selector_not_found" | "selector_not_editable" | "page_not_found" | "last_page" | "upload_disabled" | "selector_not_file_input" | "file_input_disabled" | "file_type_not_accepted" | "no_pending_file_chooser" | "stale_file_chooser" | "unsupported_file_chooser" | "upload_verification_failed",
  ) {
    super(reason);
    this.name = "BrowserDriverActionError";
  }
}

export interface BrowserPageInfo {
  url: string;
  title: string;
}

export interface ManagedBrowserPageInfo extends BrowserPageInfo {
  pageId: string;
  openerPageId?: string;
  active: boolean;
  isNew: boolean;
  closable: boolean;
}

export interface BrowserPendingFileChooserInfo {
  pageId: string;
  mode: string;
  createdAt: number;
  expiresAt: number;
}

export interface BrowserPagesInfo {
  activePageId: string;
  pages: ManagedBrowserPageInfo[];
  pendingFileChooser?: BrowserPendingFileChooserInfo;
}

export interface BrowserPageEvent {
  type: "page_open" | "page_activate" | "page_close" | "page_navigate" | "page_limit" | "file_chooser_open" | "file_chooser_clear";
  pageId?: string;
  openerPageId?: string;
  automatic?: boolean;
  reason?: string;
  pages: BrowserPagesInfo;
}

export interface BrowserUploadInput {
  uploadId: string;
  selector?: string;
  stagedPath: string;
  expectedName: string;
  expectedSize: number;
  expectedMediaType: string;
}

export interface BrowserUploadResult extends BrowserPageInfo {
  pageId: string;
  input: { name: string; size: number; type: string; count: number };
}

export interface BrowserTerminationHandle {
  /** Opaque process-group authority shared by handles whose successful close
   * observes the same whole-process shutdown. Absent means this handle is its
   * own distinct authority. */
  readonly terminationAuthority?: object;
  readonly processIdentity?: RuntimeProcessIdentity;
  isAlive(): boolean;
  close(): Promise<void>;
}

export interface BrowserDriver extends BrowserTerminationHandle {
  pageInfo(): Promise<BrowserPageInfo>;
  pages(): Promise<BrowserPagesInfo>;
  activatePage(pageId: string): Promise<BrowserPagesInfo>;
  closePage(pageId: string): Promise<BrowserPagesInfo>;
  upload(input: BrowserUploadInput): Promise<BrowserUploadResult>;
  clearUploadedFiles(pageId?: string, uploadId?: string): Promise<void>;
  cancelPendingFileChooser(reason?: string): Promise<void>;
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
  onPageEvent?: (event: BrowserPageEvent) => void,
) => Promise<BrowserDriver>;

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

interface ManagedBrowserPage {
  pageId: string;
  targetId: string;
  cdpSessionId: string;
  openerPageId?: string;
  createdAt: number;
  lastActivatedAt?: number;
  initialized: boolean;
  url: string;
  title: string;
  isNew: boolean;
}

class ChromeCdpDriver implements BrowserDriver {
  private readonly pagesById = new Map<string, ManagedBrowserPage>();
  private readonly pageIdByTarget = new Map<string, string>();
  private readonly pageIdBySession = new Map<string, string>();
  private readonly tombstones = new Set<string>();
  private activePageId = "";
  private closing = false;
  private lifecycleGeneration = 1;
  private recentInteraction?: { pageId: string; targetId: string; at: number; generation: number; consumed: boolean };
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly uploadedInputs = new Map<string, Array<{
    uploadId: string;
    cdpSessionId: string;
    reference: { nodeId?: number; backendNodeId?: number };
  }>>();
  private pendingChooser?: {
    pageId: string;
    cdpSessionId: string;
    backendNodeId: number;
    mode: string;
    generation: number;
    createdAt: number;
    expiresAt: number;
    frameId?: string;
    expiryTimer: NodeJS.Timeout;
  };

  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: CdpConnection,
    private readonly profileDir: string,
    private readonly onConsole: Parameters<BrowserDriverFactory>[1],
    private readonly onPageEvent: Parameters<BrowserDriverFactory>[3],
    private readonly multiPageEnabled: boolean,
    private readonly uploadEnabled: boolean,
    readonly terminationAuthority: object,
    readonly processIdentity: RuntimeProcessIdentity | undefined,
  ) {}

  isAlive(): boolean { return processGroupAlive(this.child); }

  static async create(
    executable: string,
    profileDir: string,
    onConsole: Parameters<BrowserDriverFactory>[1],
    onSpawned?: Parameters<BrowserDriverFactory>[2],
    onPageEvent?: Parameters<BrowserDriverFactory>[3],
  ): Promise<ChromeCdpDriver> {
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    const child = spawn(executable, [
      "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profileDir}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, "--no-first-run",
      "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
      "--disable-dev-shm-usage", "--disable-features=Translate,OptimizationHints", "about:blank",
    ], {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "LANG", "LC_ALL"]
        .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!] as const])),
      detached: process.platform !== "win32",
    });
    let launchError = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { launchError = `${launchError}${chunk}`.slice(-MAX_BROWSER_LAUNCH_ERROR); });
    const terminationAuthority = {};
    const processIdentity = runtimeProcessIdentity(child);
    const spawnHandle: BrowserTerminationHandle = {
      terminationAuthority,
      ...(processIdentity ? { processIdentity } : {}),
      isAlive: () => processGroupAlive(child),
      close: async () => { await terminateBrowserProcess(child); await removeBrowserProfile(profileDir); },
    };
    let externallyOwned = false;
    try {
      if (onSpawned) { onSpawned(spawnHandle, { complete: true, coversReturnedDriver: true }); externallyOwned = true; }
      const input = child.stdio[3] as Writable | null;
      const output = child.stdio[4] as Readable | null;
      if (!input || !output) throw new Error("browser debugging pipe could not be created");
      const connection = new CdpConnection(input, output);
      const capabilities = browserRuntimeCapabilities();
      const driver = new ChromeCdpDriver(
        child, connection, profileDir, onConsole, onPageEvent,
        capabilities.multiPage,
        capabilities.fileUpload,
        terminationAuthority, processIdentity,
      );
      connection.onEvent((message) => driver.enqueueEvent(message));
      await connection.send("Target.setDiscoverTargets", { discover: true });
      if (driver.multiPageEnabled) {
        await connection.send("Target.setAutoAttach", {
          autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
        }).catch(() => undefined);
      }
      const targets = await connection.send("Target.getTargets");
      const infos = Array.isArray(targets.targetInfos) ? targets.targetInfos : [];
      for (const value of infos) {
        const info = value && typeof value === "object" ? value as Record<string, unknown> : {};
        if (info.type === "page" && typeof info.targetId === "string") await driver.attachTarget(info);
      }
      if (!driver.pagesById.size) {
        const created = await connection.send("Target.createTarget", initialBrowserTargetRequest());
        const targetId = String(created.targetId ?? "");
        if (!targetId) throw new Error("browser did not create a page target");
        await driver.attachTarget({ targetId, type: "page", url: "about:blank", title: "" });
      }
      if (!driver.activePageId) driver.activateFallback();
      driver.emitPageEvent("page_activate", driver.activePageId, undefined, false, "initial");
      return driver;
    } catch (error) {
      if (!externallyOwned) await spawnHandle.close();
      const primary = error instanceof Error ? error.message : String(error);
      const diagnostics = redactBrowserText(launchError.trim());
      throw new Error(diagnostics ? `${primary}\n${diagnostics}` : primary);
    }
  }

  private enqueueEvent(message: CdpReply): void {
    this.eventQueue = this.eventQueue.then(() => this.handleEvent(message)).catch(() => undefined);
  }

  private async handleEvent(message: CdpReply): Promise<void> {
    if (this.closing) return;
    const params = message.params ?? {};
    if (message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") {
      const info = params.targetInfo && typeof params.targetInfo === "object"
        ? params.targetInfo as Record<string, unknown> : {};
      if (info.type !== "page" || typeof info.targetId !== "string") return;
      const existingId = this.pageIdByTarget.get(info.targetId);
      if (existingId) {
        const page = this.pagesById.get(existingId);
        if (page) {
          if (typeof info.url === "string") page.url = info.url;
          if (typeof info.title === "string") page.title = info.title;
        }
        return;
      }
      if (message.method === "Target.targetCreated") await this.attachTarget(info);
      return;
    }
    if (message.method === "Target.attachedToTarget") {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      const info = params.targetInfo && typeof params.targetInfo === "object"
        ? params.targetInfo as Record<string, unknown> : {};
      if (sessionId && info.type === "page" && typeof info.targetId === "string") {
        await this.registerTarget(info, sessionId);
      }
      return;
    }
    if (message.method === "Target.detachedFromTarget" || message.method === "Target.targetDestroyed") {
      const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      const pageId = targetId ? this.pageIdByTarget.get(targetId) : sessionId ? this.pageIdBySession.get(sessionId) : undefined;
      if (pageId) this.removePage(pageId, "target_detached");
      return;
    }
    if (message.method === "Runtime.consoleAPICalled" && message.sessionId) {
      const pageId = this.pageIdBySession.get(message.sessionId);
      if (!pageId) return;
      const type = String(params.type ?? "log");
      const level = type === "error" ? "error" : type === "warning" || type === "warn" ? "warning" : type === "info" ? "info" : "log";
      const args = Array.isArray(params.args) ? params.args : [];
      const text = args.map((arg) => {
        if (!arg || typeof arg !== "object") return String(arg);
        const item = arg as { value?: unknown; description?: unknown };
        const value = item.value ?? item.description;
        return typeof value === "string" ? value : JSON.stringify(value);
      }).join(" ");
      this.onConsole(level, text);
      return;
    }
    if (message.method === "Page.frameNavigated" && message.sessionId) {
      const pageId = this.pageIdBySession.get(message.sessionId);
      const frame = params.frame as { id?: unknown; parentId?: unknown } | undefined;
      const frameId = typeof frame?.id === "string" ? frame.id : undefined;
      const topFrameNavigated = !frame?.parentId;
      if (pageId && topFrameNavigated) {
        // Top-frame replacement invalidates every remembered DOM input. Drop
        // stale references locally and always publish navigation so the
        // manager can release its staged files. Calling CDP against replaced
        // nodes here can fail and must not suppress the lifecycle event.
        this.uploadedInputs.delete(pageId);
        this.emitPageEvent("page_navigate", pageId, undefined, true, "navigation");
      }
      if (pageId && this.pendingChooser?.pageId === pageId &&
          (topFrameNavigated || !this.pendingChooser.frameId || this.pendingChooser.frameId === frameId)) {
        this.clearPendingChooser("navigation");
      }
      return;
    }
    if (message.method === "Page.fileChooserOpened" && message.sessionId && this.uploadEnabled) {
      const pageId = this.pageIdBySession.get(message.sessionId);
      const backendNodeId = Number(params.backendNodeId);
      if (!pageId || !Number.isInteger(backendNodeId) || backendNodeId <= 0) {
        this.clearPendingChooser("unsupported");
        return;
      }
      this.clearPendingChooser("replaced");
      const createdAt = Date.now();
      const chooser = {
        pageId, cdpSessionId: message.sessionId, backendNodeId,
        mode: String(params.mode ?? "selectSingle"), generation: this.lifecycleGeneration,
        createdAt, expiresAt: createdAt + 60_000,
        ...(typeof params.frameId === "string" ? { frameId: params.frameId } : {}),
        expiryTimer: undefined as unknown as NodeJS.Timeout,
      };
      chooser.expiryTimer = setTimeout(() => {
        if (this.pendingChooser === chooser) this.clearPendingChooser("expired");
      }, 60_000);
      this.pendingChooser = chooser;
      this.emitPageEvent("file_chooser_open", pageId, undefined, false, chooser.mode);
      return;
    }
  }

  private async attachTarget(info: Record<string, unknown>): Promise<void> {
    const targetId = String(info.targetId ?? "");
    if (!targetId || this.pageIdByTarget.has(targetId) || this.tombstones.has(targetId)) return;
    if (!this.multiPageEnabled && this.pagesById.size) {
      await this.connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
      return;
    }
    if (this.pagesById.size >= 8) {
      await this.connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
      this.emitPageEvent("page_limit", undefined, undefined, false, "page_limit");
      return;
    }
    const attached = await this.connection.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = String(attached.sessionId ?? "");
    if (!sessionId) throw new Error("browser did not attach to page target");
    await this.registerTarget(info, sessionId);
  }

  private async registerTarget(info: Record<string, unknown>, cdpSessionId: string): Promise<void> {
    const targetId = String(info.targetId ?? "");
    if (!targetId || this.pageIdByTarget.has(targetId)) return;
    if (this.pagesById.size >= 8) {
      await this.connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
      this.emitPageEvent("page_limit", undefined, undefined, false, "page_limit");
      return;
    }
    const openerTargetId = typeof info.openerId === "string" ? info.openerId : undefined;
    const openerPageId = openerTargetId ? this.pageIdByTarget.get(openerTargetId) : undefined;
    const page: ManagedBrowserPage = {
      pageId: randomUUID(), targetId, cdpSessionId,
      ...(openerPageId ? { openerPageId } : {}),
      createdAt: Date.now(), initialized: false,
      url: typeof info.url === "string" ? info.url : "about:blank",
      title: typeof info.title === "string" ? info.title : "",
      isNew: true,
    };
    this.pagesById.set(page.pageId, page);
    this.pageIdByTarget.set(targetId, page.pageId);
    this.pageIdBySession.set(cdpSessionId, page.pageId);
    try {
      await Promise.all([
        this.connection.send("Page.enable", {}, cdpSessionId),
        this.connection.send("Runtime.enable", {}, cdpSessionId),
        this.connection.send("Console.enable", {}, cdpSessionId),
        this.connection.send("DOM.enable", {}, cdpSessionId),
        this.connection.send("Emulation.setDeviceMetricsOverride", {
          width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
        }, cdpSessionId),
        ...(this.uploadEnabled
          ? [this.connection.send("Page.setInterceptFileChooserDialog", { enabled: true }, cdpSessionId).catch(() => ({}))]
          : []),
      ]);
      page.initialized = true;
      const token = this.recentInteraction;
      const automatic = Boolean(token && !token.consumed && token.generation === this.lifecycleGeneration &&
        Date.now() - token.at <= 5_000 && openerTargetId === token.targetId);
      if (!this.activePageId || automatic) {
        if (token && automatic) token.consumed = true;
        this.activePageId = page.pageId;
        page.lastActivatedAt = Date.now();
        page.isNew = false;
      }
      this.emitPageEvent("page_open", page.pageId, openerPageId, automatic, automatic ? "recent_opener_action" : "discovered");
    } catch (error) {
      this.removePage(page.pageId, "initialization_failed");
      await this.connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
      if (!this.pagesById.size) throw error;
    }
  }

  private currentPage(): ManagedBrowserPage {
    const page = this.pagesById.get(this.activePageId);
    if (!page || !page.initialized) throw new BrowserDriverActionError("page_not_found");
    return page;
  }

  private activateFallback(preferredOpenerId?: string): void {
    const preferred = preferredOpenerId ? this.pagesById.get(preferredOpenerId) : undefined;
    const page = preferred ?? [...this.pagesById.values()].sort((a, b) =>
      (b.lastActivatedAt ?? b.createdAt) - (a.lastActivatedAt ?? a.createdAt))[0];
    this.activePageId = page?.pageId ?? "";
    if (page) { page.lastActivatedAt = Date.now(); page.isNew = false; }
  }

  private removePage(pageId: string, reason: string): void {
    const page = this.pagesById.get(pageId);
    if (!page) return;
    this.pagesById.delete(pageId);
    this.pageIdByTarget.delete(page.targetId);
    this.pageIdBySession.delete(page.cdpSessionId);
    this.uploadedInputs.delete(pageId);
    this.tombstones.add(page.targetId);
    if (this.pendingChooser?.pageId === pageId) this.clearPendingChooser(reason);
    const wasActive = this.activePageId === pageId;
    if (wasActive) this.activateFallback(page.openerPageId);
    this.emitPageEvent("page_close", pageId, page.openerPageId, false, reason);
  }

  private async refreshPage(page: ManagedBrowserPage): Promise<BrowserPageInfo> {
    try {
      const info = await this.evaluateOn<BrowserPageInfo>(page, "({url: location.href, title: document.title || location.hostname || 'Untitled'})");
      page.url = info.url; page.title = info.title;
    } catch { /* retain last sanitized manager projection */ }
    return { url: page.url, title: page.title };
  }

  private snapshot(): BrowserPagesInfo {
    const values = [...this.pagesById.values()].sort((a, b) => a.createdAt - b.createdAt);
    const chooser = this.pendingChooser;
    return {
      activePageId: this.activePageId,
      pages: values.map((page) => ({
        pageId: page.pageId, url: page.url, title: page.title,
        ...(page.openerPageId ? { openerPageId: page.openerPageId } : {}),
        active: page.pageId === this.activePageId, isNew: page.isNew, closable: values.length > 1,
      })),
      ...(chooser ? { pendingFileChooser: {
        pageId: chooser.pageId,
        mode: chooser.mode,
        createdAt: chooser.createdAt,
        expiresAt: chooser.expiresAt,
      } } : {}),
    };
  }

  private clearPendingChooser(reason: string): void {
    const chooser = this.pendingChooser;
    if (!chooser) return;
    clearTimeout(chooser.expiryTimer);
    this.pendingChooser = undefined;
    this.emitPageEvent("file_chooser_clear", chooser.pageId, undefined, false, reason);
  }

  private emitPageEvent(
    type: BrowserPageEvent["type"], pageId?: string, openerPageId?: string,
    automatic?: boolean, reason?: string,
  ): void {
    this.onPageEvent?.({
      type, ...(pageId ? { pageId } : {}), ...(openerPageId ? { openerPageId } : {}),
      ...(automatic !== undefined ? { automatic } : {}), ...(reason ? { reason } : {}), pages: this.snapshot(),
    });
  }

  private async evaluateOn<T>(page: ManagedBrowserPage, expression: string, returnByValue = true): Promise<T> {
    const result = await this.connection.send("Runtime.evaluate", {
      expression, returnByValue, awaitPromise: true, userGesture: true,
    }, page.cdpSessionId);
    const exception = result.exceptionDetails as { text?: string } | undefined;
    if (exception) throw new Error(exception.text ?? "browser page evaluation failed");
    const remote = result.result as { value?: T } | undefined;
    return remote?.value as T;
  }

  private evaluate<T>(expression: string): Promise<T> {
    return this.evaluateOn<T>(this.currentPage(), expression);
  }

  async pages(): Promise<BrowserPagesInfo> {
    await this.eventQueue;
    await Promise.all([...this.pagesById.values()].map((page) => this.refreshPage(page)));
    return this.snapshot();
  }

  async activatePage(pageId: string): Promise<BrowserPagesInfo> {
    await this.eventQueue;
    const page = this.pagesById.get(pageId);
    if (!page || !page.initialized) throw new BrowserDriverActionError("page_not_found");
    this.activePageId = pageId; page.lastActivatedAt = Date.now(); page.isNew = false;
    this.clearPendingChooser("page_switched");
    this.emitPageEvent("page_activate", pageId, page.openerPageId, false, "explicit");
    return this.pages();
  }

  async closePage(pageId: string): Promise<BrowserPagesInfo> {
    await this.eventQueue;
    const page = this.pagesById.get(pageId);
    if (!page) throw new BrowserDriverActionError("page_not_found");
    if (this.pagesById.size <= 1) throw new BrowserDriverActionError("last_page");
    await this.connection.send("Target.closeTarget", { targetId: page.targetId });
    this.removePage(pageId, "explicit");
    return this.pages();
  }

  pageInfo(): Promise<BrowserPageInfo> { return this.refreshPage(this.currentPage()); }

  async navigate(url: string): Promise<BrowserPageInfo> {
    const page = this.currentPage();
    await this.clearUploadedFiles(page.pageId);
    this.clearPendingChooser("navigation");
    await this.connection.send("Page.navigate", { url }, page.cdpSessionId);
    await new Promise((resolve) => setTimeout(resolve, 250));
    return this.refreshPage(page);
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
    const result = await this.evaluate<{ status: "ok"; x: number; y: number } | { status: "invalid_selector" | "selector_not_found" }>(`(() => {
      let el; try { el = document.querySelector(${JSON.stringify(selector)}); } catch { return {status:'invalid_selector'}; }
      if (!el) return {status:'selector_not_found'}; el.scrollIntoView({block:'center',inline:'center'});
      const r=el.getBoundingClientRect(); return {status:'ok',x:r.left+r.width/2,y:r.top+r.height/2};
    })()`);
    if (result.status !== "ok") throw new BrowserDriverActionError(result.status);
    return { x: result.x, y: result.y };
  }

  private markInteraction(): void {
    const page = this.currentPage();
    this.recentInteraction = {
      pageId: page.pageId, targetId: page.targetId, at: Date.now(),
      generation: this.lifecycleGeneration, consumed: false,
    };
  }

  async click(selector: string): Promise<BrowserPageInfo> {
    this.markInteraction();
    const point = await this.selectorPoint(selector);
    await this.pointer(point.x, point.y, false);
    return this.pageInfo();
  }

  async fill(selector: string, text: string): Promise<BrowserPageInfo> {
    const result = await this.evaluate<"ok" | "invalid_selector" | "selector_not_found" | "selector_not_editable">(`(() => {
      let el; try { el=document.querySelector(${JSON.stringify(selector)}); } catch { return 'invalid_selector'; }
      if (!el) return 'selector_not_found';
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return 'selector_not_editable';
      el.focus(); if ('value' in el) { el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); } else { el.textContent=''; }
      return 'ok';
    })()`);
    if (result !== "ok") throw new BrowserDriverActionError(result);
    const page = this.currentPage();
    await this.connection.send("Input.insertText", { text }, page.cdpSessionId);
    await this.evaluate("(() => { const el=document.activeElement; el?.dispatchEvent(new Event('input',{bubbles:true})); el?.dispatchEvent(new Event('change',{bubbles:true})); return true; })()");
    return this.pageInfo();
  }

  async key(key: string): Promise<BrowserPageInfo> {
    const page = this.currentPage(); const text = key.length === 1 ? key : undefined;
    await this.connection.send("Input.dispatchKeyEvent", { type: "keyDown", key, ...(text ? { text } : {}) }, page.cdpSessionId);
    await this.connection.send("Input.dispatchKeyEvent", { type: "keyUp", key }, page.cdpSessionId);
    return this.pageInfo();
  }

  async pointer(x: number, y: number, record = true): Promise<BrowserPageInfo> {
    if (record) this.markInteraction();
    const page = this.currentPage();
    await this.connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, page.cdpSessionId);
    await this.connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, page.cdpSessionId);
    await this.connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, page.cdpSessionId);
    return this.pageInfo();
  }

  async type(text: string): Promise<BrowserPageInfo> {
    const page = this.currentPage();
    await this.connection.send("Input.insertText", { text }, page.cdpSessionId);
    return this.pageInfo();
  }

  async scroll(deltaX: number, deltaY: number): Promise<BrowserPageInfo> {
    const page = this.currentPage();
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: VIEWPORT.width / 2, y: VIEWPORT.height / 2, deltaX, deltaY,
    }, page.cdpSessionId);
    return this.pageInfo();
  }

  async capture(): Promise<Buffer> {
    const page = this.currentPage();
    const result = await this.connection.send("Page.captureScreenshot", { format: "png", fromSurface: true }, page.cdpSessionId);
    if (typeof result.data !== "string") throw new Error("browser did not return a screenshot");
    return Buffer.from(result.data, "base64");
  }

  async upload(input: BrowserUploadInput): Promise<BrowserUploadResult> {
    if (!this.uploadEnabled) throw new BrowserDriverActionError("upload_disabled");
    await this.eventQueue;
    const page = this.currentPage();
    let nodeReference: { nodeId?: number; backendNodeId?: number };
    let objectId: string;

    if (input.selector) {
      const selected = await this.connection.send("Runtime.evaluate", {
        expression: `(() => { let el; try { el=document.querySelector(${JSON.stringify(input.selector)}); } catch { return null; } return el; })()`,
        returnByValue: false,
        awaitPromise: true,
        userGesture: true,
      }, page.cdpSessionId);
      const remote = selected.result as { objectId?: string; subtype?: string; value?: unknown } | undefined;
      if (!remote?.objectId) {
        const syntax = await this.connection.send("Runtime.evaluate", {
          expression: `(() => { try { document.querySelector(${JSON.stringify(input.selector)}); return true; } catch { return false; } })()`,
          returnByValue: true,
        }, page.cdpSessionId);
        const valid = (syntax.result as { value?: unknown } | undefined)?.value === true;
        throw new BrowserDriverActionError(valid ? "selector_not_found" : "invalid_selector");
      }
      objectId = remote.objectId;
      const requested = await this.connection.send("DOM.requestNode", { objectId }, page.cdpSessionId);
      nodeReference = { nodeId: Number(requested.nodeId) };
    } else {
      const chooser = this.pendingChooser;
      if (!chooser) throw new BrowserDriverActionError("no_pending_file_chooser");
      if (chooser.generation !== this.lifecycleGeneration || chooser.pageId !== page.pageId ||
          chooser.cdpSessionId !== page.cdpSessionId || Date.now() > chooser.expiresAt) {
        this.clearPendingChooser("stale");
        throw new BrowserDriverActionError("stale_file_chooser");
      }
      if (chooser.mode !== "selectSingle") throw new BrowserDriverActionError("unsupported_file_chooser");
      nodeReference = { backendNodeId: chooser.backendNodeId };
      const resolved = await this.connection.send(
        "DOM.resolveNode",
        { backendNodeId: chooser.backendNodeId },
        page.cdpSessionId,
      );
      objectId = String((resolved.object as { objectId?: unknown } | undefined)?.objectId ?? "");
      if (!objectId) throw new BrowserDriverActionError("unsupported_file_chooser");
    }

    const inputStateReply = await this.connection.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(name, mediaType) {
        if (!(this instanceof HTMLInputElement) || this.type !== "file") return {code:"selector_not_file_input"};
        if (this.disabled) return {code:"file_input_disabled"};
        if (this.multiple) return {code:"unsupported_file_chooser"};
        const accept = String(this.accept || "").trim();
        if (accept) {
          const extension = name.includes(".") ? "." + name.split(".").pop().toLowerCase() : "";
          const allowed = accept.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)
            .some((rule) => rule.startsWith(".") ? rule === extension
              : rule.endsWith("/*") ? mediaType.toLowerCase().startsWith(rule.slice(0, -1))
              : rule === mediaType.toLowerCase());
          if (!allowed) return {code:"file_type_not_accepted"};
        }
        return {code:"ok", accept, required:this.required, count:this.files?.length || 0};
      }`,
      arguments: [{ value: input.expectedName }, { value: input.expectedMediaType }],
      returnByValue: true,
    }, page.cdpSessionId);
    const inputState = (inputStateReply.result as { value?: { code?: string } } | undefined)?.value;
    if (inputState?.code !== "ok") {
      const code = inputState?.code;
      throw new BrowserDriverActionError(
        code === "file_input_disabled" ? "file_input_disabled"
          : code === "file_type_not_accepted" ? "file_type_not_accepted"
            : code === "unsupported_file_chooser" ? "unsupported_file_chooser"
              : "selector_not_file_input",
      );
    }

    const reference = nodeReference.nodeId
      ? { nodeId: nodeReference.nodeId }
      : { backendNodeId: nodeReference.backendNodeId };
    await this.connection.send(
      "DOM.setFileInputFiles",
      { files: [input.stagedPath], ...reference },
      page.cdpSessionId,
    );
    const assigned = this.uploadedInputs.get(page.pageId) ?? [];
    assigned.push({ uploadId: input.uploadId, cdpSessionId: page.cdpSessionId, reference });
    this.uploadedInputs.set(page.pageId, assigned);
    const metadataReply = await this.connection.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        const file = this.files?.[0];
        return {
          name:file?.name || "",
          size:file?.size || 0,
          type:file?.type || "",
          count:this.files?.length || 0,
        };
      }`,
      returnByValue: true,
    }, page.cdpSessionId);
    const metadata = (metadataReply.result as {
      value?: { name?: unknown; size?: unknown; type?: unknown; count?: unknown };
    } | undefined)?.value;
    this.clearPendingChooser("selected");
    const verified = {
      name: String(metadata?.name ?? ""),
      size: Number(metadata?.size ?? 0),
      type: String(metadata?.type ?? ""),
      count: Number(metadata?.count ?? 0),
    };
    if (verified.count !== 1 || verified.name !== input.expectedName ||
        verified.size !== input.expectedSize ||
        verified.type !== input.expectedMediaType) {
      throw new BrowserDriverActionError("upload_verification_failed");
    }
    const info = await this.pageInfo();
    return { ...info, pageId: page.pageId, input: verified };
  }

  async clearUploadedFiles(pageId?: string, uploadId?: string): Promise<void> {
    const pages = pageId ? [pageId] : [...this.uploadedInputs.keys()];
    const failures: unknown[] = [];
    for (const currentPageId of pages) {
      const assigned = this.uploadedInputs.get(currentPageId) ?? [];
      const remaining: typeof assigned = [];
      for (const input of assigned) {
        if (uploadId !== undefined && input.uploadId !== uploadId) {
          remaining.push(input);
          continue;
        }
        try {
          await this.connection.send(
            "DOM.setFileInputFiles",
            { files: [], ...input.reference },
            input.cdpSessionId,
          );
        } catch (error) {
          remaining.push(input);
          failures.push(error);
        }
      }
      if (remaining.length) this.uploadedInputs.set(currentPageId, remaining);
      else this.uploadedInputs.delete(currentPageId);
    }
    if (failures.length) throw new AggregateError(failures, "browser upload input cleanup did not complete");
  }

  async cancelPendingFileChooser(reason = "explicit"): Promise<void> {
    this.clearPendingChooser(reason);
  }

  async close(): Promise<void> {
    this.closing = true; this.lifecycleGeneration += 1; this.clearPendingChooser("session_closed");
    let closeTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.connection.send("Browser.close").catch(() => undefined),
        new Promise<void>((resolve) => { closeTimer = setTimeout(resolve, 250); }),
      ]);
    } finally { if (closeTimer) clearTimeout(closeTimer); }
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
  return async (sessionId, onConsole, onSpawned, onPageEvent) => {
    if (!executable) {
      throw new Error("host browser is unavailable; set PONDEROSA_BROWSER_EXECUTABLE to a Chromium/Chrome binary");
    }
    const profileDir = path.join(dataDir, "browser-sessions", sessionId);
    return ChromeCdpDriver.create(executable, profileDir, onConsole, onSpawned, onPageEvent);
  };
}
