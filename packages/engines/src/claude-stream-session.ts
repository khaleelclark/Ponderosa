import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type {
  AgentEvent,
  OpenRuntimeSessionOptions,
  RuntimeSession,
  RuntimeSteerResult,
  RuntimeTurnInput,
} from "@ponderosa/core";
import { mapClaudeEvent } from "./claude-events.js";
import { parseJsonlChunks } from "./jsonl.js";
import type { SpawnFn } from "./process.js";

interface ClaudeStreamSessionOptions extends OpenRuntimeSessionOptions {
  bin: string;
  spawnFn?: SpawnFn;
  permissionMode: string;
  killGraceMs: number;
}

export class ClaudeStreamSession implements RuntimeSession {
  readonly engineThreadId: string;
  readonly events: AsyncIterable<AgentEvent>;
  private readonly child: ChildProcess;
  private active = false;
  private closed = false;
  private stderrTail = "";
  private killTimer?: NodeJS.Timeout;

  constructor(private readonly opts: ClaudeStreamSessionOptions) {
    this.engineThreadId = opts.resumeSessionId ?? randomUUID();
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--permission-mode", opts.permissionMode,
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.effort ? ["--effort", opts.effort] : []),
      ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : ["--session-id", this.engineThreadId]),
    ];
    this.child = (opts.spawnFn ?? nodeSpawn)(opts.bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.environment },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child.stdin?.on("error", () => undefined);
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8192);
    });
    opts.signal.addEventListener("abort", () => void this.close());
    this.events = this.eventStream();
  }

  async startTurn(input: RuntimeTurnInput): Promise<{ turnId: string }> {
    if (this.active) throw new Error("Claude already has an active turn");
    const turnId = input.clientMessageId ?? randomUUID();
    await this.writeInput(input.prompt, turnId);
    this.active = true;
    return { turnId };
  }

  async steer(input: RuntimeTurnInput): Promise<RuntimeSteerResult> {
    if (!this.active) return { status: "not_active" };
    const turnId = input.clientMessageId ?? randomUUID();
    await this.writeInput(input.prompt, turnId);
    return { status: "accepted", turnId };
  }

  async interrupt(): Promise<void> {
    // Claude Code's streaming-input transport accepts mid-turn guidance but has
    // no stable structured interrupt frame. End the process; its persisted
    // session id lets Ponderosa reopen it for the next signal.
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin?.end();
    this.signal("SIGTERM");
    this.killTimer = setTimeout(() => this.signal("SIGKILL"), this.opts.killGraceMs);
    this.killTimer.unref?.();
  }

  private async writeInput(prompt: string, id: string): Promise<void> {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) throw new Error("Claude runtime is unavailable");
    const frame = {
      type: "user",
      uuid: id,
      session_id: this.engineThreadId,
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    };
    await new Promise<void>((resolve, reject) => {
      this.child.stdin!.write(`${JSON.stringify(frame)}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  private async *eventStream(): AsyncIterable<AgentEvent> {
    const stdout = this.child.stdout;
    if (!stdout) {
      yield { type: "error", message: "Claude runtime stdout is unavailable" };
      return;
    }
    stdout.setEncoding("utf8");
    for await (const raw of parseJsonlChunks(stdout as AsyncIterable<string>)) {
      for (const event of mapClaudeEvent(raw, { cwd: this.opts.cwd })) {
        if (event.type === "turn_done" || event.type === "error") this.active = false;
        yield event;
      }
    }
    if (!this.closed) {
      yield { type: "error", message: `Claude stream stopped${this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ""}` };
    }
    if (this.killTimer) clearTimeout(this.killTimer);
  }

  private signal(signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch { /* already exited */ }
  }
}
