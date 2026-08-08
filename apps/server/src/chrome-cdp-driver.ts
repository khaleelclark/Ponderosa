import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { terminateProcessGroup } from "@ponderosa/engines";
import { redactBrowserText } from "./browser-security.js";

const VIEWPORT = { width: 1280, height: 720 } as const;
const MAX_SNAPSHOT_TEXT = 16_000;
const MAX_BROWSER_LAUNCH_ERROR = 4_000;

export class BrowserDriverActionError extends Error {
  constructor(
    readonly reason: "invalid_selector" | "selector_not_found" | "selector_not_editable",
  ) {
    super(reason);
    this.name = "BrowserDriverActionError";
  }
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
    const result = await this.evaluate<
      { status: "ok"; x: number; y: number }
      | { status: "invalid_selector" | "selector_not_found" }
    >(`(() => {
      let el;
      try { el = document.querySelector(${JSON.stringify(selector)}); }
      catch { return {status:'invalid_selector'}; }
      if (!el) return {status:'selector_not_found'};
      el.scrollIntoView({block:'center',inline:'center'});
      const r=el.getBoundingClientRect();
      return {status:'ok',x:r.left+r.width/2,y:r.top+r.height/2};
    })()`);
    if (result.status !== "ok") throw new BrowserDriverActionError(result.status);
    return { x: result.x, y: result.y };
  }

  async click(selector: string): Promise<BrowserPageInfo> {
    const point = await this.selectorPoint(selector);
    await this.pointer(point.x, point.y);
    return this.pageInfo();
  }

  async fill(selector: string, text: string): Promise<BrowserPageInfo> {
    const result = await this.evaluate<"ok" | "invalid_selector" | "selector_not_found" | "selector_not_editable">(`(() => {
      let el;
      try { el=document.querySelector(${JSON.stringify(selector)}); }
      catch { return 'invalid_selector'; }
      if (!el) return 'selector_not_found';
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return 'selector_not_editable';
      el.focus();
      if ('value' in el) { el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); }
      else { el.textContent=''; }
      return 'ok';
    })()`);
    if (result !== "ok") throw new BrowserDriverActionError(result);
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
