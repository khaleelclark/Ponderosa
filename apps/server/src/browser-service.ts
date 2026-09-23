import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import type { BrowserActivityDto } from "@ponderosa/core";
import type { BrowserDriver, BrowserDriverFactory, BrowserDriverLaunchOptions, BrowserPageEvent } from "./chrome-cdp-driver.js";
import { BrowserDriverActionError } from "./chrome-cdp-driver.js";

const methods = new Set(["pages", "pageInfo", "activatePage", "closePage", "newPage", "openLink", "navigate", "inspect", "click", "fill", "key", "pointer", "type", "scroll", "capture", "resizeViewport", "resizeDesktop", "upload", "clearUploadedFiles", "cancelPendingFileChooser", "pauseAutomation", "resumeAutomation"]);
const automationMethods = new Set(["pageInfo", "activatePage", "closePage", "newPage", "navigate", "inspect", "click", "fill", "key", "pointer", "type", "scroll", "capture", "resizeViewport", "upload"]);
const driverActionReasons = new Set([
  "invalid_selector", "selector_not_found", "selector_ambiguous", "selector_not_interactable",
  "click_unconfirmed", "fill_unconfirmed", "selector_not_editable", "page_not_found", "last_page",
  "upload_disabled", "selector_not_file_input", "file_input_disabled", "file_type_not_accepted",
  "no_pending_file_chooser", "stale_file_chooser", "unsupported_file_chooser",
  "stale_upload_context", "upload_verification_failed",
]);
type Snapshot = { alive: boolean; manual?: "manual" | "connecting" | "automation"; revision?: number; socket?: string; viewSocket?: string; nativeDisplay?: boolean; activity?: BrowserActivityDto; viewport: { width: number; height: number } };
interface Entry {
  driver?: BrowserDriver;
  queue: Promise<unknown>;
  openingTask?: Promise<void>;
  cleanup?: Promise<void>;
  events: BrowserPageEvent[];
  profileId?: string;
  admittedLease: string;
  opening: boolean;
  cancelled: boolean;
  openingToken?: string;
  launchAbort?: AbortController;
}

/** Private local IPC, never an HTTP route exposed by Ponderosa. The service
 * owns browser processes; each application incarnation gets a fenced lease. */
export async function startBrowserService(socketPath: string, dataDir: string, factory: BrowserDriverFactory) {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  // A terminated supervisor can leave its Unix socket behind. Never unlink a
  // live listener (or a non-socket file) to start a competing authority.
  const existingSocket = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (existingSocket) {
    if (!existingSocket.isSocket()) throw new Error("Browser service path is not a socket.");
    await new Promise<void>((resolve, reject) => {
      const connection = createConnection(socketPath);
      connection.setTimeout(2000, () => { connection.destroy(); reject(new Error("Cannot establish exclusive browser service ownership.")); });
      connection.once("connect", () => { connection.destroy(); reject(new Error("Browser service is already running.")); });
      connection.once("error", (error: NodeJS.ErrnoException) => { if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(); else reject(error); });
    });
    await unlink(socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
  const entries = new Map<string, Entry>();
  const cancelledOpenings = new Set<string>();
  let lease = "", stopped = false;
  const cleanupCancelledEntry = (id: string, entry: Entry): Promise<void> => {
    if (entry.cleanup) return entry.cleanup;
    entry.cancelled = true;
    entry.launchAbort?.abort();
    const cleanup = (async () => {
      await entry.openingTask?.catch(() => undefined);
      // A failed close is still retained authority, not a completed attempt.
      // Retry this exact driver until its implementation confirms teardown;
      // every caller joins this obligation, so readiness cannot report zero.
      while (entries.get(id) === entry && entry.driver) {
        try {
          await entry.driver.close();
          entry.driver = undefined;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      if (entries.get(id) === entry) entries.delete(id);
    })();
    entry.cleanup = cleanup;
    return cleanup;
  };
  const snapshot = (entry: Entry): Snapshot => {
    if (!entry.driver) throw new Error("Existing browser is unavailable. It was not replaced.");
    return { alive: entry.driver.isAlive(), manual: entry.driver.manualState?.(), revision: entry.driver.controlRevision?.(),
      ...(entry.driver.resizeDesktop ? { nativeDisplay: true, socket: entry.driver.manualSocket?.(), viewSocket: entry.driver.manualSocket?.(true), activity: entry.driver.activity?.() } : entry.driver.manualState?.() !== "automation" ? { socket: entry.driver.manualSocket?.() } : { activity: entry.driver.activity?.() }), viewport: entry.driver.viewport?.() ?? { width: 1280, height: 720 } };
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/rpc") throw new Error("Unsupported browser service request.");
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024) throw new Error("Browser service request is too large."); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (stopped) throw new Error("Browser service is stopping.");
      let result: unknown;
      if (body.operation === "claim") {
        // Advancing before joining queues prevents old queued calls from running.
        const claimed = randomUUID(); lease = claimed;
        cancelledOpenings.clear();
        await Promise.all([...entries].map(([id, entry]) => entry.opening || entry.cancelled
          ? cleanupCancelledEntry(id, entry)
          : entry.queue.catch(() => undefined)));
        if (lease !== claimed) throw new Error("Another application claimed the browser service.");
        result = { lease: claimed, sessions: [...entries].flatMap(([id, entry]) =>
          !entry.cancelled && entry.driver ? [id] : []) };
      } else {
        if (!lease || body.lease !== lease) throw new Error("Browser application lease expired.");
        const admittedLease = lease;
        if (!/^[a-f0-9-]{36}$/.test(body.id ?? "")) throw new Error("Invalid browser identity.");
        if (body.operation === "open") {
          if (entries.has(body.id)) throw new Error("Browser already exists; adopt it instead.");
          if (entries.size >= 8) throw new Error("Shared browser capacity reached.");
          if (!/^[a-f0-9-]{36}$/.test(body.openingToken ?? "")) throw new Error("Invalid browser opening identity.");
          const openingKey = `${admittedLease}:${body.id}:${body.openingToken}`;
          if (cancelledOpenings.delete(openingKey)) throw new Error("Browser launch was cancelled.");
          const profileId = body.profileId;
          if (profileId !== undefined && !/^[a-f0-9-]{36}$/.test(profileId)) throw new Error("Invalid profile identity.");
          if (profileId && [...entries.values()].some(entry => entry.profileId === profileId)) throw new Error("Browser profile is already in use.");
          // Paths are derived here, never supplied by browser UI or callers.
          const profileDir = profileId ? path.join(dataDir, "browser-profiles", profileId) : path.join(dataDir, "browser-service-temporary", body.id);
          const launchAbort = new AbortController();
          const launch: BrowserDriverLaunchOptions = { profileDir, retainProfile: Boolean(profileId), nativeManual: true, initialUrl: body.url, signal: launchAbort.signal };
          const events: BrowserPageEvent[] = [];
          const entry: Entry = { profileId, events, queue: Promise.resolve(), admittedLease, opening: true, cancelled: false, openingToken: body.openingToken, launchAbort };
          entries.set(body.id, entry);
          const opening = (async () => {
            entry.driver = await factory(body.id, () => {}, undefined, event => { events.push(event); if (events.length > 64) events.shift(); }, launch);
            if (launchAbort.signal.aborted || entry.cancelled) throw new Error("Browser launch was cancelled.");
            if (lease !== admittedLease) throw new Error("Browser lease changed while opening.");
            entry.opening = false;
          })();
          entry.openingTask = opening;
          entry.queue = opening.catch(() => undefined);
          try {
            await opening;
          } catch (error) {
            entry.opening = false;
            await cleanupCancelledEntry(body.id, entry);
            throw error;
          }
          result = { snapshot: snapshot(entry) };
        } else if (body.operation === "cancel_open") {
          if (!/^[a-f0-9-]{36}$/.test(body.openingToken ?? "")) throw new Error("Invalid browser opening identity.");
          const entry = entries.get(body.id);
          if (!entry) {
            // The cancellation request can reach the broker before the open
            // request on a second IPC connection. Retain a lease-bound fence
            // so that reordered open is rejected instead of launching.
            cancelledOpenings.add(`${admittedLease}:${body.id}:${body.openingToken}`);
            result = { cancelled: false };
          } else {
            if (entry.admittedLease !== admittedLease || entry.openingToken !== body.openingToken) {
              throw new Error("Browser opening authority changed.");
            }
            await cleanupCancelledEntry(body.id, entry);
            result = { cancelled: true };
          }
        } else {
          const entry = entries.get(body.id);
          if (!entry?.driver || entry.cancelled) throw new Error("Existing browser is unavailable. It was not replaced.");
          const driver = entry.driver;
          entry.openingToken = undefined;
          entry.launchAbort = undefined;
          if (body.operation === "adopt" || body.operation === "status") result = { snapshot: snapshot(entry), events: entry.events.splice(0) };
          else {
            // A Chrome approval handshake can occupy this browser's action
            // queue for up to two minutes. Reject automation immediately while
            // it is manual/connecting so an Agent does not see a false tab
            // snapshot timeout behind that handshake.
            if (body.operation === "call" && automationMethods.has(body.method) && driver.manualState && driver.manualState() !== "automation") {
              throw new Error("Browser is under native manual control or awaiting Chrome connection approval.");
            }
            const operation = entry.queue.then(async () => {
              if (lease !== admittedLease) throw new Error("Stale browser action discarded.");
              if (body.operation === "close") { await driver.close(); entries.delete(body.id); return {}; }
              if (body.operation !== "call" || !methods.has(body.method) || !Array.isArray(body.args)) throw new Error("Unsupported browser operation.");
              // Manual takeover may happen after admission but before a queued
              // action runs. Recheck at execution, not only at request arrival.
              if (automationMethods.has(body.method) && driver.manualState && driver.manualState() !== "automation") {
                throw new Error("Browser is under native manual control or awaiting Chrome connection approval.");
              }
              const method = Reflect.get(driver, body.method);
              if (typeof method !== "function") throw new Error("Browser operation is unavailable.");
              const value = await method.apply(driver, body.args);
              if (lease !== admittedLease) throw new Error("Browser authority changed; result discarded.");
              return { value: Buffer.isBuffer(value) ? { bytes: value.toString("base64") } : value, snapshot: snapshot(entry), events: entry.events.splice(0) };
            });
            entry.queue = operation.catch(() => undefined);
            result = await operation;
          }
        }
      }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result }));
    } catch (error) {
      res.statusCode = 409;
      res.end(JSON.stringify({
        error: error instanceof Error ? error.message : "Browser service failed.",
        ...(error instanceof BrowserDriverActionError ? { reason: error.reason } : {}),
      }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return { async close() {
    stopped = true; lease = "";
    await Promise.all([...entries].map(([id, entry]) => entry.opening || entry.cancelled
      ? cleanupCancelledEntry(id, entry)
      : entry.queue.catch(() => undefined)));
    const drivers = [...entries.values()].flatMap(entry => entry.driver ? [entry.driver] : []);
    const results = await Promise.allSettled(drivers.map(driver => driver.close()));
    if (results.some(result => result.status === "rejected")) throw new Error("Browser service cleanup is incomplete.");
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
  } };
}

export class BrowserServiceClient {
  private lease = "";
  constructor(private readonly socketPath: string) {}
  private rpc(body: Record<string, unknown>, timeoutMs = 130_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ socketPath: this.socketPath, method: "POST", path: "/rpc", headers: { "content-type": "application/json" } }, res => {
        let size = 0; const chunks: Buffer[] = [];
        res.on("data", chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) req.destroy(new Error("Browser response exceeded its limit.")); else chunks.push(chunk); });
        res.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if (value.error) {
              // The browser service can run an older release across an app restart.
              // Recognize its exact legacy reason strings as well as typed replies.
              const reason = driverActionReasons.has(value.reason) ? value.reason
                : driverActionReasons.has(value.error) ? value.error : undefined;
              reject(reason ? new BrowserDriverActionError(reason) : new Error(value.error));
            } else resolve(value.result);
          } catch (error) { reject(error); }
        });
        res.on("error", reject);
      });
      if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error("Browser service did not respond. No replacement was opened.")));
      req.on("error", reject); req.end(JSON.stringify({ ...body, lease: this.lease }));
    });
  }
  async claim(): Promise<string[]> { const result = await this.rpc({ operation: "claim" }); this.lease = result.lease; return result.sessions; }
  async driver(id: string, event: Parameters<BrowserDriverFactory>[3], launch?: BrowserDriverLaunchOptions, adopt = false): Promise<BrowserDriver> {
    const profileId = launch?.retainProfile && launch.profileDir ? path.basename(launch.profileDir) : undefined;
    const openingToken = adopt ? undefined : randomUUID();
    let cancellation: Promise<unknown> | undefined;
    const cancelOpening = () => cancellation ??= this.rpc({ operation: "cancel_open", id, openingToken }, 0);
    const onAbort = () => { void cancelOpening().catch(() => undefined); };
    const opening = this.rpc({ operation: adopt ? "adopt" : "open", id, profileId, url: launch?.initialUrl, openingToken });
    if (launch?.signal && !adopt) launch.signal.addEventListener("abort", onAbort, { once: true });
    if (launch?.signal?.aborted && !adopt) onAbort();
    let first: { snapshot: Snapshot };
    try {
      first = await opening;
      if (launch?.signal?.aborted && !adopt) {
        await cancelOpening();
        throw new Error("Browser launch was cancelled.");
      }
    } catch (error) {
      if (!adopt && (launch?.signal?.aborted || (error instanceof Error && error.message === "Browser service did not respond. No replacement was opened."))) {
        await cancelOpening();
      }
      throw error;
    } finally {
      launch?.signal?.removeEventListener("abort", onAbort);
    }
    let state: Snapshot = first.snapshot;
    let suspended = false;
    let polling = false;
    const refresh = setInterval(() => {
      if (suspended || polling) return;
      polling = true;
      void this.rpc({ operation: "status", id }).then(result => {
        if (suspended) return;
        state = result.snapshot;
        for (const item of result.events ?? []) event?.(item);
      }, () => { state = { ...state, alive: false, socket: undefined }; }).finally(() => { polling = false; });
    }, 500);
    refresh.unref();
    const call = async (method: string, args: unknown[]) => {
      if (suspended) throw new Error("Browser application access is suspended.");
      const result = await this.rpc({ operation: "call", id, method, args });
      state = result.snapshot; for (const item of result.events ?? []) event?.(item);
      return result.value?.bytes ? Buffer.from(result.value.bytes, "base64") : result.value;
    };
    const own = {
      isAlive: () => !suspended && state.alive,
      manualState: () => state.manual,
      manualSocket: (readOnly = false) => { const socket = readOnly ? state.viewSocket : state.socket; if (suspended || !state.alive || !socket) throw new Error("Browser display is unavailable."); return socket; },
      controlRevision: () => state.revision,
      viewport: () => state.viewport,
      activity: () => state.activity,
      close: async () => { await this.rpc({ operation: "close", id }); suspended = true; clearInterval(refresh); },
      suspend: async () => { await call("cancelPendingFileChooser", ["application_disconnect"]); suspended = true; clearInterval(refresh); },
    };
    return new Proxy(own as unknown as BrowserDriver, { get(target, key) {
      if (key in target) return Reflect.get(target, key);
      if (key === "resizeDesktop" && !state.nativeDisplay) return undefined;
      if (typeof key !== "string" || !methods.has(key)) return undefined;
      return (...args: unknown[]) => call(key, args);
    } });
  }
}
