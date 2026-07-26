import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  AgentEvent,
  EngineCapabilities,
  EngineModelOption,
  OpenRuntimeSessionOptions,
  RuntimeSession,
  RuntimeSteerResult,
  RuntimeTurnInput,
} from "@ponderosa/core";
import { mapClaudeAssistantUsage, mapClaudeEvent } from "./claude-events.js";
import { JSONL_MAX_RECORD_BYTES, JsonlRecordLimitError, parseJsonlChunks } from "./jsonl.js";
import type { SpawnFn } from "./process.js";
import { assertPersistentRuntimeHostingSupported, terminateProcessGroup } from "./process-termination.js";
import { renderSeedPrompt } from "./seed-history.js";
import { normalizeClaudeInitCapabilities } from "./capabilities.js";
import { normalizeClaudeProviderModels } from "./claude-models.js";

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
  private providerModels?: EngineModelOption[];
  private claudeCodeVersion?: string;
  private readonly modelInitializationRequestId = `ponderosa-models-${randomUUID()}`;
  private latestContextOccupancy?: number;

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
    const reportRootExit = (code?: number | null, signal?: NodeJS.Signals | null) => {
      if (rootExitReported) return;
      rootExitReported = true;
      opts.onRuntimeRootExit?.({ exitCode: code, signal, stderr: this.stderrTail });
      postExitDrainTimer = setTimeout(() => this.child.stdout?.destroy(), 1_000);
    };
    this.child.stdout?.once("close", () => {
      if (postExitDrainTimer) clearTimeout(postExitDrainTimer);
      postExitDrainTimer = undefined;
    });
    this.child.once("error", () => reportRootExit());
    this.child.once("exit", reportRootExit);
    this.child.stdin?.on("error", () => undefined);
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8192);
    });
    opts.signal.addEventListener("abort", () => { void this.close().catch(() => undefined); });
    this.child.stdin?.write(`${JSON.stringify({
      type: "control_request",
      request_id: this.modelInitializationRequestId,
      request: { subtype: "initialize", hooks: {}, sdkMcpServers: [] },
    })}\n`);
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
      ...(this.opts.model ? {
        selectedModel: this.opts.model,
        model: this.opts.model,
      } : {}),
      commands: [],
      mcpServers: [],
      composerCapabilities: [],
    };
  }

  contextUsage(): { usedTokens: number } | undefined {
    return this.latestContextOccupancy === undefined
      ? undefined
      : { usedTokens: this.latestContextOccupancy };
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
    try {
      for await (const raw of parseJsonlChunks(stdout as AsyncIterable<Buffer>)) {
        this.captureModelInitialization(raw);
        const capabilities = normalizeClaudeInitCapabilities(raw, this.opts.model);
        if (capabilities) {
          this.claudeCodeVersion = raw && typeof raw === "object" &&
            typeof (raw as { claude_code_version?: unknown }).claude_code_version === "string"
            ? (raw as { claude_code_version: string }).claude_code_version
            : this.claudeCodeVersion;
          this.capabilitiesSnapshot = {
            ...capabilities,
            ...(this.liveModelCatalog() ? { modelCatalog: this.liveModelCatalog() } : {}),
          };
          this.opts.onCapabilitiesChanged?.();
        }
        const assistantUsage = mapClaudeAssistantUsage(raw);
        // Claude's local slash commands emit a synthetic assistant message with
        // an all-zero usage object even though no model request occurred. Keep
        // the last real request occupancy instead of resetting it to zero.
        if (assistantUsage?.inputTokens !== undefined && assistantUsage.inputTokens > 0) {
          this.latestContextOccupancy = assistantUsage.inputTokens;
        }
        for (const event of mapClaudeEvent(raw, { cwd: this.opts.cwd })) {
          if (event.type === "turn_done" || event.type === "error") this.active = false;
          yield event;
        }
      }
    } catch (error) {
      if (!(error instanceof JsonlRecordLimitError)) throw error;
      this.active = false;
      yield {
        type: "error",
        message: `Claude stream JSONL record exceeded the ${JSONL_MAX_RECORD_BYTES / (1024 * 1024)} MiB limit`,
      };
      await this.close();
      return;
    }
    if (!this.closed) {
      yield { type: "error", message: `Claude stream stopped${this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ""}` };
    }
  }

  private captureModelInitialization(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const envelope = raw as {
      type?: unknown;
      response?: {
        subtype?: unknown;
        request_id?: unknown;
        response?: { models?: unknown };
      };
    };
    if (envelope.type !== "control_response" ||
        envelope.response?.subtype !== "success" ||
        envelope.response.request_id !== this.modelInitializationRequestId) return;
    try {
      this.providerModels = normalizeClaudeProviderModels(envelope.response.response?.models);
    } catch {
      // Catalog capture is best-effort on the live Run path. Discovery has its
      // own strict probe and must not turn a provider shape change into a Run
      // failure.
      return;
    }
    const modelCatalog = this.liveModelCatalog();
    if (this.capabilitiesSnapshot && modelCatalog) {
      this.capabilitiesSnapshot = { ...this.capabilitiesSnapshot, modelCatalog };
    }
    this.opts.onCapabilitiesChanged?.();
  }

  private liveModelCatalog() {
    if (!this.providerModels || !this.claudeCodeVersion) return undefined;
    return {
      models: this.providerModels,
      cliVersion: this.claudeCodeVersion,
      configurationKey: "live-session",
    };
  }
}
