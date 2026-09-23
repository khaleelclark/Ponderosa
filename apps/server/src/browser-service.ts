import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import type { BrowserActivityDto } from "@ponderosa/core";
import type { BrowserDriver, BrowserDriverFactory, BrowserDriverLaunchOptions, BrowserPageEvent } from "./chrome-cdp-driver.js";

const methods = new Set(["pages", "pageInfo", "activatePage", "closePage", "newPage", "openLink", "navigate", "inspect", "click", "fill", "key", "pointer", "type", "scroll", "capture", "resizeViewport", "resizeDesktop", "upload", "clearUploadedFiles", "cancelPendingFileChooser", "pauseAutomation", "resumeAutomation"]);
type Snapshot = { alive: boolean; manual?: "manual" | "connecting" | "automation"; revision?: number; socket?: string; viewSocket?: string; nativeDisplay?: boolean; activity?: BrowserActivityDto; viewport: { width: number; height: number } };
interface Entry { driver: BrowserDriver; queue: Promise<unknown>; events: BrowserPageEvent[]; profileId?: string; }

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
  let lease = "", stopped = false;
  const snapshot = (entry: Entry): Snapshot => ({ alive: entry.driver.isAlive(), manual: entry.driver.manualState?.(), revision: entry.driver.controlRevision?.(),
    ...(entry.driver.resizeDesktop ? { nativeDisplay: true, socket: entry.driver.manualSocket?.(), viewSocket: entry.driver.manualSocket?.(true), activity: entry.driver.activity?.() } : entry.driver.manualState?.() !== "automation" ? { socket: entry.driver.manualSocket?.() } : { activity: entry.driver.activity?.() }), viewport: entry.driver.viewport?.() ?? { width: 1280, height: 720 } });
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
        await Promise.all([...entries.values()].map(entry => entry.queue.catch(() => undefined)));
        if (lease !== claimed) throw new Error("Another application claimed the browser service.");
        result = { lease: claimed, sessions: [...entries.keys()] };
      } else {
        if (!lease || body.lease !== lease) throw new Error("Browser application lease expired.");
        const admittedLease = lease;
        if (!/^[a-f0-9-]{36}$/.test(body.id ?? "")) throw new Error("Invalid browser identity.");
        if (body.operation === "open") {
          if (entries.has(body.id)) throw new Error("Browser already exists; adopt it instead.");
          if (entries.size >= 8) throw new Error("Shared browser capacity reached.");
          const profileId = body.profileId;
          if (profileId !== undefined && !/^[a-f0-9-]{36}$/.test(profileId)) throw new Error("Invalid profile identity.");
          if (profileId && [...entries.values()].some(entry => entry.profileId === profileId)) throw new Error("Browser profile is already in use.");
          // Paths are derived here, never supplied by browser UI or callers.
          const profileDir = profileId ? path.join(dataDir, "browser-profiles", profileId) : path.join(dataDir, "browser-service-temporary", body.id);
          const launch: BrowserDriverLaunchOptions = { profileDir, retainProfile: Boolean(profileId), nativeManual: true, initialUrl: body.url };
          const events: BrowserPageEvent[] = [];
          const entry = { profileId, events, queue: Promise.resolve(), driver: undefined as unknown as BrowserDriver };
          entries.set(body.id, entry);
          const opening = (async () => {
            try {
              entry.driver = await factory(body.id, () => {}, undefined, event => { events.push(event); if (events.length > 64) events.shift(); }, launch);
              if (lease !== admittedLease) throw new Error("Browser lease changed while opening.");
            } catch (error) { if (entry.driver) await entry.driver.close(); entries.delete(body.id); throw error; }
          })();
          entry.queue = opening;
          await opening;
          result = { snapshot: snapshot(entry) };
        } else {
          const entry = entries.get(body.id);
          if (!entry?.driver) throw new Error("Existing browser is unavailable. It was not replaced.");
          if (body.operation === "adopt" || body.operation === "status") result = { snapshot: snapshot(entry), events: entry.events.splice(0) };
          else {
            const operation = entry.queue.then(async () => {
              if (lease !== admittedLease) throw new Error("Stale browser action discarded.");
              if (body.operation === "close") { await entry.driver.close(); entries.delete(body.id); return {}; }
              if (body.operation !== "call" || !methods.has(body.method) || !Array.isArray(body.args)) throw new Error("Unsupported browser operation.");
              const method = Reflect.get(entry.driver, body.method);
              if (typeof method !== "function") throw new Error("Browser operation is unavailable.");
              const value = await method.apply(entry.driver, body.args);
              if (lease !== admittedLease) throw new Error("Browser authority changed; result discarded.");
              return { value: Buffer.isBuffer(value) ? { bytes: value.toString("base64") } : value, snapshot: snapshot(entry), events: entry.events.splice(0) };
            });
            entry.queue = operation.catch(() => undefined);
            result = await operation;
          }
        }
      }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result }));
    } catch (error) { res.statusCode = 409; res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Browser service failed." })); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return { async close() {
    stopped = true; lease = "";
    await Promise.all([...entries.values()].map(entry => entry.queue.catch(() => undefined)));
    const results = await Promise.allSettled([...entries.values()].filter(entry => entry.driver).map(entry => entry.driver.close()));
    if (results.some(result => result.status === "rejected")) throw new Error("Browser service cleanup is incomplete.");
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
  } };
}

export class BrowserServiceClient {
  private lease = "";
  constructor(private readonly socketPath: string) {}
  private rpc(body: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ socketPath: this.socketPath, method: "POST", path: "/rpc", headers: { "content-type": "application/json" } }, res => {
        let size = 0; const chunks: Buffer[] = [];
        res.on("data", chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) req.destroy(new Error("Browser response exceeded its limit.")); else chunks.push(chunk); });
        res.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (value.error) reject(new Error(value.error)); else resolve(value.result); } catch (error) { reject(error); } });
        res.on("error", reject);
      });
      req.setTimeout(130_000, () => req.destroy(new Error("Browser service did not respond. No replacement was opened.")));
      req.on("error", reject); req.end(JSON.stringify({ ...body, lease: this.lease }));
    });
  }
  async claim(): Promise<string[]> { const result = await this.rpc({ operation: "claim" }); this.lease = result.lease; return result.sessions; }
  async driver(id: string, event: Parameters<BrowserDriverFactory>[3], launch?: BrowserDriverLaunchOptions, adopt = false): Promise<BrowserDriver> {
    const profileId = launch?.retainProfile && launch.profileDir ? path.basename(launch.profileDir) : undefined;
    const first = await this.rpc({ operation: adopt ? "adopt" : "open", id, profileId, url: launch?.initialUrl });
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
