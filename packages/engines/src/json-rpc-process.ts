import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { ProviderRootExitDetail, RuntimeProcessHandle } from "@ponderosa/core";
import { spawnContainedCli } from "./contained-spawn.js";
import type { SpawnFn } from "./process.js";
import { processGroupAlive, runtimeProcessIdentity, terminateProcessGroup } from "./process-termination.js";
import type { NativeProcessTreeAuthority } from "./process-termination.js";
import { JSONL_MAX_RECORD_BYTES, JsonlRecordLimitError, LineBuffer } from "./jsonl.js";
import { runtimeEnvironment } from "./runtime-environment.js";

type RpcId = number;
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

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
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
  spawnFn?: SpawnFn;
  killGraceMs?: number;
  /** Register authority immediately after spawn, before transport setup. */
  onRuntimeSpawned: (handle: RuntimeProcessHandle) => void;
  onRuntimeRootExit: (detail?: ProviderRootExitDetail) => void;
  handleServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  /** Observe provider notifications even while the Agent has no active turn and
   * the event iterator is not currently being pulled. */
  onNotification?: (notification: JsonRpcNotification) => void;
}

/** Minimal JSONL JSON-RPC client for subscription-authenticated engine daemons. */
export class JsonRpcProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<RpcId, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly queue = new AsyncQueue<JsonRpcNotification>();
  private nextId = 1;
  private stderrTail = "";
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly nativeAuthority?: NativeProcessTreeAuthority;
  readonly processIdentity;

  readonly notifications: AsyncIterable<JsonRpcNotification> = this.queue;

  constructor(private readonly opts: JsonRpcProcessOptions) {
    const spawnFn = opts.spawnFn ?? nodeSpawn;
    const environment = runtimeEnvironment(opts.environment);
    const contained = spawnContainedCli({
      bin: opts.bin,
      args: opts.args,
      cwd: opts.cwd,
      env: environment,
      stdin: "pipe",
      spawnFn,
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
    this.child.stdin?.on("error", () => undefined);
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8192);
    });
    const lines = new LineBuffer();
    let postExitDrainTimer: NodeJS.Timeout | undefined;
    const clearPostExitDrain = () => {
      if (postExitDrainTimer) clearTimeout(postExitDrainTimer);
      postExitDrainTimer = undefined;
    };
    this.child.stdout?.once("close", clearPostExitDrain);
    const failRecord = () => {
      if (this.closed) return;
      reportRootExit();
      this.child.stdout?.destroy();
      this.finish(new Error(
        `${opts.bin} JSONL record exceeded the ${JSONL_MAX_RECORD_BYTES / (1024 * 1024)} MiB limit`,
      ));
      void this.close().catch(() => undefined);
    };
    this.child.stdout?.on("data", (chunk: Buffer | string) => {
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
    this.child.once("error", (error) => { rootExited(); this.finish(new Error(`failed to spawn ${opts.bin}: ${error.message}`)); });
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
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
    this.write({ id, method, params });
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
    this.closed = true;
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
    let message: RpcMessage;
    try { message = JSON.parse(line) as RpcMessage; } catch { return; }
    if (message.id !== undefined && ("result" in message || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message ?? "engine RPC request failed"), { rpcError: message.error }));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      void this.respondToServerRequest(message.id, message.method, message.params);
      return;
    }
    if (message.method) {
      const notification = { method: message.method, params: message.params };
      this.opts.onNotification?.(notification);
      this.queue.push(notification);
    }
  }

  private async respondToServerRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    if (!this.opts.handleServerRequest) {
      this.write({ id, error: { code: -32601, message: `unsupported server request: ${method}` } });
      return;
    }
    try {
      const result = await this.opts.handleServerRequest(method, params);
      this.write({ id, result });
    } catch (error) {
      this.write({
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
    if (error) this.queue.push({ method: "ponderosa/processError", params: { message: error.message } });
    this.queue.end();
  }

}
