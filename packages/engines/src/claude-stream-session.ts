import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  AgentEvent,
  EngineCapabilities,
  OpenRuntimeSessionOptions,
  RuntimeSession,
  RuntimeSteerResult,
  RuntimeTurnInput,
} from "@ponderosa/core";
import { mapClaudeEvent } from "./claude-events.js";
import { parseJsonlChunks } from "./jsonl.js";
import type { SpawnFn } from "./process.js";
import { assertPersistentRuntimeHostingSupported, terminateProcessGroup } from "./process-termination.js";
import { renderSeedPrompt } from "./seed-history.js";
import { normalizeClaudeInitCapabilities } from "./capabilities.js";

interface ClaudeStreamSessionOptions extends OpenRuntimeSessionOptions {
  bin: string;
  spawnFn?: SpawnFn;
  permissionMode: string;
  killGraceMs: number;
}

export class ClaudeStreamSession implements RuntimeSession {
  readonly engineAgentId: string;
  readonly events: AsyncIterable<AgentEvent>;
  private readonly child: ChildProcess;
  private active = false;
  private closed = false;
  private stderrTail = "";
  private closePromise?: Promise<void>;
  private readonly seedHistory: OpenRuntimeSessionOptions["history"];
  private capabilitiesSnapshot?: EngineCapabilities;

  constructor(private readonly opts: ClaudeStreamSessionOptions) {
    if (!opts.onRuntimeSpawned) {
      throw new Error("persistent runtime opening requires a spawn-time termination registrar");
    }
    assertPersistentRuntimeHostingSupported();
    this.seedHistory = opts.resumeSessionId ? [] : [...opts.history];
    this.engineAgentId = opts.resumeSessionId ?? randomUUID();
    const ponderosaMcp = opts.dynamicTools?.length && opts.environment?.PONDEROSA_AGENT_MESSAGE_URL && opts.environment.PONDEROSA_AGENT_MESSAGE_TOKEN
      ? JSON.stringify({
          mcpServers: {
            ponderosa: {
              type: "stdio",
              command: process.execPath,
              args: [fileURLToPath(new URL("./ponderosa-mcp.js", import.meta.url))],
            },
          },
        })
      : undefined;
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--permission-mode", opts.permissionMode,
      ...(ponderosaMcp ? ["--mcp-config", ponderosaMcp] : []),
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.effort ? ["--effort", opts.effort] : []),
      ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : ["--session-id", this.engineAgentId]),
    ];
    this.child = (opts.spawnFn ?? nodeSpawn)(opts.bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.environment },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    opts.onRuntimeSpawned(this);
    let rootExitReported = false;
    let postExitDrainTimer: NodeJS.Timeout | undefined;
    const reportRootExit = () => {
      if (rootExitReported) return;
      rootExitReported = true;
      opts.onRuntimeRootExit?.();
      postExitDrainTimer = setTimeout(() => this.child.stdout?.destroy(), 1_000);
    };
    this.child.stdout?.once("close", () => {
      if (postExitDrainTimer) clearTimeout(postExitDrainTimer);
      postExitDrainTimer = undefined;
    });
    this.child.once("error", reportRootExit);
    this.child.once("exit", reportRootExit);
    this.child.stdin?.on("error", () => undefined);
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8192);
    });
    opts.signal.addEventListener("abort", () => { void this.close().catch(() => undefined); });
    this.events = this.eventStream();
  }

  async startTurn(input: RuntimeTurnInput): Promise<{ turnId: string }> {
    if (this.active) throw new Error("Claude already has an active turn");
    const turnId = input.clientMessageId ?? randomUUID();
    const prompt = this.opts.resumeSessionId
      ? input.prompt
      : renderSeedPrompt(this.seedHistory.splice(0), input.prompt);
    await this.writeInput(prompt, turnId);
    this.active = true;
    return { turnId };
  }

  async capabilities(): Promise<EngineCapabilities> {
    return this.capabilitiesSnapshot ?? {
      steering: true,
      persistentSessions: true,
      sessionId: this.engineAgentId,
      ...(this.opts.model ? { model: this.opts.model } : {}),
      commands: [],
      mcpServers: [],
      composerCapabilities: [],
    };
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

  isAlive(): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.child.stdin?.end();
    const attempt = terminateProcessGroup(this.child, {
      label: "Claude runtime",
      termGraceMs: this.opts.killGraceMs,
    });
    const shared = attempt.catch((error) => {
      if (this.closePromise === shared) this.closePromise = undefined;
      throw error;
    });
    this.closePromise = shared;
    return shared;
  }

  private async writeInput(prompt: string, id: string): Promise<void> {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) throw new Error("Claude runtime is unavailable");
    const frame = {
      type: "user",
      uuid: id,
      session_id: this.engineAgentId,
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
      const capabilities = normalizeClaudeInitCapabilities(raw, this.opts.model);
      if (capabilities) {
        this.capabilitiesSnapshot = capabilities;
        this.opts.onCapabilitiesChanged?.();
      }
      for (const event of mapClaudeEvent(raw, { cwd: this.opts.cwd })) {
        if (event.type === "turn_done" || event.type === "error") this.active = false;
        yield event;
      }
    }
    if (!this.closed) {
      yield { type: "error", message: `Claude stream stopped${this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ""}` };
    }
  }
}
