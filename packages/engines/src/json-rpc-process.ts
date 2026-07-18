import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { RuntimeProcessHandle } from "@ponderosa/core";
import type { SpawnFn } from "./process.js";
import { assertPersistentRuntimeHostingSupported, terminateProcessGroup } from "./process-termination.js";

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
  handleServerRequest?: (method: string, params: unknown) => Promise<unknown>;
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

  readonly notifications: AsyncIterable<JsonRpcNotification> = this.queue;

  constructor(private readonly opts: JsonRpcProcessOptions) {
    assertPersistentRuntimeHostingSupported();
    this.child = (opts.spawnFn ?? nodeSpawn)(opts.bin, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.environment },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    opts.onRuntimeSpawned(this);
    this.child.stdin?.on("error", () => undefined);
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8192);
    });
    const lines = createInterface({ input: this.child.stdout! });
    lines.on("line", (line) => this.receive(line));
    this.child.once("error", (error) => this.finish(new Error(`failed to spawn ${opts.bin}: ${error.message}`)));
    this.child.once("close", (code) => this.finish(code === 0 || this.closed
      ? undefined
      : new Error(`${opts.bin} exited with code ${code}${this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ""}`)));
    opts.signal.addEventListener("abort", () => { void this.close().catch(() => undefined); });
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
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const attempt = terminateProcessGroup(this.child, {
      label: this.opts.bin,
      termGraceMs: this.opts.killGraceMs ?? 3_000,
    });
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
    if (message.method) this.queue.push({ method: message.method, params: message.params });
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
