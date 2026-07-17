import type {
  AgentEvent,
  TokenUsage,
  OpenRuntimeSessionOptions,
  RuntimeSession,
  RuntimeSteerResult,
  RuntimeTurnInput,
} from "@ponderosa/core";
import { mapFileChangeKind } from "./events.js";
import { JsonRpcProcess, type JsonRpcNotification } from "./json-rpc-process.js";
import type { SpawnFn } from "./process.js";
import { renderSeedPrompt } from "./seed-history.js";

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
  private readonly usageByTurnId = new Map<string, TokenUsage>();
  private readonly providerRequestUsageByTurnId = new Map<string, TokenUsage[]>();
  private readonly usageCheckpointsByTurnId = new Map<string, Set<string>>();
  private baselineTotal?: TokenUsage;
  private latestTotal?: TokenUsage;
  readonly events: AsyncIterable<AgentEvent>;

  private constructor(
    readonly engineAgentId: string,
    private readonly rpc: JsonRpcProcess,
    private readonly cwd: string,
    fresh: boolean,
    private readonly seedHistory: OpenRuntimeSessionOptions["history"],
  ) {
    if (fresh) this.baselineTotal = zeroUsage();
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
    return new CodexAppServerSession(
      response.thread.id,
      rpc,
      opts.cwd,
      !opts.resumeSessionId,
      opts.resumeSessionId ? [] : [...opts.history],
    );
  }

  async startTurn(input: RuntimeTurnInput): Promise<{ turnId: string }> {
    const prompt = this.seedHistory.length > 0
      ? renderSeedPrompt(this.seedHistory.splice(0), input.prompt)
      : input.prompt;
    const response = await this.rpc.request<TurnResponse>("turn/start", {
      threadId: this.engineAgentId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
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

  isAlive(): boolean {
    return this.rpc.isAlive();
  }

  close(): Promise<void> {
    return this.rpc.close();
  }

  private async *eventStream(): AsyncIterable<AgentEvent> {
    yield { type: "session", sessionId: this.engineAgentId };
    for await (const notification of this.rpc.notifications) {
      if (notification.method === "thread/tokenUsage/updated") {
        const params = notification.params as { turnId?: unknown; tokenUsage?: { total?: unknown; last?: unknown } } | undefined;
        if (typeof params?.turnId === "string") {
          const total = mapCodexTokenUsage(params.tokenUsage?.total);
          if (total) {
            // A resumed thread replays its prior cumulative total before the new
            // turn's events. That checkpoint is the durable interval baseline.
            if (params.turnId !== this.activeTurnId) {
              this.baselineTotal = total;
              this.latestTotal = total;
            } else {
              const usage = this.baselineTotal ? subtractUsage(total, this.baselineTotal) : undefined;
              if (usage) this.usageByTurnId.set(params.turnId, usage);
              else this.usageByTurnId.delete(params.turnId);
              const requestUsage = mapCodexTokenUsage(params.tokenUsage?.last);
              if (requestUsage) {
                const checkpoint = usageCheckpointKey(total);
                const seen = this.usageCheckpointsByTurnId.get(params.turnId) ?? new Set<string>();
                if (!seen.has(checkpoint)) {
                  seen.add(checkpoint);
                  this.usageCheckpointsByTurnId.set(params.turnId, seen);
                  const requests = this.providerRequestUsageByTurnId.get(params.turnId) ?? [];
                  requests.push(requestUsage);
                  this.providerRequestUsageByTurnId.set(params.turnId, requests);
                }
              }
              this.latestTotal = total;
            }
          }
        }
        continue;
      }
      if (notification.method === "turn/started") {
        const turn = (notification.params as { turn?: { id?: string } } | undefined)?.turn;
        if (turn?.id) this.activeTurnId = turn.id;
      }
      const completedTurnId = notification.method === "turn/completed"
        ? ((notification.params as { turn?: { id?: unknown } } | undefined)?.turn?.id)
        : undefined;
      if (notification.method === "turn/completed") this.activeTurnId = undefined;
      const completedRequestUsage = typeof completedTurnId === "string"
        ? this.providerRequestUsageByTurnId.get(completedTurnId) ?? []
        : [];
      const completedUsage = typeof completedTurnId === "string"
        ? this.usageByTurnId.get(completedTurnId) ?? sumProviderRequestUsage(completedRequestUsage)
        : undefined;
      const providerRequestUsage = completedUsage
        ? reconcileProviderRequestUsage(completedUsage, completedRequestUsage)
        : undefined;
      yield* mapCodexAppServerNotification(
        notification,
        this.cwd,
        completedUsage,
        providerRequestUsage,
      );
      if (typeof completedTurnId === "string") {
        this.usageByTurnId.delete(completedTurnId);
        this.providerRequestUsageByTurnId.delete(completedTurnId);
        this.usageCheckpointsByTurnId.delete(completedTurnId);
        if (this.latestTotal) this.baselineTotal = this.latestTotal;
      }
    }
  }
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

const USAGE_KEYS: Array<keyof TokenUsage> = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
];

function usageCheckpointKey(usage: TokenUsage): string {
  return USAGE_KEYS.map((key) => usage[key] ?? "").join(":");
}

/** Keep request detail only when it reconciles to the canonical turn aggregate. */
export function reconcileProviderRequestUsage(aggregate: TokenUsage, requests: TokenUsage[]): TokenUsage[] | undefined {
  if (!requests.length || aggregate.inputTokens === undefined || aggregate.outputTokens === undefined) return undefined;
  const pricingKeys: Array<keyof TokenUsage> = [
    "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "totalTokens",
  ];
  const sums = new Map<keyof TokenUsage, number>(pricingKeys.map((key) => [key, 0]));
  for (const request of requests) {
    if (request.inputTokens === undefined || request.outputTokens === undefined) return undefined;
    const cached = request.cachedInputTokens ?? 0;
    const cacheWrite = request.cacheWriteInputTokens ?? 0;
    if (cached + cacheWrite > request.inputTokens) return undefined;
    for (const key of pricingKeys) {
      const value = request[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) return undefined;
      sums.set(key, sums.get(key)! + value);
    }
  }
  for (const key of pricingKeys) {
    if ((aggregate[key] ?? 0) !== sums.get(key)) return undefined;
  }
  return requests;
}

/** Recover an exact turn aggregate from Codex's per-request `last` checkpoints.
 * This is independent of the cumulative thread baseline, which may be absent
 * on the first successful turn after a process crash or provider retry. */
export function sumProviderRequestUsage(requests: TokenUsage[]): TokenUsage | undefined {
  if (!requests.length) return undefined;
  const requiredKeys: Array<keyof TokenUsage> = ["inputTokens", "outputTokens", "totalTokens"];
  const optionalKeys: Array<keyof TokenUsage> = ["cachedInputTokens", "cacheWriteInputTokens", "reasoningOutputTokens"];
  const sums = new Map<keyof TokenUsage, number>();
  for (const request of requests) {
    if (requiredKeys.some((key) => !Number.isSafeInteger(request[key]) || request[key]! < 0)) return undefined;
    if (optionalKeys.some((key) => request[key] !== undefined &&
        (!Number.isSafeInteger(request[key]) || request[key]! < 0))) return undefined;
    if ((request.cachedInputTokens ?? 0) + (request.cacheWriteInputTokens ?? 0) > request.inputTokens!) return undefined;
    if ((request.reasoningOutputTokens ?? 0) > request.outputTokens!) return undefined;
    for (const key of [...requiredKeys, ...optionalKeys]) {
      if (request[key] !== undefined) sums.set(key, (sums.get(key) ?? 0) + request[key]!);
    }
  }
  return {
    inputTokens: sums.get("inputTokens")!,
    ...(sums.has("cachedInputTokens") ? { cachedInputTokens: sums.get("cachedInputTokens")! } : {}),
    ...(sums.has("cacheWriteInputTokens") ? { cacheWriteInputTokens: sums.get("cacheWriteInputTokens")! } : {}),
    outputTokens: sums.get("outputTokens")!,
    ...(sums.has("reasoningOutputTokens") ? { reasoningOutputTokens: sums.get("reasoningOutputTokens")! } : {}),
    totalTokens: sums.get("totalTokens")!,
  };
}

/** Delta compatible absolute thread checkpoints; any reset fails closed. */
export function subtractUsage(total: TokenUsage, baseline: TokenUsage): TokenUsage | undefined {
  const delta = (key: keyof TokenUsage): number | undefined => {
    const end = total[key];
    const start = baseline[key];
    if (typeof end !== "number" || typeof start !== "number" || end < start) return undefined;
    return end - start;
  };
  const inputTokens = delta("inputTokens");
  const cachedInputTokens = delta("cachedInputTokens");
  const outputTokens = delta("outputTokens");
  const reasoningOutputTokens = delta("reasoningOutputTokens");
  const totalTokens = delta("totalTokens");
  if (totalTokens === undefined || inputTokens === undefined || outputTokens === undefined) return undefined;
  if (cachedInputTokens !== undefined && cachedInputTokens > inputTokens) return undefined;
  if (reasoningOutputTokens !== undefined && reasoningOutputTokens > outputTokens) return undefined;
  return {
    inputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    outputTokens,
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    totalTokens,
  };
}

export function mapCodexTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const number = (key: string) => typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] as number : undefined;
  const inputTokens = number("inputTokens");
  const cachedInputTokens = number("cachedInputTokens");
  const outputTokens = number("outputTokens");
  const reasoningOutputTokens = number("reasoningOutputTokens");
  const providerTotal = number("totalTokens");
  if ([inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, providerTotal].every((item) => item === undefined)) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    totalTokens: providerTotal ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

export function mapCodexAppServerNotification(
  notification: JsonRpcNotification,
  cwd: string,
  usage?: TokenUsage,
  providerRequestUsage?: TokenUsage[],
): AgentEvent[] {
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
    return [{
      type: "turn_done",
      ...(usage ? { usage } : {}),
      ...(providerRequestUsage ? { providerRequestUsage } : {}),
    }];
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
      // Each completed agentMessage is a semantic response block, not a token
      // delta. Keep adjacent blocks separated in the durable Work log.
      ? [{ type: "text", delta: `${item.text.trimEnd()}\n\n` }]
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
