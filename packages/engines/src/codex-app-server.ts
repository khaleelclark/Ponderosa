import type {
  AgentEvent,
  OpenRuntimeSessionOptions,
  RuntimeSession,
  RuntimeSteerResult,
  RuntimeTurnInput,
} from "@ponderosa/core";
import { mapFileChangeKind } from "./events.js";
import { JsonRpcProcess, type JsonRpcNotification } from "./json-rpc-process.js";
import type { SpawnFn } from "./process.js";

interface ThreadResponse { thread: { id: string } }
interface TurnResponse { turn: { id: string } }
interface SteerResponse { turnId: string }
interface DynamicToolCallParams {
  tool: string;
  namespace?: string | null;
  arguments: unknown;
}

interface AppServerSessionOptions extends OpenRuntimeSessionOptions {
  bin: string;
  spawnFn: SpawnFn;
  sandboxMode: string;
  killGraceMs: number;
}

export class CodexAppServerSession implements RuntimeSession {
  private activeTurnId?: string;
  readonly events: AsyncIterable<AgentEvent>;

  private constructor(
    readonly engineAgentId: string,
    private readonly rpc: JsonRpcProcess,
    private readonly cwd: string,
  ) {
    this.events = this.eventStream();
  }

  static async open(opts: AppServerSessionOptions): Promise<CodexAppServerSession> {
    const rpc = new JsonRpcProcess({
      bin: opts.bin,
      args: [
        "app-server",
        "--stdio",
        "-c", `sandbox_mode=${JSON.stringify(opts.sandboxMode)}`,
        "-c", 'approval_policy="never"',
      ],
      cwd: opts.cwd,
      environment: opts.environment,
      signal: opts.signal,
      spawnFn: opts.spawnFn,
      killGraceMs: opts.killGraceMs,
      handleServerRequest: async (method, params) => {
        if (method !== "item/tool/call" || !opts.handleDynamicToolCall) {
          throw new Error(`unsupported server request: ${method}`);
        }
        const call = params as DynamicToolCallParams;
        const result = await opts.handleDynamicToolCall({
          name: call.namespace ? `${call.namespace}.${call.tool}` : call.tool,
          arguments: call.arguments,
        });
        return {
          success: result.success,
          contentItems: [{ type: "inputText", text: result.text }],
        };
      },
    });
    await rpc.initialize();
    const response = opts.resumeSessionId
      ? await rpc.request<ThreadResponse>("thread/resume", {
          threadId: opts.resumeSessionId,
          cwd: opts.cwd,
          model: opts.model || null,
          approvalPolicy: "never",
          sandbox: opts.sandboxMode,
          excludeTurns: true,
        })
      : await rpc.request<ThreadResponse>("thread/start", {
          cwd: opts.cwd,
          model: opts.model || null,
          approvalPolicy: "never",
          sandbox: opts.sandboxMode,
          ephemeral: false,
          experimentalRawEvents: false,
          dynamicTools: opts.dynamicTools?.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })) ?? null,
        });
    return new CodexAppServerSession(response.thread.id, rpc, opts.cwd);
  }

  async startTurn(input: RuntimeTurnInput): Promise<{ turnId: string }> {
    const response = await this.rpc.request<TurnResponse>("turn/start", {
      threadId: this.engineAgentId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
    });
    this.activeTurnId = response.turn.id;
    return { turnId: response.turn.id };
  }

  async steer(input: RuntimeTurnInput): Promise<RuntimeSteerResult> {
    if (!this.activeTurnId) return { status: "not_active" };
    try {
      const response = await this.rpc.request<SteerResponse>("turn/steer", {
        threadId: this.engineAgentId,
        expectedTurnId: this.activeTurnId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
      });
      return { status: "accepted", turnId: response.turnId };
    } catch (error) {
      const rpcError = error && typeof error === "object" && "rpcError" in error
        ? (error as { rpcError?: { data?: unknown; message?: string } }).rpcError : undefined;
      const serialized = JSON.stringify(rpcError?.data ?? "");
      if (/activeTurnNotSteerable|not steerable/i.test(`${rpcError?.message ?? ""} ${serialized}`)) {
        return { status: "not_steerable", reason: rpcError?.message };
      }
      if (/no active turn|turn.*not found|expectedTurnId/i.test(`${rpcError?.message ?? ""} ${serialized}`)) {
        this.activeTurnId = undefined;
        return { status: "not_active", reason: rpcError?.message };
      }
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activeTurnId) return;
    await this.rpc.request("turn/interrupt", { threadId: this.engineAgentId, turnId: this.activeTurnId });
  }

  close(): Promise<void> {
    return this.rpc.close();
  }

  private async *eventStream(): AsyncIterable<AgentEvent> {
    yield { type: "session", sessionId: this.engineAgentId };
    for await (const notification of this.rpc.notifications) {
      if (notification.method === "turn/started") {
        const turn = (notification.params as { turn?: { id?: string } } | undefined)?.turn;
        if (turn?.id) this.activeTurnId = turn.id;
      }
      if (notification.method === "turn/completed") this.activeTurnId = undefined;
      yield* mapCodexAppServerNotification(notification, this.cwd);
    }
  }
}

export function mapCodexAppServerNotification(notification: JsonRpcNotification, cwd: string): AgentEvent[] {
  const params = notification.params as Record<string, unknown> | undefined;
  if (notification.method === "ponderosa/processError") {
    return [{ type: "error", message: String(params?.message ?? "Codex app-server stopped") }];
  }
  if (notification.method === "item/agentMessage/delta") {
    // Deltas are transport-only progress. Canonical chat records the completed
    // item below so one engine answer never becomes dozens of message rows.
    return [];
  }
  if (notification.method === "item/reasoning/summaryTextDelta" || notification.method === "item/reasoning/textDelta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    return delta ? [{ type: "reasoning", delta }] : [];
  }
  if (notification.method === "turn/completed") {
    const turn = params?.turn as { status?: string; error?: { message?: string } | null } | undefined;
    if (turn?.status === "failed") return [{ type: "error", message: turn.error?.message ?? "Codex turn failed" }];
    return [{ type: "turn_done" }];
  }
  if (notification.method !== "item/started" && notification.method !== "item/completed") return [];
  const item = params?.item as Record<string, unknown> | undefined;
  if (!item || typeof item.type !== "string") return [];
  if (notification.method === "item/started" && item.type === "commandExecution") {
    return typeof item.command === "string" ? [{ type: "command", command: item.command, cwd: typeof item.cwd === "string" ? item.cwd : cwd }] : [];
  }
  if (notification.method === "item/completed" && item.type === "commandExecution") {
    return [{
      type: "tool_result",
      id: typeof item.id === "string" ? item.id : "command",
      output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "",
      ...(typeof item.exitCode === "number" && item.exitCode !== 0 ? { isError: true } : {}),
    }];
  }
  if (notification.method === "item/completed" && item.type === "agentMessage") {
    return typeof item.text === "string" && item.text.trim()
      ? [{ type: "text", delta: item.text }]
      : [];
  }
  if (notification.method === "item/completed" && item.type === "fileChange" && Array.isArray(item.changes)) {
    return item.changes.flatMap((change) => {
      if (!change || typeof change !== "object") return [];
      const value = change as { path?: unknown; kind?: unknown; diff?: unknown };
      return typeof value.path === "string" ? [{
        type: "file_change" as const,
        path: value.path,
        kind: mapFileChangeKind(typeof value.kind === "string" ? value.kind : undefined),
        ...(typeof value.diff === "string" ? { diff: value.diff } : {}),
      }] : [];
    });
  }
  if (notification.method === "item/started" && item.type === "mcpToolCall") {
    return [{
      type: "tool_call",
      id: typeof item.id === "string" ? item.id : "mcp",
      name: `${String(item.server ?? "mcp")}.${String(item.tool ?? "tool")}`,
      input: item.arguments,
    }];
  }
  if (notification.method === "item/completed" && item.type === "mcpToolCall") {
    return [{
      type: "tool_result",
      id: typeof item.id === "string" ? item.id : "mcp",
      output: JSON.stringify(item.result ?? item.error ?? ""),
      ...(item.error ? { isError: true } : {}),
    }];
  }
  if (notification.method === "item/started" && item.type === "dynamicToolCall") {
    const namespace = typeof item.namespace === "string" && item.namespace ? `${item.namespace}.` : "";
    return [{
      type: "tool_call",
      id: typeof item.id === "string" ? item.id : "dynamic-tool",
      name: `${namespace}${String(item.tool ?? "tool")}`,
      input: item.arguments,
    }];
  }
  if (notification.method === "item/completed" && item.type === "dynamicToolCall") {
    return [{
      type: "tool_result",
      id: typeof item.id === "string" ? item.id : "dynamic-tool",
      output: JSON.stringify(item.contentItems ?? []),
      ...(item.success === false ? { isError: true } : {}),
    }];
  }
  return [];
}
