import { browserOwnerId, type BrowserOwner } from "@ponderosa/core";
import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, lstat } from "@ponderosa/native-host/fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import type { BrowserActivityDto } from "@ponderosa/core";
import type { BrowserDriver, BrowserDriverFactory, BrowserDriverLaunchOptions, BrowserPageEvent, BrowserTerminationHandle } from "./chrome-cdp-driver.js";
import { BrowserDriverActionError } from "./chrome-cdp-driver.js";
import { BrowserSessionError } from "./browser-security.js";

const methods = new Set(["pages", "pageInfo", "activatePage", "closePage", "newPage", "openLink", "navigate", "inspect", "click", "fill", "key", "pointer", "type", "scroll", "capture", "preview", "resizeViewport", "resizeDesktop", "upload", "clearUploadedFiles", "cancelPendingFileChooser", "pauseAutomation", "resumeAutomation"]);
const automationMethods = new Set(["pageInfo", "activatePage", "closePage", "newPage", "navigate", "inspect", "click", "fill", "key", "pointer", "type", "scroll", "capture", "preview", "resizeViewport", "upload"]);
const OWNER_PROTOCOL = 2;
const driverActionReasons = new Set([
  "invalid_selector", "selector_not_found", "selector_ambiguous", "selector_not_interactable",
  "click_unconfirmed", "fill_unconfirmed", "selector_not_editable", "page_not_found", "last_page",
  "upload_disabled", "selector_not_file_input", "file_input_disabled", "file_type_not_accepted",
  "no_pending_file_chooser", "stale_file_chooser", "unsupported_file_chooser",
  "stale_upload_context", "upload_verification_failed",
]);
type Snapshot = { alive: boolean; manual?: "manual" | "connecting" | "automation"; revision?: number; socket?: string; viewSocket?: string; nativeDisplay?: boolean; activity?: BrowserActivityDto; viewport: { width: number; height: number } };
/** Protocol-2 host evidence for an exact, fully observed opening teardown. */
interface OpeningCleanupReceipt {
  ownerProtocol: typeof OWNER_PROTOCOL;
  id: string;
  owner: BrowserOwner;
  profileId?: string;
  admittedLease: string;
  openingToken: string;
}
interface Entry {
  owner: BrowserOwner;
  driver?: BrowserDriver;
  queue: Promise<unknown>;
  navigatingDriver?: BrowserDriver;
  openingTask?: Promise<void>;
  cleanup?: Promise<void>;
  cleanupReceipt?: OpeningCleanupReceipt;
  spawnHandles: Set<BrowserTerminationHandle>;
  observedAuthorities: Set<object>;
  publicationComplete: boolean;
  returnedDriver: boolean;
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
  // A callback violating its settled factory's lifetime still owns its exact
  // old authority. Keep it separate from any new entry using the same UUID.
  const retiredEntries = new Map<Entry, string>();
  const cancelledOpenings = new Set<string>();
  let lease = "", stopped = false;
  const authority = (handle: BrowserTerminationHandle): object => handle.terminationAuthority ?? handle;
  const drainHandles = async (entry: Entry, retry: boolean): Promise<void> => {
    while (entry.driver || entry.spawnHandles.size) {
      const published = [...entry.spawnHandles];
      const driver = entry.driver;
      const handles = new Map<object, BrowserTerminationHandle>();
      // Prefer the full driver's protocol over its spawn-time fallback.
      for (const handle of [driver, ...published]) if (handle && !handles.has(authority(handle))) handles.set(authority(handle), handle);
      const owned = [...handles];
      const results = await Promise.allSettled(owned.map(([, handle]) => handle.close()));
      results.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        const [key] = owned[index]!;
        entry.observedAuthorities.add(key);
        if (driver && entry.driver === driver && authority(driver) === key) entry.driver = undefined;
        // Publications arriving during close remain for the next pass, even
        // when their authority key matches an earlier fallback.
        for (const handle of published) if (authority(handle) === key) entry.spawnHandles.delete(handle);
      });
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) {
        if (!retry) throw new AggregateError(failures, "Browser service cleanup is incomplete.");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  };
  const cleanupCancelledEntry = (id: string, entry: Entry): Promise<void> => {
    if (entry.cleanup) return entry.cleanup;
    entry.cancelled = true;
    entry.launchAbort?.abort();
    const cleanup = (async () => {
      // Native factories transfer spawn cleanup to this callback before CDP
      // readiness. Close known authority first to unblock that readiness.
      await drainHandles(entry, true);
      await entry.openingTask?.catch(() => undefined);
      await drainHandles(entry, true);
      if (!entry.observedAuthorities.size || (!entry.returnedDriver && !entry.publicationComplete)) {
        throw new Error("Browser opening termination authority remains unconfirmed.");
      }
      if (entry.openingToken) entry.cleanupReceipt = {
        ownerProtocol: OWNER_PROTOCOL, id, owner: entry.owner, profileId: entry.profileId,
        admittedLease: entry.admittedLease, openingToken: entry.openingToken,
      };
      if (entries.get(id) === entry) entries.delete(id);
    })();
    entry.cleanup = cleanup;
    cleanup.then(
      () => { if (entry.cleanup === cleanup) entry.cleanup = undefined; },
      () => { if (entry.cleanup === cleanup) entry.cleanup = undefined; },
    );
    return cleanup;
  };
  const cleanupRetiredEntry = async (id: string, entry: Entry): Promise<void> => {
    do { await cleanupCancelledEntry(id, entry); }
    while (entry.driver || entry.spawnHandles.size);
    retiredEntries.delete(entry);
  };
  const snapshot = (entry: Entry): Snapshot => {
    if (!entry.driver) throw new Error("Existing browser is unavailable. It was not replaced.");
    return { alive: entry.driver.isAlive(), manual: entry.driver.manualState?.(), revision: entry.driver.controlRevision?.(),
      ...(entry.driver.resizeDesktop ? { nativeDisplay: true, socket: entry.driver.manualSocket?.(), viewSocket: entry.driver.manualSocket?.(true), activity: entry.driver.activity?.() } : entry.driver.manualState?.() !== "automation" ? { socket: entry.driver.manualSocket?.() } : { activity: entry.driver.activity?.() }), viewport: entry.driver.viewport?.() ?? { width: 1280, height: 720 } };
  };
  const server = createServer(async (req, res) => {
    let observedCleanup: OpeningCleanupReceipt | undefined;
    try {
      if (req.method !== "POST" || req.url !== "/rpc") throw new Error("Unsupported browser service request.");
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024) throw new Error("Browser service request is too large."); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (stopped) throw new Error("Browser service is stopping.");
      let result: unknown;
      // Reject incompatible writers before a claim can advance the lease.
      if (body.ownerProtocol !== OWNER_PROTOCOL) throw new Error("Browser ownership protocol is incompatible. Retained browsers were not changed.");
      if (body.operation === "negotiate_owner") result = { ownerProtocol: OWNER_PROTOCOL };
      else if (body.operation === "claim") {
        // Advancing before joining queues prevents old queued calls from running.
        const claimed = randomUUID(); lease = claimed;
        cancelledOpenings.clear();
        await Promise.all([...entries].map(([id, entry]) => entry.opening || entry.cancelled || !entry.driver
          ? cleanupCancelledEntry(id, entry)
          : entry.queue.catch(() => undefined)).concat([...retiredEntries].map(([entry, id]) => cleanupRetiredEntry(id, entry))));
        // A late callback can be observed while those queues are joining.
        while (retiredEntries.size) await Promise.all([...retiredEntries].map(([entry, id]) => cleanupRetiredEntry(id, entry)));
        if (lease !== claimed) throw new Error("Another application claimed the browser service.");
        result = { lease: claimed, ownerProtocol: OWNER_PROTOCOL, sessions: [...entries].flatMap(([id, entry]) =>
          !entry.cancelled && entry.driver ? [id] : []) };
      } else {
        if (!lease || body.lease !== lease) throw new Error("Browser application lease expired.");
        const admittedLease = lease;
        if (!/^[a-f0-9-]{36}$/.test(body.id ?? "")) throw new Error("Invalid browser identity.");
        if (body.operation === "open") {
          const owner = body.owner as BrowserOwner;
          browserOwnerId(owner);
          if (entries.has(body.id)) throw new Error("Browser already exists; adopt it instead.");
          if (entries.size + retiredEntries.size >= 8) throw new Error("Shared browser capacity reached.");
          if (!/^[a-f0-9-]{36}$/.test(body.openingToken ?? "")) throw new Error("Invalid browser opening identity.");
          const openingKey = `${admittedLease}:${body.id}:${body.openingToken}`;
          if (cancelledOpenings.delete(openingKey)) throw new Error("Browser launch was cancelled.");
          const profileId = body.profileId;
          if (profileId !== undefined && !/^[a-f0-9-]{36}$/.test(profileId)) throw new Error("Invalid profile identity.");
          if (profileId && [...entries.values(), ...retiredEntries.keys()].some(entry => entry.profileId === profileId)) throw new Error("Browser profile is already in use.");
          // Paths are derived here, never supplied by browser UI or callers.
          const profileDir = profileId ? path.join(dataDir, "browser-profiles", profileId) : path.join(dataDir, "browser-service-temporary", body.id);
          const launchAbort = new AbortController();
          const launch: BrowserDriverLaunchOptions = { owner, profileDir, retainProfile: Boolean(profileId), nativeManual: body.nativeManual === true, connectOnOpen: body.connectOnOpen === true, initialUrl: body.url, signal: launchAbort.signal };
          const events: BrowserPageEvent[] = [];
          const entry: Entry = { owner, profileId, events, queue: Promise.resolve(), admittedLease, opening: true, cancelled: false, openingToken: body.openingToken, launchAbort,
            spawnHandles: new Set(), observedAuthorities: new Set(), publicationComplete: false, returnedDriver: false };
          entries.set(body.id, entry);
          const opening = (async () => {
            entry.driver = await factory(body.id, () => {}, (handle, options) => {
              if (options?.complete) entry.publicationComplete = true;
              entry.spawnHandles.add(handle);
              entry.cleanupReceipt = undefined;
              if (entries.get(body.id) !== entry) {
                retiredEntries.set(entry, body.id);
                void cleanupRetiredEntry(body.id, entry).catch(() => {});
              }
            }, event => { events.push(event); if (events.length > 64) events.shift(); }, launch);
            entry.returnedDriver = true;
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
            observedCleanup = entry.cleanupReceipt;
            throw error;
          }
          result = { snapshot: snapshot(entry) };
        } else if (body.operation === "cancel_open") {
          browserOwnerId(body.owner);
          if (!/^[a-f0-9-]{36}$/.test(body.openingToken ?? "")) throw new Error("Invalid browser opening identity.");
          const entry = entries.get(body.id);
          if (!entry) {
            // The cancellation request can reach the broker before the open
            // request on a second IPC connection. Retain a lease-bound fence
            // so that reordered open is rejected instead of launching.
            cancelledOpenings.add(`${admittedLease}:${body.id}:${body.openingToken}`);
            result = { cancelled: false };
          } else {
            if (browserOwnerId(body.owner) !== browserOwnerId(entry.owner)) throw new Error("Browser custody changed or is unassigned.");
            if (body.profileId !== entry.profileId) throw new Error("Browser profile authority changed.");
            if (entry.admittedLease !== admittedLease || entry.openingToken !== body.openingToken) {
              throw new Error("Browser opening authority changed.");
            }
            await cleanupCancelledEntry(body.id, entry);
            observedCleanup = entry.cleanupReceipt;
            result = { cancelled: true };
          }
        } else {
          const entry = entries.get(body.id);
          if (!entry || entry.cancelled || (!entry.driver && (body.operation !== "close" || !entry.spawnHandles.size))) throw new Error("Existing browser is unavailable. It was not replaced.");
          if (!body.owner || browserOwnerId(body.owner) !== browserOwnerId(entry.owner)) throw new Error("Browser custody changed or is unassigned.");
          if (body.profileId !== entry.profileId) throw new Error("Browser profile authority changed.");
          // Only an exact close retry may proceed with a driver already closed
          // while distinct published authority still requires teardown.
          const driver = entry.driver!;
          entry.openingToken = undefined;
          entry.launchAbort = undefined;
          if (body.operation === "promote_owner") {
            if (entry.owner.kind !== "chat" || body.destination?.version !== 1 || body.destination.kind !== "saved" ||
                [...entries.values()].some(other => other !== entry && other.owner.kind === "saved")) throw new Error("Saved browser custody cannot be replaced.");
            await entry.queue;
            if (lease !== admittedLease) throw new Error("Browser application lease expired.");
            if (entries.get(body.id) !== entry || browserOwnerId(body.owner) !== browserOwnerId(entry.owner) ||
                [...entries.values()].some(other => other !== entry && other.owner.kind === "saved")) throw new Error("Browser custody changed before promotion.");
            entry.owner = { version: 1, kind: "saved" };
            result = {};
          } else if (body.operation === "check_lease") result = {};
          else if (body.operation === "adopt" || body.operation === "status") result = { snapshot: snapshot(entry), events: entry.events.splice(0) };
          else {
            // A Chrome approval handshake can occupy this browser's action
            // queue for up to two minutes. Reject agent actions immediately while
            // it is manual/connecting so an Agent does not see a false tab
            // snapshot timeout behind that handshake.
            if (body.operation === "call" && automationMethods.has(body.method) && driver.manualState && driver.manualState() !== "automation") {
              throw new BrowserSessionError("Browser is under native manual control or awaiting Chrome connection approval.", 409, "browser_manual_control");
            }
            const execute = async () => {
              if (lease !== admittedLease || browserOwnerId(body.owner) !== browserOwnerId(entry.owner)) throw new Error("Stale browser action discarded.");
              if (body.operation === "close") { await drainHandles(entry, false); if (entries.get(body.id) === entry) entries.delete(body.id); return {}; }
              if (body.operation !== "call" || !methods.has(body.method) || !Array.isArray(body.args)) throw new Error("Unsupported browser operation.");
              // Manual takeover may happen after admission but before a queued
              // action runs. Recheck at execution, not only at request arrival.
              if (automationMethods.has(body.method) && driver.manualState && driver.manualState() !== "automation") {
                throw new BrowserSessionError("Browser is under native manual control or awaiting Chrome connection approval.", 409, "browser_manual_control");
              }
              const method = Reflect.get(driver, body.method);
              if (typeof method !== "function") throw new Error("Browser operation is unavailable.");
              const navigation = body.method === "navigate";
              if (navigation) entry.navigatingDriver = driver;
              let value: unknown;
              try {
                value = await method.apply(driver, body.args);
              } finally {
                if (navigation && entry.navigatingDriver === driver) entry.navigatingDriver = undefined;
              }
              if (lease !== admittedLease || browserOwnerId(body.owner) !== browserOwnerId(entry.owner)) throw new Error("Browser authority changed; result discarded.");
              return { value: Buffer.isBuffer(value) ? { bytes: value.toString("base64") } : value, snapshot: snapshot(entry), events: entry.events.splice(0) };
            };
            // The app permits one read-only frame to observe a page while its
            // navigation awaits DOMContentLoaded. Do not let the broker queue
            // add the same wait back; all mutations remain serialized.
            const previewDuringNavigation = body.operation === "call" && (body.method === "capture" || body.method === "preview") && entry.navigatingDriver === driver;
            const operation = previewDuringNavigation ? execute() : entry.queue.then(execute);
            if (!previewDuringNavigation) entry.queue = operation.catch(() => undefined);
            result = await operation;
          }
        }
      }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result, ...(observedCleanup ? { observedCleanup } : {}) }));
    } catch (error) {
      res.statusCode = 409;
      res.end(JSON.stringify({
        error: error instanceof Error ? error.message : "Browser service failed.",
        ...(observedCleanup ? { observedCleanup } : {}),
        ...(error instanceof BrowserDriverActionError ? { reason: error.reason } : {}),
        ...(error instanceof BrowserSessionError ? { code: error.code } : {}),
      }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return { async close() {
    stopped = true; lease = "";
    await Promise.all([...entries].map(([id, entry]) => entry.opening || entry.cancelled
      ? cleanupCancelledEntry(id, entry)
      : entry.queue.catch(() => undefined)).concat([...retiredEntries].map(([entry, id]) => cleanupRetiredEntry(id, entry))));
    while (retiredEntries.size) await Promise.all([...retiredEntries].map(([entry, id]) => cleanupRetiredEntry(id, entry)));
    const results = await Promise.allSettled([...entries.values()].map(entry => drainHandles(entry, false)));
    if (results.some(result => result.status === "rejected")) throw new Error("Browser service cleanup is incomplete.");
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
  } };
}

export class BrowserServiceClient {
  private lease = "";
  constructor(private readonly socketPath: string) {}
  private rpc(body: Record<string, unknown>, timeoutMs = 130_000, observeCleanup?: (receipt: OpeningCleanupReceipt) => void, admittedLease = this.lease): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ socketPath: this.socketPath, method: "POST", path: "/rpc", headers: { "content-type": "application/json" } }, res => {
        let size = 0; const chunks: Buffer[] = [];
        res.on("data", chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) req.destroy(new Error("Browser response exceeded its limit.")); else chunks.push(chunk); });
        res.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if (value.observedCleanup) observeCleanup?.(value.observedCleanup);
            if (value.error) {
              const reason = driverActionReasons.has(value.reason) ? value.reason : undefined;
              // Keep native-control conflicts typed across the broker/app boundary.
              reject(value.code === "browser_manual_control"
                ? new BrowserSessionError(value.error, 409, value.code)
                : reason ? new BrowserDriverActionError(reason) : new Error(value.error));
            } else resolve(value.result);
          } catch (error) { reject(error); }
        });
        res.on("error", reject);
      });
      if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error("Browser service did not respond. No replacement was opened.")));
      req.on("error", reject); req.end(JSON.stringify({ ...body, ownerProtocol: OWNER_PROTOCOL, lease: admittedLease }));
    });
  }
  async claim(): Promise<string[]> {
    const protocol = await this.rpc({ operation: "negotiate_owner" });
    if (protocol.ownerProtocol !== OWNER_PROTOCOL) throw new Error("Browser owner negotiation failed; no lease was claimed.");
    const result = await this.rpc({ operation: "claim" });
    if (result.ownerProtocol !== OWNER_PROTOCOL) throw new Error("Browser ownership protocol does not match; retained browsers were not adopted.");
    this.lease = result.lease;
    return result.sessions;
  }
  async driver(id: string, event: Parameters<BrowserDriverFactory>[3], launch?: BrowserDriverLaunchOptions, adopt = false, onSpawned?: Parameters<BrowserDriverFactory>[2]): Promise<BrowserDriver> {
    if (!launch?.owner) throw new Error("Exact browser custody is required by the broker.");
    let owner = launch.owner;
    const profileId = launch?.retainProfile && launch.profileDir ? path.basename(launch.profileDir) : undefined;
    const openingToken = adopt ? undefined : randomUUID();
    const admittedLease = this.lease;
    const ownedRpc = (body: Record<string, unknown>, timeoutMs?: number) => this.rpc({ ...body, owner, profileId }, timeoutMs, undefined, admittedLease);
    const admittedOwner = browserOwnerId(owner);
    let cleanupPublished = false;
    const observeCleanup = (receipt: OpeningCleanupReceipt) => {
      // Neither cancelled:true nor entry absence proves termination. The exact
      // receipt can arrive on the rejected open or its concurrent cancellation,
      // including after a replacement app advances the broker's current lease.
      if (adopt || cleanupPublished || receipt.ownerProtocol !== OWNER_PROTOCOL || receipt.id !== id || receipt.profileId !== profileId ||
          receipt.admittedLease !== admittedLease || receipt.openingToken !== openingToken ||
          browserOwnerId(receipt.owner) !== admittedOwner) return;
      cleanupPublished = true;
      onSpawned?.({ isAlive: () => false, close: async () => {} }, { complete: true, coversReturnedDriver: true });
    };
    let cancellation: Promise<unknown> | undefined;
    const cancelOpening = () => cancellation ??= this.rpc({ operation: "cancel_open", id, owner, profileId, openingToken }, 0, observeCleanup, admittedLease);
    const onAbort = () => { void cancelOpening().catch(() => undefined); };
    const opening = this.rpc({ operation: adopt ? "adopt" : "open", id, owner, profileId, url: launch?.initialUrl, nativeManual: launch?.nativeManual === true, connectOnOpen: launch?.connectOnOpen === true, openingToken }, undefined, observeCleanup, admittedLease);
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
      void ownedRpc({ operation: "status", id }).then(result => {
        if (suspended) return;
        state = result.snapshot;
        for (const item of result.events ?? []) event?.(item);
      }, () => { state = { ...state, alive: false, socket: undefined }; }).finally(() => { polling = false; });
    }, 500);
    refresh.unref();
    const call = async (method: string, args: unknown[]) => {
      if (suspended) throw new Error("Browser application access is suspended.");
      const result = await ownedRpc({ operation: "call", id, method, args });
      state = result.snapshot; for (const item of result.events ?? []) event?.(item);
      return result.value?.bytes ? Buffer.from(result.value.bytes, "base64") : result.value;
    };
    const own = {
      setOwner: async (destination: BrowserOwner) => {
        await ownedRpc({ operation: "promote_owner", id, destination });
        owner = destination;
      },
      isAlive: () => !suspended && state.alive,
      manualState: () => state.manual,
      manualSocket: (readOnly = false) => { const socket = readOnly ? state.viewSocket : state.socket; if (suspended || !state.alive || !socket) throw new Error("Browser display is unavailable."); return socket; },
      controlRevision: () => state.revision,
      viewport: () => state.viewport,
      activity: () => state.activity,
      close: async () => { await ownedRpc({ operation: "close", id }); suspended = true; clearInterval(refresh); },
      suspend: async (chooserAlreadyCancelled = false) => {
        if (chooserAlreadyCancelled) {
          // Chooser cleanup already settled. Prove the exact lease without
          // joining the action queue or consuming pending browser events.
          await ownedRpc({ operation: "check_lease", id }, 15_000);
        } else {
          await call("cancelPendingFileChooser", ["application_disconnect"]);
        }
        suspended = true;
        clearInterval(refresh);
      },
    };
    return new Proxy(own as unknown as BrowserDriver, { get(target, key) {
      if (key in target) return Reflect.get(target, key);
      if (key === "resizeDesktop" && !state.nativeDisplay) return undefined;
      if (typeof key !== "string" || !methods.has(key)) return undefined;
      return (...args: unknown[]) => call(key, args);
    } });
  }
}
