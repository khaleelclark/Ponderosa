import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { RuntimeProcessIdentity, BrowserViewportSize, BrowserActivityDto } from "@ponderosa/core";
import { processGroupAlive, runtimeProcessIdentity, spawnWindowsContainedProcess, terminateProcessGroup, type NativeProcessTreeAuthority } from "@ponderosa/engines";
import { redactBrowserText } from "./browser-security.js";
import { connectPlaywrightMechanics } from "./playwright-browser-mechanics.js";
import type { BrowserProtocolConnection } from "./approved-chrome-connection.js";
import { recordHostedDisplayProcess, reserveHostedDisplay } from "./browser-session-residue.js";

const VIEWPORT = { width: 1280, height: 720 } as const;
export const MAX_BROWSER_TABS = 30;
const MAX_BROWSER_LAUNCH_ERROR = 4_000;

export interface BrowserRuntimeCapabilities {
  multiPage: boolean;
  fileUpload: boolean;
  hostedHeaded: boolean;
  persistentProfiles: boolean;
}

export function browserRuntimeCapabilities(env: NodeJS.ProcessEnv = process.env): BrowserRuntimeCapabilities {
  return {
    multiPage: env.PONDEROSA_BROWSER_MULTI_PAGE === "1" || env.NODE_ENV === "development",
    fileUpload: env.PONDEROSA_BROWSER_FILE_UPLOAD === "1" || env.NODE_ENV === "development",
    hostedHeaded: env.PONDEROSA_BROWSER_HOSTED_HEADED !== "0" && Boolean(findVirtualDisplayExecutable(env.PONDEROSA_BROWSER_XVFB_EXECUTABLE)),
    persistentProfiles: true,
  };
}

export interface BrowserDriverLaunchOptions {
  /** Cancels an in-flight launch before it can retain browser authority. */
  signal?: AbortSignal;
  /** Overrides the disposable per-session profile directory. */
  profileDir?: string;
  /** Trusted profile contents survive ordinary browser close and restart. */
  retainProfile?: boolean;
  /** Request a host display backed headed Chrome process. */
  hostedHeaded?: boolean;
  /** Internal adapter selection; does not alter browser ownership. */
  playwright?: boolean;
  nativeManual?: boolean;
  /** Attach the owned native Chrome immediately for the Ponderosa page view. */
  connectOnOpen?: boolean;
  initialUrl?: string;
  /** Explicitly relaxes Chrome isolation for constrained test containers only. */
  disableSandbox?: boolean;
}

export class BrowserDriverActionError extends Error {
  constructor(
    readonly reason: "invalid_selector" | "selector_not_found" | "selector_ambiguous" | "selector_not_interactable" | "click_unconfirmed" | "fill_unconfirmed" | "selector_not_editable" | "page_not_found" | "last_page" | "upload_disabled" | "selector_not_file_input" | "file_input_disabled" | "file_type_not_accepted" | "no_pending_file_chooser" | "stale_file_chooser" | "unsupported_file_chooser" | "stale_upload_context" | "upload_verification_failed",
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
  loading?: boolean;
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
  type: "page_open" | "page_activate" | "page_close" | "page_navigate" | "page_info" | "page_limit" | "file_chooser_open" | "file_chooser_clear";
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
  /** Release app access while a separately supervised service retains Chrome. */
  suspend?(chooserAlreadyCancelled?: boolean): Promise<void>;
  openLink?(url: string): Promise<void>;
  manualState?(): "manual" | "connecting" | "automation";
  manualSocket?(readOnly?: boolean): string;
  resizeDesktop?(size: BrowserViewportSize): Promise<void>;
  pauseAutomation?(): Promise<void>;
  resumeAutomation?(): Promise<void>;
  paused?(): boolean;
  controlRevision?(): number;
  pageInfo(): Promise<BrowserPageInfo>;
  pages(): Promise<BrowserPagesInfo>;
  activatePage(pageId: string): Promise<BrowserPagesInfo>;
  closePage(pageId: string): Promise<BrowserPagesInfo>;
  upload(input: BrowserUploadInput): Promise<BrowserUploadResult>;
  clearUploadedFiles(pageId?: string, uploadId?: string): Promise<void>;
  cancelPendingFileChooser(reason?: string): Promise<void>;
  navigate(url: string): Promise<BrowserPageInfo>;
  inspect(selector?: string): Promise<string>;
  click(selector: string): Promise<BrowserPageInfo>;
  fill(selector: string, text: string): Promise<BrowserPageInfo>;
  key(key: string): Promise<BrowserPageInfo>;
  pointer(x: number, y: number): Promise<BrowserPageInfo>;
  type(text: string): Promise<BrowserPageInfo>;
  scroll(deltaX: number, deltaY: number): Promise<BrowserPageInfo>;
  capture(pageId?: string): Promise<Buffer>;
  /** Bounded, JPEG page pixels for the live operator view; evidence stays PNG. */
  preview?(pageId?: string): Promise<{ data: string; sequence: number }>;
  newPage?(): Promise<BrowserPagesInfo>;
  resizeViewport?(pageId: string, size: BrowserViewportSize): Promise<void>;
  viewport?(pageId?: string): BrowserViewportSize;
  activity?(): BrowserActivityDto | undefined;
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
  launch?: BrowserDriverLaunchOptions,
) => Promise<BrowserDriver>;

export interface HostedDisplay {
  child: ChildProcess;
  display: string;
  reservationPath: string;
}

function findVirtualDisplayExecutable(configured = process.env.PONDEROSA_BROWSER_XVFB_EXECUTABLE): string | undefined {
  const candidates = [
    configured && path.isAbsolute(configured) ? configured : undefined,
    "/usr/bin/Xvfb",
    "/usr/local/bin/Xvfb",
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate));
}

function throwIfLaunchAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("browser launch cancelled");
}

async function waitForDisplay(child: ChildProcess, displayNumber: number, signal?: AbortSignal): Promise<void> {
  const socket = `/tmp/.X11-unix/X${displayNumber}`;
  const deadline = Date.now() + 5_000;
  let spawnError: Error | undefined;
  child.on("error", (error) => { spawnError = error; });
  while (Date.now() < deadline) {
    throwIfLaunchAborted(signal);
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("host browser display exited during startup");
    }
    if (existsSync(socket)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("host browser display did not become ready");
}

export async function spawnHostedDisplay(
  executable: string,
  publish?: (display: HostedDisplay) => boolean,
  size: { width: number; height: number } = VIEWPORT,
  signal?: AbortSignal,
): Promise<HostedDisplay> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    throwIfLaunchAborted(signal);
    const displayNumber = 100 + Math.floor(Math.random() * 900);
    const reservationPath = await reserveHostedDisplay(displayNumber);
    if (!reservationPath) continue;
    if (existsSync(`/tmp/.X${displayNumber}-lock`) || existsSync(`/tmp/.X11-unix/X${displayNumber}`)) {
      await fs.rm(reservationPath, { force: true });
      continue;
    }
    const child = spawn(executable, [
      `:${displayNumber}`,
      "-screen", "0", `${size.width}x${size.height}x24`,
      "-nolisten", "tcp", "-noreset",
    ], {
      stdio: ["ignore", "ignore", "pipe"],
      env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "LANG", "LC_ALL"]
        .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!] as const])),
      detached: process.platform !== "win32",
    });
    const hostedDisplay = { child, display: `:${displayNumber}`, reservationPath };
    let externallyOwned = false;
    try {
      recordHostedDisplayProcess(reservationPath, child);
      // A detached Xvfb is durable process authority as soon as spawn returns.
      // Publish it before readiness polling so restart recovery can terminate
      // it even if this daemon exits during waitForDisplay().
      externallyOwned = publish?.(hostedDisplay) ?? false;
      await waitForDisplay(child, displayNumber, signal);
      return hostedDisplay;
    } catch (error) {
      if (externallyOwned) throw error;
      let cleanupError: unknown;
      try {
        await terminateBrowserProcess(child);
        if (processGroupAlive(child)) throw new Error("host browser display process exit was not confirmed");
        await fs.rm(reservationPath, { force: true });
      } catch (candidate) {
        cleanupError = candidate;
      }
      if (cleanupError) {
        throw new AggregateError([error, cleanupError], "host browser display readiness and cleanup failed");
      }
    }
  }
  throw new Error("host browser display capacity is unavailable");
}

interface CdpReply {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
}

async function terminateBrowserProcess(child: ChildProcess, nativeAuthority?: NativeProcessTreeAuthority): Promise<void> {
  await terminateProcessGroup(child, {
    label: "browser",
    termGraceMs: 2_000,
    killConfirmationMs: 2_000,
  }, nativeAuthority);
}

async function waitForBrowserProcessExit(child: ChildProcess, timeoutMs: number, nativeAuthority?: NativeProcessTreeAuthority): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while ((nativeAuthority?.isAlive() ?? processGroupAlive(child)) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return !(nativeAuthority?.isAlive() ?? processGroupAlive(child));
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
  private readonly closeListeners = new Set<() => void>();

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

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
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
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
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
  loadingFrames?: Set<string>;
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

interface BrowserPreviewStream {
  sessionId: string;
  sequence: number;
  data?: string;
  starting?: Promise<void>;
  idleTimer?: NodeJS.Timeout;
  waiters: Set<() => void>;
}

export class ChromeCdpDriver implements BrowserDriver {
  private readonly previewStreams = new Map<string, BrowserPreviewStream>();
  private readonly previewStops = new Map<string, Promise<void>>();
  private previewSequence = 0;

  private acceptPreviewFrame(message: CdpReply): boolean {
    if (message.method !== "Page.screencastFrame") return false;
    const sessionId = message.sessionId;
    const frameSessionId = message.params?.sessionId;
    if (sessionId && Number.isSafeInteger(frameSessionId)) {
      void this.connection.send("Page.screencastFrameAck", { sessionId: frameSessionId }, sessionId).catch(() => undefined);
    }
    const pageId = sessionId ? this.pageIdBySession.get(sessionId) : undefined;
    const stream = pageId ? this.previewStreams.get(pageId) : undefined;
    const data = message.params?.data;
    if (!stream || stream.sessionId !== sessionId || typeof data !== "string" || data.length > 16 * 1024 * 1024) return true;
    stream.data = data;
    stream.sequence = ++this.previewSequence;
    for (const wake of stream.waiters) wake();
    stream.waiters.clear();
    return true;
  }

  private stopPreview(pageId: string): Promise<void> {
    const stopping = this.previewStops.get(pageId);
    if (stopping) return stopping;
    const stream = this.previewStreams.get(pageId);
    if (!stream) return Promise.resolve();
    this.previewStreams.delete(pageId);
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    for (const wake of stream.waiters) wake();
    stream.waiters.clear();
    const task = (async () => {
      await stream.starting?.catch(() => undefined);
      await this.connection.send("Page.stopScreencast", {}, stream.sessionId).catch(() => undefined);
    })();
    this.previewStops.set(pageId, task);
    void task.finally(() => { if (this.previewStops.get(pageId) === task) this.previewStops.delete(pageId); });
    return task;
  }

  async preview(pageId?: string): Promise<{ data: string; sequence: number }> {
    const page = pageId ? this.pagesById.get(pageId) : this.currentPage();
    if (!page?.initialized || this.closing) throw new BrowserDriverActionError("page_not_found");
    await this.previewStops.get(page.pageId);
    if (this.pagesById.get(page.pageId) !== page || this.closing) throw new BrowserDriverActionError("page_not_found");
    let stream = this.previewStreams.get(page.pageId);
    if (!stream) {
      stream = { sessionId: page.cdpSessionId, sequence: 0, waiters: new Set() };
      this.previewStreams.set(page.pageId, stream);
      // The browser still lays out and accepts input in CSS pixels. On a
      // bandwidth-constrained remote view, encoding those pixels at 2x makes
      // phone viewers decode four times as many pixels as they can display.
      // Keep the existing 2x behavior by default; qualify 1x on a disposable
      // sandbox before changing the shipped default.
      const previewScale = process.env.PONDEROSA_BROWSER_PREVIEW_SCALE === "1" ? 1 : 2;
      const width = Math.min(5120, this.viewport(page.pageId).width * previewScale);
      const height = Math.min(3200, this.viewport(page.pageId).height * previewScale);
      stream.starting = (async () => {
        await this.connection.send("Page.bringToFront", {}, page.cdpSessionId);
        await this.connection.send("Page.startScreencast", {
          format: "jpeg", quality: 75, maxWidth: width, maxHeight: height, everyNthFrame: 1,
        }, page.cdpSessionId);
      })();
    }
    const current = stream;
    if (current.idleTimer) clearTimeout(current.idleTimer);
    current.idleTimer = setTimeout(() => { void this.stopPreview(page.pageId); }, 3_000);
    current.idleTimer.unref();
    try {
      await current.starting;
      if (!current.data) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { current.waiters.delete(wake); reject(new Error("Browser preview did not paint.")); }, 2_000);
          timer.unref();
          const wake = () => { clearTimeout(timer); resolve(); };
          current.waiters.add(wake);
          if (current.data || this.previewStreams.get(page.pageId) !== current) wake();
        });
      }
      if (this.previewStreams.get(page.pageId) !== current || !current.data) throw new Error("Browser preview changed.");
      return { data: current.data, sequence: current.sequence };
    } catch (error) {
      if (this.previewStreams.get(page.pageId) === current) await this.stopPreview(page.pageId);
      throw error;
    }
  }
  private readonly frameReferences = new Map<string, { frame: import("playwright-core").Frame; targetId: string; url: string }>();

  private async actionLocator(selector: string) {
    const page = this.currentPage();
    if (!this.playwright) throw new Error("Browser frame controls require Playwright.");
    const reference = /^frame:([a-f0-9-]{36}) >> ([\s\S]+)$/.exec(selector);
    if (!reference) {
      const selected = await this.playwright.page(page.targetId);
      // CDP can publish a popup and its DOM before Playwright has settled the
      // corresponding main-frame navigation. A bare load-state wait can
      // succeed on the popup's initial about:blank document, then leave fill
      // waiting on a different frame. Bind readiness to the inspected URL.
      if (page.openerPageId && page.url !== "about:blank") {
        const expectedUrl = page.url;
        await selected.waitForURL(url => url.href === expectedUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
      } else {
        await selected.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      }
      return selected.locator(selector);
    }
    const entry = this.frameReferences.get(reference[1]!);
    if (!entry || entry.targetId !== page.targetId || entry.frame.isDetached() || entry.frame.url() !== entry.url) throw new Error("Embedded frame changed. Inspect the page again.");
    await entry.frame.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    if (entry.frame.isDetached() || entry.frame.url() !== entry.url) throw new Error("Embedded frame changed. Inspect the page again.");
    return entry.frame.locator(reference[2]!);
  }
  private async uniqueActionLocator(selector: string) {
    let locator: Awaited<ReturnType<ChromeCdpDriver["actionLocator"]>>;
    try { locator = await this.actionLocator(selector); }
    catch { throw new BrowserDriverActionError("selector_not_interactable"); }
    let count: number;
    try { count = await locator.count(); }
    catch { throw new BrowserDriverActionError("invalid_selector"); }
    if (count === 0) {
      try { await locator.first().waitFor({ state: "attached", timeout: 10_000 }); }
      catch { throw new BrowserDriverActionError("selector_not_found"); }
      try { count = await locator.count(); }
      catch { throw new BrowserDriverActionError("invalid_selector"); }
    }
    if (count === 0) throw new BrowserDriverActionError("selector_not_found");
    if (count > 1) throw new BrowserDriverActionError("selector_ambiguous");
    return locator;
  }
  private readonly viewportSizes = new Map<string, BrowserViewportSize>();
  private lastActivity?: BrowserActivityDto;
  viewport(pageId = this.activePageId): BrowserViewportSize { return this.viewportSizes.get(pageId) ?? VIEWPORT; }
  activity(): BrowserActivityDto | undefined { return this.lastActivity; }
  async resizeViewport(pageId: string, size: BrowserViewportSize): Promise<void> {
    const page = this.pagesById.get(pageId);
    if (!page?.initialized) throw new BrowserDriverActionError("page_not_found");
    await this.stopPreview(pageId);
    if (this.playwright) await (await this.playwright.page(page.targetId)).setViewportSize(size);
    // The lifecycle observer also owns an emulation session. Keep both sessions
    // aligned so capture, DOM layout and Playwright input share one geometry.
    await this.connection.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2, mobile: false }, page.cdpSessionId);
    this.viewportSizes.set(pageId, { ...size });
    this.lastActivity = undefined;
  }
  async newPage(): Promise<BrowserPagesInfo> {
    await this.eventQueue;
    if (!this.multiPageEnabled || this.pagesById.size >= MAX_BROWSER_TABS) throw new Error("Browser tab limit reached (30 tabs).");
    const result = await this.connection.send("Target.createTarget", { url: "about:blank" });
    const deadline = Date.now() + 5_000;
    while (!this.pagesById.get(this.pageIdByTarget.get(String(result.targetId)) ?? "")?.initialized && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      await this.eventQueue;
    }
    const id = this.pageIdByTarget.get(String(result.targetId));
    if (!id) throw new Error("The new browser tab could not be opened.");
    return this.activatePage(id);
  }
  private playwright?: Awaited<ReturnType<typeof connectPlaywrightMechanics>>;
  private readonly pagesById = new Map<string, ManagedBrowserPage>();
  private readonly pageIdByTarget = new Map<string, string>();
  private readonly pageIdBySession = new Map<string, string>();
  private readonly tombstones = new Set<string>();
  private readonly inspectionCache = new Map<string, { regions: Record<string, string>; characters: Record<string, number> }>();
  private activePageId = "";
  private closing = false;
  private lifecycleGeneration = 1;
  private recentInteraction?: { pageId: string; targetId: string; at: number; generation: number; consumed: boolean };
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly uploadedInputs = new Map<string, Array<{
    uploadId: string;
    cdpSessionId: string;
    reference: { nodeId?: number; backendNodeId?: number; objectId?: string };
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
    private readonly display: HostedDisplay | undefined,
    private readonly connection: BrowserProtocolConnection,
    private readonly profileDir: string,
    private readonly retainProfile: boolean,
    private readonly onConsole: Parameters<BrowserDriverFactory>[1],
    private readonly onPageEvent: Parameters<BrowserDriverFactory>[3],
    private readonly multiPageEnabled: boolean,
    private readonly uploadEnabled: boolean,
    readonly terminationAuthority: object,
    readonly processIdentity: RuntimeProcessIdentity | undefined,
    private readonly nativeProcessAuthority?: NativeProcessTreeAuthority,
  ) {}

  isAlive(): boolean {
    return (this.nativeProcessAuthority?.isAlive() ?? processGroupAlive(this.child)) || Boolean(this.display && processGroupAlive(this.display.child));
  }

  static async create(
    executable: string,
    profileDir: string,
    onConsole: Parameters<BrowserDriverFactory>[1],
    onSpawned?: Parameters<BrowserDriverFactory>[2],
    onPageEvent?: Parameters<BrowserDriverFactory>[3],
    launch: BrowserDriverLaunchOptions = {},
  ): Promise<ChromeCdpDriver> {
    throwIfLaunchAborted(launch.signal);
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    throwIfLaunchAborted(launch.signal);
    const hostedHeaded = launch.hostedHeaded !== false && process.env.PONDEROSA_BROWSER_HOSTED_HEADED !== "0";
    const displayExecutable = hostedHeaded ? findVirtualDisplayExecutable() : undefined;
    // Hosts without the packaged display service keep the existing isolated
    // headless browser available and advertise hostedHeaded=false. Hosted
    // deployments include Xvfb, so clients never need local browser software.
    const terminationAuthority = {};
    let display: HostedDisplay | undefined;
    let child: ChildProcess | undefined;
    let nativeProcessAuthority: NativeProcessTreeAuthority | undefined;
    const closeAll = async (): Promise<void> => {
      const failures: unknown[] = [];
      if (child) await terminateBrowserProcess(child, nativeProcessAuthority).catch((error) => failures.push(error));
      if (display) {
        await terminateBrowserProcess(display.child).catch((error) => failures.push(error));
        if (!processGroupAlive(display.child)) {
          await fs.rm(display.reservationPath, { force: true }).catch((error) => failures.push(error));
        }
      }
      if (!launch.retainProfile) await removeBrowserProfile(profileDir).catch((error) => failures.push(error));
      if (failures.length) throw new AggregateError(failures, "host browser cleanup did not complete");
    };
    let externallyOwned = false;
    if (displayExecutable) {
      display = await spawnHostedDisplay(displayExecutable, (spawned) => {
        display = spawned;
        if (!onSpawned) return false;
        const displayHandle: BrowserTerminationHandle = {
          terminationAuthority,
          processIdentity: runtimeProcessIdentity(spawned.child),
          isAlive: () => processGroupAlive(spawned.child),
          close: closeAll,
        };
        onSpawned(displayHandle);
        externallyOwned = true;
        return true;
      }, VIEWPORT, launch.signal);
    }
    throwIfLaunchAborted(launch.signal);
    try {
      const disableSandbox = launch.disableSandbox ||
        process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1";
      const browserArgs = [
        ...(!display ? ["--headless=new"] : []), "--remote-debugging-pipe", `--user-data-dir=${profileDir}`,
        ...(disableSandbox ? ["--no-sandbox"] : []),
        // Playwright's normal launch disables BFCache so history navigation
        // produces the lifecycle signals its navigation waits consume.
        ...(launch.playwright ? ["--disable-back-forward-cache", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"] : []),
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, "--no-first-run",
        "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
        "--disable-dev-shm-usage", "--disable-features=Translate,OptimizationHints", "about:blank",
      ];
      const browserEnv = {
          ...Object.fromEntries([
            "PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "LANG", "LC_ALL",
            ...(process.platform === "win32" ? ["SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] : []),
          ]
            .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!] as const])),
          ...(display ? { DISPLAY: display.display } : {}),
      };
      if (process.platform === "win32") {
        const contained = spawnWindowsContainedProcess({
          bin: executable, args: browserArgs, cwd: profileDir,
          env: browserEnv, stdin: "pipe", browserPipe: true,
        });
        child = contained.child;
        nativeProcessAuthority = contained.authority;
      } else {
        child = spawn(executable, browserArgs, {
          stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
          env: browserEnv,
          detached: true,
        });
      }
    } catch (error) {
      if (!externallyOwned) await closeAll();
      throw error;
    }
    let launchError = "";
    child.on("error", (error) => { launchError = `${launchError}${error.message}`.slice(-MAX_BROWSER_LAUNCH_ERROR); });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { launchError = `${launchError}${chunk}`.slice(-MAX_BROWSER_LAUNCH_ERROR); });
    try {
      if (onSpawned) {
        const browserHandle: BrowserTerminationHandle = {
          terminationAuthority,
          processIdentity: runtimeProcessIdentity(child),
          isAlive: () => nativeProcessAuthority?.isAlive() ?? processGroupAlive(child!),
          close: closeAll,
        };
        onSpawned(browserHandle, { complete: true, coversReturnedDriver: true });
        externallyOwned = true;
      }
      throwIfLaunchAborted(launch.signal);
      const input = (nativeProcessAuthority ? child.stdin : child.stdio[3]) as Writable | null;
      const output = (nativeProcessAuthority ? child.stdout : child.stdio[4]) as Readable | null;
      if (!input || !output) throw new Error("browser debugging pipe could not be created");
      const connection = new CdpConnection(input, output);
      const capabilities = browserRuntimeCapabilities();
      const processIdentity = runtimeProcessIdentity(child);
      const driver = new ChromeCdpDriver(
        child, display, connection, profileDir, Boolean(launch.retainProfile), onConsole, onPageEvent,
        capabilities.multiPage,
        capabilities.fileUpload,
        terminationAuthority, processIdentity, nativeProcessAuthority,
      );
      let removeAbortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        const cancel = () => reject(new Error("browser launch cancelled"));
        if (launch.signal?.aborted) cancel();
        else if (launch.signal) {
          launch.signal.addEventListener("abort", cancel, { once: true });
          removeAbortListener = () => launch.signal?.removeEventListener("abort", cancel);
        }
      });
      try {
        await Promise.race([driver.initialize(launch.playwright === true), aborted]);
      } finally {
        removeAbortListener?.();
      }
      throwIfLaunchAborted(launch.signal);
      return driver;
    } catch (error) {
      if (!externallyOwned) await closeAll();
      const primary = error instanceof Error ? error.message : String(error);
      const diagnostics = redactBrowserText(launchError.trim());
      throw new Error(diagnostics ? `${primary}\n${diagnostics}` : primary);
    }
  }

  static async attachOwned(child: ChildProcess, display: HostedDisplay, connection: BrowserProtocolConnection, profileDir: string, onConsole: Parameters<BrowserDriverFactory>[1], onPageEvent: Parameters<BrowserDriverFactory>[3], authority: object): Promise<ChromeCdpDriver> {
    const capabilities = browserRuntimeCapabilities();
    const targets = await connection.send("Target.getTargets");
    const pages = Array.isArray(targets.targetInfos) ? targets.targetInfos.filter(value => value && typeof value === "object" && (value as Record<string, unknown>).type === "page") : [];
    // Existing user tabs are not disposable launch targets. Until admission is
    // upgraded, decline attachment rather than pruning a manual browser.
    if (pages.length > (capabilities.multiPage ? MAX_BROWSER_TABS : 1)) throw new Error("Too many tabs for automation (30 maximum). Your browser remains open in manual mode.");
    const driver = new ChromeCdpDriver(child, display, connection, profileDir, true, onConsole, onPageEvent, capabilities.multiPage, capabilities.fileUpload, authority, runtimeProcessIdentity(child));
    await driver.initialize(true);
    return driver;
  }

  detachMechanics(): void {
    this.closing = true;
    this.lifecycleGeneration++;
    for (const pageId of this.previewStreams.keys()) void this.stopPreview(pageId);
    this.clearPendingChooser("manual_control");
    this.playwright?.close();
  }

  private async initialize(usePlaywright: boolean): Promise<void> {
      const driver = this, connection = this.connection;
      connection.onEvent((message) => {
        if (!driver.acceptPreviewFrame(message)) driver.enqueueEvent(message);
      });
      await connection.send("Target.setDiscoverTargets", { discover: true });
      if (driver.multiPageEnabled && !usePlaywright) {
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
      // Target discovery can race the explicit target scan. In that case the
      // page is registered before its CDP domains are ready, so wait for the
      // shared lifecycle queue before exposing the session as usable.
      await driver.eventQueue;
      if (!driver.pagesById.size) {
        const created = await connection.send("Target.createTarget", initialBrowserTargetRequest());
        const targetId = String(created.targetId ?? "");
        if (!targetId) throw new Error("browser did not create a page target");
        await driver.attachTarget({ targetId, type: "page", url: "about:blank", title: "" });
      }
      await driver.eventQueue;
      if (!driver.activePageId) driver.activateFallback();
      driver.emitPageEvent("page_activate", driver.activePageId, undefined, false, "initial");
      if (usePlaywright) driver.playwright = await connectPlaywrightMechanics(connection);
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
          this.emitPageEvent("page_info", page.pageId);
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
    if ((message.method === "Page.frameStartedLoading" || message.method === "Page.frameStoppedLoading") && message.sessionId) {
      const page = this.pagesById.get(this.pageIdBySession.get(message.sessionId) ?? "");
      if (page && typeof params.frameId === "string") {
        page.loadingFrames ??= new Set();
        if (message.method === "Page.frameStartedLoading") page.loadingFrames.add(params.frameId);
        else page.loadingFrames.delete(params.frameId);
        this.emitPageEvent("page_info", page.pageId);
      }
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
    if (this.pagesById.size >= MAX_BROWSER_TABS) {
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
    if (this.pagesById.size >= MAX_BROWSER_TABS) {
      await this.connection.send("Target.detachFromTarget", { sessionId: cdpSessionId }).catch(() => undefined);
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
          width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 2, mobile: false,
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
    void this.stopPreview(pageId);
    this.pagesById.delete(pageId);
    this.viewportSizes.delete(pageId);
    if (this.lastActivity?.pageId === pageId) this.lastActivity = undefined;
    this.pageIdByTarget.delete(page.targetId);
    this.pageIdBySession.delete(page.cdpSessionId);
    this.uploadedInputs.delete(pageId);
    this.inspectionCache.delete(pageId);
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
        loading: Boolean(page.loadingFrames?.size),
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
    if (this.playwright) {
      await (await this.playwright.page(page.targetId)).goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      return this.refreshPage(page);
    }
    await this.connection.send("Page.navigate", { url }, page.cdpSessionId);
    await new Promise((resolve) => setTimeout(resolve, 250));
    return this.refreshPage(page);
  }

  async inspect(regionSelector?: string): Promise<string> {
    const page = this.currentPage();
    if (regionSelector?.startsWith("frame:")) {
      const locator = await this.actionLocator(regionSelector);
      const text = await locator.first().innerText({ timeout: 5000 });
      return JSON.stringify({ url: (await this.pageInfo()).url, requestedRegion: { selector: regionSelector, error: null },
        changedRegions: [{ id: regionSelector, kind: "requested", text: redactBrowserText(text.slice(0, 4200)), truncated: text.length > 4200, originalCharacters: text.length }],
        _ponderosa: { scope: "requested_frame_region" } });
    }
    const snapshot = await this.evaluate<{
      url: string;
      title: string;
      viewport: { width: number; height: number; scrollX: number; scrollY: number };
      regions: Array<{ id: string; kind: string; label: string; text: string; truncated: boolean; originalCharacters: number }>;
      controls: Array<Record<string, string | number | boolean | null>>;
      requestedRegion: { selector: string | null; error: string | null };
      truncation: { regionCharacters: number; regionLimit: number; controlsReturned: number; controlLimit: number };
    }>(`(() => {
      const requestedSelector = ${JSON.stringify(regionSelector ?? null)};
      const REGION_LIMIT = 4200;
      const CONTROL_LIMIT = 80;
      const viewport = { width: innerWidth, height: innerHeight, scrollX, scrollY };
      const rendered = (el) => {
        if (!(el instanceof Element) || el.closest('[aria-hidden="true"],[inert]')) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const intersectsViewport = (el) => {
        if (!rendered(el)) return false;
        const r = el.getBoundingClientRect();
        return r.bottom >= 0 && r.right >= 0 && r.top <= innerHeight && r.left <= innerWidth;
      };
      const uniqueSelector = (candidate) => {
        try { return document.querySelectorAll(candidate).length === 1 ? candidate : null; } catch { return null; }
      };
      const stableSelector = (el) => {
        const durable = ['data-agent-id','data-resource-id','data-project-id','data-conversation-id','data-trigger-id','data-artifact-id','data-testid'];
        for (const attr of durable) {
          const value = el.getAttribute(attr);
          if (value) {
            const candidate = '[' + attr + '=' + JSON.stringify(value) + ']';
            const unique = uniqueSelector(candidate);
            if (unique) return { selector: unique, identityKind: attr.slice(5) };
          }
        }
        if (el.id) {
          const unique = uniqueSelector('#' + CSS.escape(el.id));
          if (unique) return { selector: unique, identityKind: 'id' };
        }
        const tag = el.tagName.toLowerCase();
        const name = el.getAttribute('name');
        if (name) {
          const unique = uniqueSelector(tag + '[name=' + JSON.stringify(name) + ']');
          if (unique) return { selector: unique, identityKind: 'name' };
        }
        const href = el instanceof HTMLAnchorElement ? el.getAttribute('href') : null;
        if (href) {
          const unique = uniqueSelector('a[href=' + JSON.stringify(href) + ']');
          if (unique) return { selector: unique, identityKind: 'href' };
        }
        const aria = el.getAttribute('aria-label');
        if (aria) {
          const unique = uniqueSelector(tag + '[aria-label=' + JSON.stringify(aria) + ']');
          if (unique) return { selector: unique, identityKind: 'aria-label' };
        }
        const owner = el.closest('[data-agent-id],[data-resource-id],[data-project-id],[data-conversation-id],[data-trigger-id],[data-artifact-id],[data-testid]');
        if (owner && owner !== el) {
          for (const attr of durable) {
            const ownerValue = owner.getAttribute(attr);
            if (!ownerValue) continue;
            const ownerSelector = '[' + attr + '=' + JSON.stringify(ownerValue) + ']';
            const localAria = el.getAttribute('aria-label');
            if (localAria) {
              const candidate = ownerSelector + ' ' + tag + '[aria-label=' + JSON.stringify(localAria) + ']';
              const unique = uniqueSelector(candidate);
              if (unique) return { selector: unique, identityKind: attr.slice(5) + '-action' };
            }
          }
        }
        return { selector: null, identityKind: 'unaddressable' };
      };
      const textFrom = (root, visibleOnly = true) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const pieces = [];
        let originalCharacters = 0;
        let currentLength = 0;
        let node;
        while ((node = walker.nextNode())) {
          const value = (node.nodeValue || '').replace(/\\s+/g, ' ').trim();
          if (!value || !rendered(node.parentElement) || (visibleOnly && !intersectsViewport(node.parentElement))) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          if (visibleOnly && (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth)) continue;
          originalCharacters += value.length + (pieces.length ? 1 : 0);
          if (currentLength < REGION_LIMIT) {
            pieces.push(value);
            currentLength += value.length + 1;
          }
        }
        const joined = pieces.join(' ');
        return { text: joined.slice(0, REGION_LIMIT), truncated: originalCharacters > REGION_LIMIT, originalCharacters };
      };
      const regionRoots = [];
      const addRegions = (selector, kind) => {
        [...document.querySelectorAll(selector)].filter(intersectsViewport).forEach((root, index) => {
          if (regionRoots.some((entry) => entry.root === root)) return;
          const label = root.getAttribute('aria-label') || root.getAttribute('data-testid') || root.getAttribute('id') || kind;
          regionRoots.push({ root, kind, id: kind + ':' + label + ':' + index, label, visibleOnly: true });
        });
      };
      addRegions('dialog,[role=dialog],[role=alertdialog]', 'dialog');
      addRegions('nav,[role=navigation]', 'navigation');
      addRegions('main,[role=main]', 'main');
      if (!regionRoots.some((entry) => entry.kind === 'main') && document.body) {
        regionRoots.push({ root: document.body, kind: 'viewport', id: 'viewport:body:0', label: 'Visible viewport', visibleOnly: true });
      }
      let requestedRegionError = null;
      let requestedRoot = null;
      if (requestedSelector) {
        try {
          requestedRoot = document.querySelector(requestedSelector);
          if (requestedRoot && !rendered(requestedRoot)) {
            requestedRoot = null;
            requestedRegionError = 'selector_not_visible';
          } else if (requestedRoot) {
            regionRoots.push({ root: requestedRoot, kind: 'requested', id: 'requested:' + requestedSelector, label: requestedSelector, visibleOnly: false });
          } else {
            requestedRegionError = 'selector_not_found';
          }
        } catch {
          requestedRegionError = 'invalid_selector';
        }
      }
      const regions = regionRoots.map((entry) => ({ id: entry.id, kind: entry.kind, label: entry.label, ...textFrom(entry.root, entry.visibleOnly) }));
      const controlSelector = 'a[href],button,input,textarea,select,[contenteditable=true],[role=button],[role=link],[role=checkbox],[role=menuitem],[role=tab],[role=combobox],[role=option],[role=radio],[role=switch],[role=spinbutton],[role=slider],[tabindex]';
      const controlRoot = requestedRoot || document;
      const controls = [...(requestedRoot?.matches(controlSelector) ? [requestedRoot] : []), ...controlRoot.querySelectorAll(controlSelector)]
        .filter(requestedRoot ? rendered : intersectsViewport)
        .slice(0, CONTROL_LIMIT)
        .map((el) => {
          const identity = stableSelector(el);
          const rect = el.getBoundingClientRect();
          const valueRedacted = el instanceof HTMLInputElement && el.type === 'password';
          return {
            controlId: identity.selector || ('unaddressable:' + (el.getAttribute('role') || el.tagName.toLowerCase()) + ':' + (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80)),
            selector: identity.selector,
            identityKind: identity.identityKind,
            addressable: Boolean(identity.selector),
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || '',
            name: (el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id=>document.getElementById(id)?.textContent || '').join(' ') || (el.labels ? [...el.labels].map(label=>label.textContent || '').join(' ') : '') || el.getAttribute('name') || el.getAttribute('placeholder') || '').trim().slice(0, 160),
            text: valueRedacted ? '[redacted]' : (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
            valueRedacted,
            disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
            x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height),
          };
        });
      return {
        url: location.href,
        title: document.title || '',
        viewport,
        regions,
        controls,
        requestedRegion: { selector: requestedSelector, error: requestedRegionError },
        truncation: {
          regionCharacters: regions.reduce((sum, region) => sum + region.originalCharacters, 0),
          regionLimit: REGION_LIMIT,
          controlsReturned: controls.length,
          controlLimit: CONTROL_LIMIT,
        },
      };
    })()`);

    const encodedRegions: Record<string, string> = {};
    const regionCharacters: Record<string, number> = {};
    for (const region of snapshot.regions) {
      encodedRegions[region.id] = JSON.stringify(region);
      regionCharacters[region.id] = encodedRegions[region.id]!.length;
    }
    const previous = this.inspectionCache.get(page.pageId);
    const changed = snapshot.regions.filter((region) => previous?.regions[region.id] !== encodedRegions[region.id]);
    const unchangedRegionIds = snapshot.regions
      .filter((region) => previous?.regions[region.id] === encodedRegions[region.id])
      .map((region) => region.id);
    const removedRegionIds = previous
      ? Object.keys(previous.regions).filter((id) => !(id in encodedRegions))
      : [];
    const uncachedCharacters = changed.reduce((sum, region) => sum + regionCharacters[region.id]!, 0);
    const cachedCharacters = unchangedRegionIds.reduce((sum, id) => sum + (regionCharacters[id] ?? 0), 0);
    this.inspectionCache.set(page.pageId, { regions: encodedRegions, characters: regionCharacters });

    const frameControls: Array<Record<string, unknown>> = [];
    const frames: Array<{ selector: string; url: string }> = [];
    if (this.playwright) {
      for (const [key, value] of this.frameReferences) if (value.frame.isDetached() || value.frame.url() !== value.url) this.frameReferences.delete(key);
      const current = await this.playwright.page(page.targetId);
      // The top document is already represented by the CDP snapshot. Asking
      // Playwright to enumerate it again can stall while a new popup settles.
      for (const frame of current.frames().filter(frame => frame !== current.mainFrame()).slice(0, 10)) {
        if (frameControls.length >= 80) break;
        let reference = [...this.frameReferences].find(([, value]) => value.frame === frame && value.targetId === page.targetId)?.[0];
        if (!reference) { reference = randomUUID(); this.frameReferences.set(reference, { frame, targetId: page.targetId, url: frame.url() }); }
        frames.push({ selector: `frame:${reference} >> body`, url: redactBrowserText(frame.url()) });
        const controls = await frame.locator('input, textarea, select, button, [contenteditable="true"]').evaluateAll(elements => elements.slice(0, 80).map((element, index) => ({
          index, tag: element.tagName.toLowerCase(), id: element.id,
          name: element.getAttribute('name') ?? '', label: element.getAttribute('aria-label') ?? element.getAttribute('placeholder') ?? (element.tagName === 'BUTTON' ? element.textContent?.slice(0, 120) : '') ?? '',
          type: element.getAttribute('type') ?? '',
        }))).catch(() => []);
        for (const control of controls.slice(0, 80 - frameControls.length)) {
          const selector = `:nth-match(input, textarea, select, button, [contenteditable="true"], ${control.index + 1})`;
          frameControls.push({ ...control, selector: `frame:${reference} >> ${selector}`, frameUrl: redactBrowserText(frame.url()), value: undefined });
        }
      }
    }
    return JSON.stringify({
      frames,
      frameControls,
      url: snapshot.url,
      title: snapshot.title,
      viewport: snapshot.viewport,
      mode: previous ? (changed.length || removedRegionIds.length ? "incremental" : "unchanged") : "full",
      changedRegions: changed,
      unchangedRegionIds,
      removedRegionIds,
      controls: snapshot.controls,
      requestedRegion: snapshot.requestedRegion,
      truncation: snapshot.truncation,
      contextUsage: {
        uncachedCharacters,
        cachedCharacters,
        returnedCharacters: JSON.stringify(changed).length + JSON.stringify(snapshot.controls).length,
      },
      _ponderosa: {
        scope: regionSelector ? "requested_region" : "visible_viewport",
        stableControlIdentity: true,
        offscreenContentOmitted: !regionSelector,
        unchangedRegionsOmitted: Boolean(previous),
      },
    }, null, 2);
  }

  private async selectorPoint(selector: string): Promise<{ x: number; y: number }> {
    const result = await this.evaluate<{ status: "ok"; x: number; y: number } | { status: "invalid_selector" | "selector_not_found" | "selector_ambiguous" | "selector_not_interactable" }>(`(async () => {
      let matches; try { matches = document.querySelectorAll(${JSON.stringify(selector)}); } catch { return {status:'invalid_selector'}; }
      if (!matches.length) return {status:'selector_not_found'};
      if (matches.length > 1) return {status:'selector_ambiguous'};
      const el = matches[0]; el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!el.isConnected) return {status:'selector_not_found'};
      const r=el.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      if (!r.width || !r.height || !hit || (hit!==el && !el.contains(hit))) return {status:'selector_not_interactable'};
      return {status:'ok',x,y};
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
    if (this.playwright) {
      const page = this.currentPage();
      const locator = await this.uniqueActionLocator(selector);
      try { await locator.scrollIntoViewIfNeeded({ timeout: 10_000 }); }
      catch { throw new BrowserDriverActionError("selector_not_interactable"); }
      let bounds: Awaited<ReturnType<typeof locator.boundingBox>>;
      try { bounds = await locator.boundingBox(); }
      catch { throw new BrowserDriverActionError("selector_not_interactable"); }
      this.markInteraction();
      try { await locator.click({ timeout: 10_000 }); }
      catch { throw new BrowserDriverActionError("click_unconfirmed"); }
      this.lastActivity = bounds ? { pageId: page.pageId, kind: "click", x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, at: Date.now() } : undefined;
      return this.pageInfo();
    }
    const point = await this.selectorPoint(selector);
    this.markInteraction();
    await this.pointer(point.x, point.y, false);
    return this.pageInfo();
  }

  async fill(selector: string, text: string): Promise<BrowserPageInfo> {
    if (this.playwright) {
      try {
        const page = this.currentPage();
        const locator = await this.uniqueActionLocator(selector);
        try { await locator.fill(text, { timeout: 10_000 }); }
        catch { throw new BrowserDriverActionError("fill_unconfirmed"); }
        // The lifecycle observer already owns this page's CDP session. For a
        // main-document CSS selector, confirm the result through that session:
        // Playwright can finish the input action on a newly opened popup while
        // its locator remains tied to a transient frame and its subsequent
        // read times out. This is observation only; never repeat an ambiguous
        // mutation. Frame and shadow selectors retain the Playwright read.
        const observed = selector.startsWith("frame:") ? null : await this.evaluateOn<{
          retained: string; bounds: { x: number; y: number; width: number; height: number };
        } | null>(page, `(() => {
          let matches;
          try { matches = document.querySelectorAll(${JSON.stringify(selector)}); } catch { return null; }
          if (matches.length !== 1 || !matches[0].isConnected) return null;
          const element = matches[0];
          const rect = element.getBoundingClientRect();
          return {
            retained: 'value' in element ? String(element.value) : element.textContent ?? '',
            bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        })()`).catch(() => null);
        const retained = observed?.retained ?? await locator.evaluate(
          (element: { value?: unknown; textContent: string | null }) => "value" in element ? String(element.value) : element.textContent ?? "",
          undefined,
          { timeout: 5_000 },
        );
        if (retained !== text) throw new Error("Field did not retain the supplied value.");
        const bounds = observed?.bounds ?? await locator.boundingBox({ timeout: 5_000 }).catch(() => null);
        this.lastActivity = bounds ? { pageId: page.pageId, kind: "fill", ...bounds, at: Date.now() } : undefined;
      } catch (error) {
        if (error instanceof BrowserDriverActionError) throw error;
        // Playwright call logs can contain the supplied value, including passwords.
        throw new BrowserDriverActionError("fill_unconfirmed");
      }
      return this.pageInfo();
    }
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
    const retained = await this.evaluate<string>(`(() => { const el=document.activeElement; return el && 'value' in el ? String(el.value) : el?.textContent ?? ''; })()`);
    if (retained !== text) throw new Error("Browser field input could not be confirmed. Check the page before retrying.");
    return this.pageInfo();
  }

  async key(key: string): Promise<BrowserPageInfo> {
    const page = this.currentPage();
    // Browser clients send Control as the platform-neutral primary shortcut.
    // Chrome on macOS uses Command/Meta for select-all, copy, and navigation.
    if (process.platform === "darwin") {
      const parts = key.split("+");
      key = parts.map((part, index) => index < parts.length - 1 && part === "Control" ? "Meta" : part).join("+");
    }
    if (this.playwright) {
      const current = await this.playwright.page(page.targetId);
      if (key === "BrowserBack") await current.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
      else if (key === "BrowserForward") await current.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 });
      else if (key === "BrowserRefresh") await current.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
      else if (Array.from(key).length === 1 && key.codePointAt(0)! > 127) await current.keyboard.insertText(key);
      else await current.keyboard.press(key);
      return this.pageInfo();
    }
    if (key === "BrowserBack" || key === "BrowserForward" || key === "BrowserRefresh") {
      if (key === "BrowserRefresh") {
        await this.connection.send("Page.reload", {}, page.cdpSessionId);
      } else {
        const history = await this.connection.send("Page.getNavigationHistory", {}, page.cdpSessionId);
        const entries = history.entries as { id: number }[];
        const index = Number(history.currentIndex) + (key === "BrowserBack" ? -1 : 1);
        const entry = entries[index];
        if (entry) await this.connection.send("Page.navigateToHistoryEntry", { entryId: entry.id }, page.cdpSessionId);
      }
      this.inspectionCache.delete(page.pageId);
      return this.pageInfo();
    }
    let modifiers = 0;
    while (/^(Control|Meta|Alt|Shift)\+/.test(key)) {
      const prefix = key.slice(0, key.indexOf("+"));
      modifiers |= { Control: 2, Meta: 4, Alt: 1, Shift: 8 }[prefix] ?? 0;
      key = key.slice(key.indexOf("+") + 1);
    }
    const codes: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
    const windowsVirtualKeyCode = codes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const text = Array.from(key).length === 1 && !(modifiers & 7) ? key : undefined;
    const params = { key, modifiers, windowsVirtualKeyCode };
    const primary = process.platform === "darwin" ? 4 : 2;
    const selectAll = (modifiers & primary) !== 0 && (modifiers & (1 | 8)) === 0 && key.toLowerCase() === "a";
    await this.connection.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...params, ...(text ? { text } : {}), ...(selectAll ? { code: "KeyA", commands: ["selectAll"] } : {}) }, page.cdpSessionId);
    await this.connection.send("Input.dispatchKeyEvent", { type: "keyUp", ...params }, page.cdpSessionId);
    return this.pageInfo();
  }

  async pointer(x: number, y: number, record = true): Promise<BrowserPageInfo> {
    this.lastActivity = { pageId: this.activePageId, kind: "click", x, y, at: Date.now() };
    if (record) this.markInteraction();
    if (this.playwright) {
      await (await this.playwright.page(this.currentPage().targetId)).mouse.click(x, y);
      return this.pageInfo();
    }
    const page = this.currentPage();
    await this.connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, page.cdpSessionId);
    await this.connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, page.cdpSessionId);
    await this.connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, page.cdpSessionId);
    return this.pageInfo();
  }

  async type(text: string): Promise<BrowserPageInfo> {
    const page = this.currentPage();
    if (this.playwright) {
      try {
        await (await this.playwright.page(page.targetId)).keyboard.insertText(text);
      } catch {
        throw new Error("Browser text input could not be confirmed. Check the page before retrying.");
      }
      return this.pageInfo();
    }
    await this.connection.send("Input.insertText", { text }, page.cdpSessionId);
    return this.pageInfo();
  }

  async scroll(deltaX: number, deltaY: number): Promise<BrowserPageInfo> {
    const page = this.currentPage();
    // Use the exact owned target rather than Playwright's independent page
    // attachment. This also matches direct operator wheel input.
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: this.viewport().width / 2, y: this.viewport().height / 2, deltaX, deltaY,
    }, page.cdpSessionId);
    return this.pageInfo();
  }

  async capture(pageId?: string): Promise<Buffer> {
    const page = pageId ? this.pagesById.get(pageId) : this.currentPage();
    if (!page?.initialized) throw new BrowserDriverActionError("page_not_found");
    // A live viewer needs the current pixels, not Playwright's screenshot
    // stability/font wait (which can stall inactive or still-loading tabs).
    // Give a never-painted background target a visible surface. This does NOT
    // change activePageId: Agent actions remain explicitly target-addressed.
    await this.connection.send("Page.bringToFront", {}, page.cdpSessionId);
    const size = this.viewport(page.pageId);
    const metrics = await this.connection.send("Page.getLayoutMetrics", {}, page.cdpSessionId);
    const visible = metrics.cssVisualViewport as { pageX?: number; pageY?: number } | undefined;
    const result = await this.connection.send("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { x: visible?.pageX ?? 0, y: visible?.pageY ?? 0, ...size, scale: 1 }, captureBeyondViewport: false }, page.cdpSessionId);
    if (typeof result.data !== "string") throw new Error("browser did not return a screenshot");
    return Buffer.from(result.data, "base64");
  }

  async upload(input: BrowserUploadInput): Promise<BrowserUploadResult> {
    if (!this.uploadEnabled) throw new BrowserDriverActionError("upload_disabled");
    await this.eventQueue;
    const page = this.currentPage();
    let nodeReference: { nodeId?: number; backendNodeId?: number };
    let objectId: string;
    let assignmentAttempted = false;
    const uploadCommand = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      try {
        return await this.connection.send(method, params, page.cdpSessionId);
      } catch {
        throw new BrowserDriverActionError(
          assignmentAttempted ? "upload_verification_failed" : "stale_upload_context",
        );
      }
    };

    if (input.selector) {
      const selected = await uploadCommand("Runtime.evaluate", {
        expression: `(() => { let el; try { el=document.querySelector(${JSON.stringify(input.selector)}); } catch { return null; } return el; })()`,
        returnByValue: false,
        awaitPromise: true,
        userGesture: true,
      });
      const remote = selected.result as { objectId?: string; subtype?: string; value?: unknown } | undefined;
      if (!remote?.objectId) {
        const syntax = await uploadCommand("Runtime.evaluate", {
          expression: `(() => { try { document.querySelector(${JSON.stringify(input.selector)}); return true; } catch { return false; } })()`,
          returnByValue: true,
        });
        const valid = (syntax.result as { value?: unknown } | undefined)?.value === true;
        throw new BrowserDriverActionError(valid ? "selector_not_found" : "invalid_selector");
      }
      objectId = remote.objectId;
      // CDP accepts the remote object directly. DOM.requestNode may legally
      // return no frontend node for hidden/framework-owned file inputs; passing
      // that missing node produced a raw protocol 500 instead of attaching.
      nodeReference = {};
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
      const resolved = await uploadCommand(
        "DOM.resolveNode",
        { backendNodeId: chooser.backendNodeId },
      );
      objectId = String((resolved.object as { objectId?: unknown } | undefined)?.objectId ?? "");
      if (!objectId) throw new BrowserDriverActionError("unsupported_file_chooser");
    }

    const inputStateReply = await uploadCommand("Runtime.callFunctionOn", {
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
    });
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

    const reference = input.selector
      ? { objectId }
      : nodeReference.nodeId
        ? { nodeId: nodeReference.nodeId }
        : { backendNodeId: nodeReference.backendNodeId };
    const assigned = this.uploadedInputs.get(page.pageId) ?? [];
    assigned.push({ uploadId: input.uploadId, cdpSessionId: page.cdpSessionId, reference });
    this.uploadedInputs.set(page.pageId, assigned);
    assignmentAttempted = true;
    await uploadCommand(
      "DOM.setFileInputFiles",
      { files: [input.stagedPath], ...reference },
    );
    const metadataReply = await uploadCommand("Runtime.callFunctionOn", {
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
    });
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
    let info: BrowserPageInfo;
    try {
      info = await this.pageInfo();
    } catch {
      throw new BrowserDriverActionError("upload_verification_failed");
    }
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
    await Promise.all([...this.previewStreams.keys()].map(pageId => this.stopPreview(pageId)));
    this.playwright?.close();
    let closeTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.connection.send("Browser.close").catch(() => undefined),
        new Promise<void>((resolve) => { closeTimer = setTimeout(resolve, 250); }),
      ]);
    } finally { if (closeTimer) clearTimeout(closeTimer); }
    // Trusted cookies and site storage are durable only after Chrome has
    // completed its own shutdown. Give Browser.close a bounded opportunity to
    // flush the profile, then retain the existing TERM/KILL containment path.
    if (!await waitForBrowserProcessExit(this.child, 2_000, this.nativeProcessAuthority)) {
      await terminateBrowserProcess(this.child, this.nativeProcessAuthority);
    } else {
      this.nativeProcessAuthority?.close();
    }
    if (this.display) {
      await terminateBrowserProcess(this.display.child);
      await fs.rm(this.display.reservationPath, { force: true });
    }
    if (!this.retainProfile) await removeBrowserProfile(this.profileDir);
  }
}

export function findBrowserExecutable(
  configured = process.env.PONDEROSA_BROWSER_EXECUTABLE,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    exists?: (candidate: string) => boolean;
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const hostPath = platform === "win32" ? path.win32 : path.posix;
  const candidates = [
    configured && hostPath.isAbsolute(configured) ? configured : undefined,
    ...(platform === "darwin" ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      hostPath.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      hostPath.join(home, "Applications/Chromium.app/Contents/MacOS/Chromium"),
    ] : platform === "win32" ? [
      ...[env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
        .filter((value): value is string => Boolean(value))
        .flatMap((root) => [
          hostPath.join(root, "Google", "Chrome", "Application", "chrome.exe"),
          hostPath.join(root, "Chromium", "Application", "chrome.exe"),
        ]),
    ] : [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ]),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => (options.exists ?? existsSync)(candidate));
}

export function chromeBrowserDriverFactory(dataDir: string, executable = findBrowserExecutable()): BrowserDriverFactory {
  return async (sessionId, onConsole, onSpawned, onPageEvent, launch = {}) => {
    if (!executable) {
      throw new Error("host browser is unavailable; set PONDEROSA_BROWSER_EXECUTABLE to a Chromium/Chrome binary");
    }
    const profileDir = launch.profileDir ?? path.join(dataDir, "browser-sessions", sessionId);
    if (launch.nativeManual) {
      const { createNativeHostedBrowser } = await import("./native-hosted-browser.js");
      return createNativeHostedBrowser(executable, profileDir, onConsole, onSpawned, onPageEvent, launch);
    }
    return ChromeCdpDriver.create(executable, profileDir, onConsole, onSpawned, onPageEvent, launch);
  };
}

export function playwrightBrowserDriverFactory(dataDir: string, executable = findBrowserExecutable()): BrowserDriverFactory {
  const launchChrome = chromeBrowserDriverFactory(dataDir, executable);
  return (sessionId, onConsole, onSpawned, onPageEvent, launch) =>
    launchChrome(sessionId, onConsole, onSpawned, onPageEvent, { ...launch, playwright: true });
}
