import type { ChildProcess } from "node:child_process";
import type { ProviderRootExitDetail, RuntimeProcessHandle } from "@ponderosa/core";
import { spawnContainedCli } from "./contained-spawn.js";
import { processGroupAlive, runtimeProcessIdentity, terminateProcessGroup } from "./process-termination.js";
import type { NativeProcessTreeAuthority } from "./process-termination.js";
import { JSONL_MAX_RECORD_BYTES, JsonlRecordLimitError, LineBuffer } from "./jsonl.js";
import { runtimeEnvironment } from "./runtime-environment.js";

type RpcId = number | string;
type RpcMessage = {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  constructor(private readonly maxValues?: number) {}

  push(value: T): boolean {
    if (this.ended) return true;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else {
      if (this.maxValues !== undefined && this.values.length >= this.maxValues) return false;
      this.values.push(value);
    }
    return true;
  }

  end(finalValue?: T): void {
    if (this.ended) return;
    if (finalValue !== undefined && !this.push(finalValue)) {
      // A full bounded queue must still deliver its terminal error.
      this.values.pop();
      this.push(finalValue);
    }
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export interface JsonRpcNotification {
  method: string;
  params: unknown;
}

export interface JsonRpcProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  environment?: Record<string, string>;
  signal: AbortSignal;
  killGraceMs?: number;
  /** Register authority immediately after spawn, before transport setup. */
  onRuntimeSpawned: (handle: RuntimeProcessHandle) => void;
  onRuntimeRootExit: (detail?: ProviderRootExitDetail) => void;
  handleServerRequest?: (requestId: RpcId, method: string, params: unknown) => Promise<unknown>;
  /** Observe provider notifications even while the Agent has no active turn and
   * the event iterator is not currently being pulled. */
  onNotification?: (notification: JsonRpcNotification) => void;
  /** Aggregate stdout budget for short-lived helpers whose notification stream
   * is not consumed. Long-lived runtime sessions leave this unset. */
  maxOutputBytes?: number;
  /** Optional caps for bounded protocol qualification. Existing runtimes keep
   * their current limits unless they explicitly opt in. The pending cap applies
   * separately to each direction; deadlines remain owned by the caller's signal. */
  maxPendingRequests?: number;
  maxQueuedNotifications?: number;
}

/** Minimal JSONL JSON-RPC client for subscription-authenticated engine daemons. */
export class JsonRpcProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<RpcId, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly queue: AsyncQueue<JsonRpcNotification>;
  private readonly serverRequests = new Set<RpcId>();
  private readonly failTransport: (error: Error) => void;
  private nextId = 1;
  private stderrTail = "";
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly nativeAuthority?: NativeProcessTreeAuthority;
  readonly processIdentity;

  readonly notifications: AsyncIterable<JsonRpcNotification>;

  constructor(private readonly opts: JsonRpcProcessOptions) {
    for (const limit of [opts.maxPendingRequests, opts.maxQueuedNotifications]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new Error("engine RPC limits must be positive safe integers");
      }
    }
    this.queue = new AsyncQueue(opts.maxQueuedNotifications);
    this.notifications = this.queue;
    const environment = runtimeEnvironment(opts.environment);
    const contained = spawnContainedCli({
      bin: opts.bin,
      args: opts.args,
      cwd: opts.cwd,
      env: environment,
      stdin: "pipe",
    });
    this.child = contained.child;
    this.nativeAuthority = contained.authority;
    this.processIdentity = contained.authority ? undefined : runtimeProcessIdentity(this.child);
    opts.onRuntimeSpawned(this);
    let rootExitReported = false;
    const reportRootExit = (detail?: ProviderRootExitDetail) => {
      if (rootExitReported) return;
      rootExitReported = true;
      opts.onRuntimeRootExit?.(detail);
    };
    this.failTransport = (error) => {
      if (this.closed) return;
      // Preserve the cause and revoke work before the host callback can
      // synchronously abort or close this same registered transport.
      this.finish(error);
      this.child.stdout?.destroy();
      reportRootExit();
      void this.close().catch(() => undefined);
    };
    this.child.stdin?.on("error", () => undefined);
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8192);
    });
    const lines = new LineBuffer();
    let outputBytes = 0;
    let postExitDrainTimer: NodeJS.Timeout | undefined;
    const clearPostExitDrain = () => {
      if (postExitDrainTimer) clearTimeout(postExitDrainTimer);
      postExitDrainTimer = undefined;
    };
    this.child.stdout?.once("close", clearPostExitDrain);
    const failRecord = () => {
      this.failTransport(new Error(
        `${opts.bin} JSONL record exceeded the ${JSONL_MAX_RECORD_BYTES / (1024 * 1024)} MiB limit`,
      ));
    };
    this.child.stdout?.on("data", (chunk: Buffer | string) => {
      outputBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (opts.maxOutputBytes !== undefined && outputBytes > opts.maxOutputBytes) {
        this.failTransport(new Error(`${opts.bin} JSON-RPC output exceeded the aggregate limit`));
        return;
      }
      try {
        for (const line of lines.push(chunk)) this.receive(line);
      } catch (error) {
        if (error instanceof JsonlRecordLimitError) failRecord();
        else throw error;
      }
    });
    this.child.stdout?.once("end", () => {
      if (this.closed) return;
      const tail = lines.flush();
      if (tail !== undefined) this.receive(tail);
    });
    const rootExited = (code?: number | null, signal?: NodeJS.Signals | null) => {
      // Host-initiated rollover, replacement, cancellation, and shutdown are
      // expected closes. Only an independently exiting root is a crash that
      // fences the active Run through onRuntimeRootExit.
      if (!this.closed) reportRootExit({ exitCode: code, signal, stderr: this.stderrTail });
      // A descendant outside the owned process group can inherit stdout and
      // otherwise keep the provider event stream open forever. Allow already
      // buffered output to drain briefly, then close the transport locally.
      postExitDrainTimer ??= setTimeout(() => this.child.stdout?.destroy(), 1_000);
    };
    this.child.once("error", (error) => {
      this.failTransport(new Error(`failed to spawn ${opts.bin}: ${error.message}`));
    });
    this.child.once("exit", rootExited);
    this.child.once("close", (code) => this.finish(code === 0 || this.closed
      ? undefined
      : new Error(`${opts.bin} exited with code ${code}${this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ""}`)));
    const abort = (): void => { void this.close().catch(() => undefined); };
    opts.signal.addEventListener("abort", abort);
    if (opts.signal.aborted) abort();
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "ponderosa", title: "Ponderosa", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("engine RPC process is closed"));
    if (this.opts.maxPendingRequests !== undefined && this.pending.size >= this.opts.maxPendingRequests) {
      return Promise.reject(new Error("engine RPC pending request limit exceeded"));
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
    try { this.write({ id, method, params }); }
    catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(error instanceof Error ? error : new Error("engine RPC write failed"));
    }
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  isAlive(): boolean {
    return this.nativeAuthority?.isAlive() ?? processGroupAlive(this.child);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    // Revoke transport work immediately, even if process teardown fails. The
    // host's registered handle still owns the live tree and can retry close.
    this.finish();
    const attempt = terminateProcessGroup(this.child, {
      label: this.opts.bin,
      termGraceMs: this.opts.killGraceMs ?? 3_000,
    }, this.nativeAuthority);
    const shared = attempt.catch((error) => {
      // A failed attempt keeps the process handle live. Later cleanup retries
      // may re-signal it instead of inheriting a permanently rejected promise.
      if (this.closePromise === shared) this.closePromise = undefined;
      throw error;
    });
    this.closePromise = shared;
    return shared;
  }

  private write(message: RpcMessage): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) throw new Error("engine RPC stdin is unavailable");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    if (this.closed) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const message = parsed as RpcMessage & { jsonrpc?: unknown };
    if (message.jsonrpc !== undefined && message.jsonrpc !== "2.0") return;
    // Preserve string reverse IDs already handled by the original transport;
    // outgoing request IDs remain numeric and correlate without coercion.
    if (message.id !== undefined && typeof message.id !== "string" && !Number.isSafeInteger(message.id)) return;
    const hasResult = Object.hasOwn(message, "result"), hasError = Object.hasOwn(message, "error");
    if (hasResult || hasError) {
      if (message.id === undefined || message.method !== undefined || hasResult === hasError) return;
      if (hasError && (!message.error || typeof message.error !== "object" || Array.isArray(message.error) ||
          !Number.isSafeInteger(message.error.code) || typeof message.error.message !== "string")) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message ?? "engine RPC request failed"), { rpcError: message.error }));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string" || !message.method) return;
    if (message.id !== undefined) {
      if (this.serverRequests.has(message.id)) return;
      if (this.opts.maxPendingRequests !== undefined && this.serverRequests.size >= this.opts.maxPendingRequests) {
        this.failTransport(new Error("engine RPC reverse request limit exceeded"));
        return;
      }
      this.serverRequests.add(message.id);
      void this.respondToServerRequest(message.id, message.method, message.params)
        .finally(() => this.serverRequests.delete(message.id!))
        .catch(error => this.failTransport(error instanceof Error ? error : new Error("engine RPC response failed")));
      return;
    }
    if (message.method) {
      const notification = { method: message.method, params: message.params };
      this.opts.onNotification?.(notification);
      if (!this.queue.push(notification)) this.failTransport(new Error("engine RPC notification queue limit exceeded"));
    }
  }

  private async respondToServerRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    if (!this.opts.handleServerRequest) {
      this.write({ id, error: { code: -32601, message: `unsupported server request: ${method}` } });
      return;
    }
    try {
      const result = await this.opts.handleServerRequest(id, method, params);
      if (!this.closed) this.write({ id, result });
    } catch (error) {
      if (!this.closed) this.write({
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private finish(error?: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error ?? new Error("engine RPC process closed"));
    this.pending.clear();
    this.queue.end(error ? { method: "ponderosa/processError", params: { message: error.message } } : undefined);
  }

}
