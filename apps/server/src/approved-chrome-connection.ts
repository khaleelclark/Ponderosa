import { constants } from "@ponderosa/native-host/fs";
import { open } from "@ponderosa/native-host/fs/promises";
import path from "node:path";
import { WebSocket } from "ws";

export interface BrowserProtocolMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
}

export type BrowserProtocolReply = Pick<BrowserProtocolMessage, "result" | "error">;

export interface BrowserProtocolConnection {
  /** Dispatch a reply synchronously before subsequent native events. */
  send(method: string, params?: Record<string, unknown>, sessionId?: string, onReply?: (reply: BrowserProtocolReply) => void): Promise<Record<string, unknown>>;
  onEvent(listener: (message: BrowserProtocolMessage) => void): () => void;
  onClose(listener: () => void): () => void;
}

/** Connect only to the endpoint Chrome publishes in an already leased profile.
 * The caller owns the profile/process lease; this class owns only the agent connection.
 * Never accept a browser endpoint or profile path from an HTTP request here. */
export class ApprovedChromeConnection implements BrowserProtocolConnection {
  private nextId = 1;
  private closed = false;
  private failure = "Browser connection closed; pending actions were discarded.";
  failureReason(): string { return this.failure; }
  private readonly pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout; onReply?: (reply: BrowserProtocolReply) => void }>();
  private readonly listeners = new Set<(message: BrowserProtocolMessage) => void>();
  private readonly closeListeners = new Set<() => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", data => {
      let message: BrowserProtocolMessage;
      try { message = JSON.parse(data.toString()); } catch { this.disconnect(); return; }
      if (this.closed || !message || typeof message !== "object") return;
      if (message.id !== undefined) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        // Chrome diagnostics can contain page text and endpoint capabilities.
        const reply: BrowserProtocolReply = message.error
          ? { error: { message: "Browser command failed; check the page before retrying." } }
          : { result: message.result ?? {} };
        try { request.onReply?.(reply); }
        catch { request.reject(new Error("Browser reply could not be delivered.")); return; }
        if (reply.error) request.reject(new Error(reply.error.message));
        else request.resolve(reply.result!);
      } else for (const listener of this.listeners) listener(message);
    });
    socket.on("close", () => this.disconnect());
    socket.on("error", () => this.disconnect());
  }

  static async connect(profileDir: string, options: { signal?: AbortSignal; approvalTimeoutMs?: number } = {}): Promise<ApprovedChromeConnection> {
    if (!path.isAbsolute(profileDir)) throw new Error("An owned browser profile is required.");
    options.signal?.throwIfAborted();
    let endpoint: string;
    try {
      const file = await open(path.join(profileDir, "DevToolsActivePort"), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 512) throw new Error();
        const buffer = Buffer.alloc(513);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const lines = buffer.subarray(0, bytesRead).toString("utf8").trim().split(/\r?\n/);
        if (lines.length !== 2 || !/^[1-9]\d{0,4}$/.test(lines[0]!) || Number(lines[0]) > 65535 || !/^\/devtools\/browser\/[a-f0-9-]{1,80}$/i.test(lines[1]!)) throw new Error();
        endpoint = `ws://127.0.0.1:${lines[0]}${lines[1]}`;
      } finally { await file.close(); }
    } catch { throw new Error("Enable remote debugging in the owned Chrome window before resuming agent control."); }
    options.signal?.throwIfAborted();
    const socket = new WebSocket(endpoint, { followRedirects: false, maxPayload: 24 * 1024 * 1024, handshakeTimeout: options.approvalTimeoutMs ?? 120_000 });
    // Install listeners before waiting: refusal/abort must never leak an endpoint
    // or leave a socket able to attach after the owning request is cancelled.
    const connection = new ApprovedChromeConnection(socket);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { socket.off("open", ready); socket.off("error", failed); socket.off("close", failed); options.signal?.removeEventListener("abort", aborted); };
      const failed = (error?: unknown) => {
        cleanup(); connection.disconnect();
        const reason = error instanceof Error ? error.message : "";
        reject(new Error(/timed out/i.test(reason)
          ? "Chrome agent connection timed out. Check for a Chrome approval prompt, then retry without reopening the browser."
          : /ECONNREFUSED|ENOENT|EHOSTUNREACH|ENETUNREACH|ECONNRESET/i.test(reason)
            ? "Chrome's agent endpoint is unavailable. Keep the browser open, enable its connection, then retry."
            : /Unexpected server response: (401|403)/i.test(reason)
              ? "Chrome declined its agent connection. Approve the Chrome prompt if shown, then retry without reopening the browser."
              : "Chrome's agent connection failed. Check Chrome's connection status, then retry without reopening the browser."));
      };
      const aborted = () => { cleanup(); connection.disconnect(); reject(new Error("Browser connection cancelled.")); };
      const ready = () => { cleanup(); if (options.signal?.aborted) aborted(); else resolve(); };
      socket.once("open", ready); socket.once("error", failed); socket.once("close", failed);
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) aborted();
    });
    return connection;
  }

  onEvent(listener: (message: BrowserProtocolMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onClose(listener: () => void): () => void { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, onReply?: (reply: BrowserProtocolReply) => void): Promise<Record<string, unknown>> {
    if (method === "Browser.close") return Promise.reject(new Error("Ending Chrome requires the browser process owner's explicit lifecycle operation."));
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Browser connection is disconnected."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // An uncertain command must never survive into a resumed connection.
        this.disconnect(`Browser connection closed after ${method} timed out; pending actions were discarded.`);
      }, 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, onReply });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => { if (error) this.disconnect(); });
    });
  }
  disconnect(reason = "Browser connection closed; pending actions were discarded."): void {
    if (this.closed) return;
    this.failure = reason;
    this.closed = true;
    this.socket.terminate();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(reason)); }
    this.pending.clear(); this.listeners.clear();
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
  }
}
