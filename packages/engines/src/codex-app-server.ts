import { steeringPreflight } from "./steering-preflight.js";
import { answerCodexNativeQuestions } from "./native-questions.js";
import { codexTurnContent } from "./typed-input.js";
import { codexGoalSnapshot, codexNativeObservation, invokeCodexGoal, setCodexPlanMode, startCodexReview } from "./codex-native-actions.js";
import { answerCodexNativeApproval, CODEX_NATIVE_APPROVAL_METHODS } from "./native-approvals.js";
import { forkCodexTranscript } from "./codex-transcript-fork.js";
import { CodexBackgroundTasks } from "./codex-background-tasks.js";
import { tokenCount, tokenSum } from "./token-count.js";
import { normalizedToolResult } from "./tool-result.js";
import {
  truncateUnicodeCodePoints,
  type AgentEvent,
  type EngineCapabilities,
  type EngineMcpServer,
  type TokenUsage,
  type OpenRuntimeSessionOptions,
  type RuntimeSession,
  type RuntimeCommandResult,
  type RuntimeElicitationRequest,
  type RuntimeSteerResult,
  type RuntimeTurnInput,
  type RuntimeProcessHandle,
  type NativeGoalSnapshot,
  safeProviderConnectionUrl,
} from "@ponderosa/core";
import { stripVTControlCharacters } from "node:util";
import { commandOutcome, mapFileChangeKind, providerErrorCodeFromDetail, codexErrorEvent } from "./events.js";
import { JsonRpcOutputLimitError, JsonRpcProcess, type JsonRpcNotification } from "./json-rpc-process.js";
import { renderSeedPrompt } from "./seed-history.js";
import { normalizeCodexProviderDiscovery } from "./capabilities.js";
import { codexRateLimitBuckets } from "./provider-usage.js";

/** Query the exact persisted goal before resuming and at native turn boundaries.
 * Unsupported is limited to explicit protocol/feature refusals; transport and
 * malformed responses never prove the absence of an active goal. */
async function readNativeGoal(rpc: JsonRpcProcess, threadId: string): Promise<NativeGoalSnapshot | null | undefined> {
  let response: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    response = await Promise.race([
      rpc.request("thread/goal/get", { threadId }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Native goal read timed out")), 10_000); }),
    ]);
  }
  catch (error) {
    const rpcError = error && typeof error === "object" && "rpcError" in error
      ? (error as {rpcError?: {code?: unknown; message?: unknown}}).rpcError : undefined;
    if (rpcError?.code === -32601 || rpcError?.message === "goals feature is disabled") return undefined;
    throw new Error("Native goal state is unavailable; retained work remains held", {cause:error});
  } finally { if (timer) clearTimeout(timer); }
  const result = object(response);
  if (!result || !Object.hasOwn(result, "goal")) throw new Error("Native goal state is malformed; retained work remains held");
  return codexGoalSnapshot(result.goal, threadId);
}

async function setNativeGoalOnce(rpc: JsonRpcProcess, threadId:string, status:"active"|"paused",
  create?:{objective:string;tokenBudget?:number|null}): Promise<NativeGoalSnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = object(await Promise.race([
      rpc.request("thread/goal/set", {threadId,status,origin:"user",...create}),
      new Promise<never>((_resolve,reject) => { timer=setTimeout(() => reject(new Error("Native goal mutation timed out")),10_000); }),
    ]));
    const goal = response && codexGoalSnapshot(response.goal, threadId);
    if (!goal || goal.status !== status) throw new Error("Native goal mutation was not confirmed");
    return goal;
  } finally { if (timer) clearTimeout(timer); }
}

interface ThreadResponse { thread: { id: string }; model?: string }
interface TurnResponse { turn: { id: string } }
interface SteerResponse { turnId: string }
interface DynamicToolCallParams {
  callId?: string;
  tool: string;
  namespace?: string | null;
  arguments: unknown;
}

function normalizeElicitationRequest(params: unknown): RuntimeElicitationRequest {
  const value = object(params);
  if (!value) throw new Error("invalid MCP elicitation request");
  const serverName = typeof value?.serverName === "string"
    ? truncateUnicodeCodePoints(
        value.serverName
          .normalize("NFC")
          .replace(/[\u0000-\u001f\u007f]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim(),
        200,
      )
    : "";
  const message = typeof value?.message === "string" ? value.message.trim() : "";
  const mode = value?.mode;
  if (!serverName || !message) throw new Error("invalid MCP elicitation request");
  if (mode === "url") {
    const url = safeProviderConnectionUrl(value.url);
    if (!url) {
      throw new Error("MCP URL elicitation is missing its URL");
    }
    return {
      mode,
      serverName,
      message,
      ...(typeof value.elicitationId === "string" && value.elicitationId.trim()
        ? { elicitationId: value.elicitationId.trim() }
        : {}),
      url,
    };
  }
  if (mode === "form" || mode === "openai/form") {
    const requestedSchema = object(value.requestedSchema);
    if (!requestedSchema) throw new Error("MCP form elicitation is missing its schema");
    return { mode, serverName, message, requestedSchema };
  }
  throw new Error("unsupported MCP elicitation mode");
}

interface AppServerSessionOptions extends OpenRuntimeSessionOptions {
  bin: string;
  sandboxMode: string;
  killGraceMs: number;
  enableFastMode: boolean;
  configuredMcps?: EngineMcpServer[];
}

export function codexCapabilityRuntimeOptions(
  sandboxMode: string,
  restrictions: OpenRuntimeSessionOptions["capabilityRestrictions"],
): { sandboxMode: string; config?: Record<string, Record<string, { enabled: boolean }>> } {
  const restrictedConnectors = [...new Set(restrictions?.restrictedConnectorNames ?? [])].sort();
  return {
    sandboxMode: restrictions?.filesystemWriteRestricted ? "read-only" : sandboxMode,
    ...(restrictedConnectors.length ? {
      config: {
        apps: Object.fromEntries(restrictedConnectors.map(name => [name, { enabled: false }])),
        mcp_servers: Object.fromEntries(restrictedConnectors.map(name => [name, { enabled: false }])),
      },
    } : {}),
  };
}

async function optionalRequest(rpc: JsonRpcProcess, method: string, params: unknown): Promise<unknown> {
  try { return await rpc.request(method, params); }
  catch (error) { if (error instanceof JsonRpcOutputLimitError) throw error; return undefined; }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function codexCliVersion(initialization: unknown): string {
  const agent = object(initialization)?.userAgent;
  return typeof agent === "string" && agent.length <= 512
    ? /^ponderosa\/([0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?)(?:\s|$)/u.exec(agent)?.[1] ?? "unknown"
    : "unknown";
}

const UNSAFE_TERMINAL_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

/**
 * Normalizes terminal-derived command output before it crosses the strict
 * provider-event projection boundary. Formatting and unsafe terminal control
 * characters are transport detail; tabs, line endings, and Unicode are
 * preserved as command-result content.
 */
function sanitizeTerminalOutput(value: string): string {
  return stripVTControlCharacters(value).replace(UNSAFE_TERMINAL_CONTROL, "");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function serviceTierForSpeed(speed: string | undefined): string | null {
  return speed && speed !== "standard" ? speed : null;
}

function isApprovalPolicy(value: unknown): boolean {
  if (value === "untrusted" || value === "on-request" || value === "never") return true;
  const granular = object(object(value)?.granular);
  return typeof granular?.sandbox_approval === "boolean" &&
    typeof granular.rules === "boolean" &&
    typeof granular.skill_approval === "boolean" &&
    typeof granular.request_permissions === "boolean" &&
    typeof granular.mcp_elicitations === "boolean";
}

function isSandboxPolicy(value: unknown): boolean {
  const policy = object(value);
  if (policy?.type === "dangerFullAccess") return true;
  if (policy?.type === "readOnly") return typeof policy.networkAccess === "boolean";
  if (policy?.type === "externalSandbox") {
    return policy.networkAccess === "restricted" || policy.networkAccess === "enabled";
  }
  return policy?.type === "workspaceWrite" &&
    Array.isArray(policy.writableRoots) && policy.writableRoots.every((root) => typeof root === "string") &&
    typeof policy.networkAccess === "boolean" &&
    typeof policy.excludeTmpdirEnvVar === "boolean" &&
    typeof policy.excludeSlashTmp === "boolean";
}

function isActivePermissionProfile(value: unknown): boolean {
  if (value === null) return true;
  const profile = object(value);
  return typeof profile?.id === "string" && isNullableString(profile.extends);
}

function isCollaborationMode(value: unknown): boolean {
  const mode = object(value);
  const settings = object(mode?.settings);
  return (mode?.mode === "plan" || mode?.mode === "default") &&
    typeof settings?.model === "string" &&
    isNullableString(settings.reasoning_effort) &&
    isNullableString(settings.developer_instructions);
}

function isMultiAgentMode(value: unknown): boolean {
  if (value === "explicitRequestOnly" || value === "proactive") return true;
  const mode = object(value);
  return !!mode &&
    Object.keys(mode).length === 1 &&
    Object.hasOwn(mode, "custom") &&
    typeof mode.custom === "string" &&
    !!mode.custom.trim();
}

function isThreadSettings(value: unknown): value is Record<string, unknown> & { model: string } {
  const settings = object(value);
  return typeof settings?.cwd === "string" &&
    isApprovalPolicy(settings.approvalPolicy) &&
    (settings.approvalsReviewer === "user" || settings.approvalsReviewer === "auto_review" ||
      settings.approvalsReviewer === "guardian_subagent") &&
    isSandboxPolicy(settings.sandboxPolicy) &&
    isActivePermissionProfile(settings.activePermissionProfile) &&
    typeof settings.model === "string" && !!settings.model.trim() &&
    typeof settings.modelProvider === "string" && !!settings.modelProvider.trim() &&
    isNullableString(settings.serviceTier) &&
    isNullableString(settings.effort) &&
    (settings.summary === null || settings.summary === "auto" || settings.summary === "concise" ||
      settings.summary === "detailed" || settings.summary === "none") &&
    isCollaborationMode(settings.collaborationMode) &&
    isMultiAgentMode(settings.multiAgentMode) &&
    (settings.personality === null || settings.personality === "none" ||
      settings.personality === "friendly" || settings.personality === "pragmatic");
}

function isModelReroutedNotification(value: unknown): value is Record<string, unknown> & { toModel: string } {
  const notification = object(value);
  return typeof notification?.threadId === "string" &&
    typeof notification.turnId === "string" && !!notification.turnId.trim() &&
    typeof notification.fromModel === "string" && !!notification.fromModel.trim() &&
    typeof notification.toModel === "string" && !!notification.toModel.trim() &&
    notification.reason === "highRiskCyberActivity";
}

async function optionalPaginatedRequest(
  rpc: JsonRpcProcess,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    const data: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = object(await rpc.request(method, { ...params, ...(cursor ? { cursor } : {}) }));
      if (!response || !Array.isArray(response.data)) return undefined;
      if (response.nextCursor !== undefined && response.nextCursor !== null && typeof response.nextCursor !== "string") return undefined;
      data.push(...response.data);
      const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
        ? response.nextCursor
        : undefined;
      if (!nextCursor) return { data, nextCursor: null };
      if (seenCursors.has(nextCursor)) throw new Error(`${method} repeated pagination cursor`);
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error(`${method} exceeded pagination limit`);
  } catch (error) {
    if (error instanceof JsonRpcOutputLimitError) throw error;
    return undefined;
  }
}

async function readInstalledPluginDetails(rpc: JsonRpcProcess, response: unknown): Promise<unknown[]> {
  const requests: Promise<unknown>[] = [];
  const marketplaces = object(response)?.marketplaces;
  for (const candidate of Array.isArray(marketplaces) ? marketplaces : []) {
    const marketplace = object(candidate);
    const marketplaceName = typeof marketplace?.name === "string" ? marketplace.name : undefined;
    const marketplacePath = typeof marketplace?.path === "string" ? marketplace.path : undefined;
    const plugins = marketplace?.plugins;
    for (const item of Array.isArray(plugins) ? plugins : []) {
      const plugin = object(item);
      if (plugin?.installed !== true || plugin.enabled !== true || typeof plugin.name !== "string") continue;
      const remotePluginId = typeof plugin.remotePluginId === "string" ? plugin.remotePluginId : undefined;
      requests.push(optionalRequest(rpc, "plugin/read", {
        // Remote marketplaces address plugin/read by the provider's remote id;
        // local marketplaces address it by the manifest name.
        pluginName: marketplacePath ? plugin.name : remotePluginId ?? plugin.name,
        ...(marketplacePath
          ? { marketplacePath }
          : marketplaceName
            ? { remoteMarketplaceName: marketplaceName }
            : {}),
      }));
    }
  }
  return (await Promise.all(requests)).filter((detail) => detail !== undefined);
}

export async function discoverCodexAppServerCapabilities(opts: {
  bin: string;
  cwd: string;
  model?: string;
  sandboxMode: string;
  killGraceMs: number;
  configuredMcps: EngineMcpServer[];
  signal: AbortSignal;
  onRuntimeSpawned: (handle: RuntimeProcessHandle) => void;
  timeoutMs?: number;
  modelCatalogOnly?: boolean;
}): Promise<EngineCapabilities> {
  if (opts.signal.aborted) throw new Error("codex app-server capability discovery aborted");
  const controller = new AbortController();
  const abortFromHost = (): void => controller.abort();
  opts.signal.addEventListener("abort", abortFromHost);
  if (opts.signal.aborted) controller.abort();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? 15_000);
  timeout.unref();
  const rpc = new JsonRpcProcess({
    bin: opts.bin,
    args: [
      "app-server", "--stdio",
      "-c", `sandbox_mode=${JSON.stringify(opts.sandboxMode)}`,
      "-c", 'approval_policy="never"',
    ],
    cwd: opts.cwd,
    signal: controller.signal,
    killGraceMs: opts.killGraceMs,
    onRuntimeSpawned: opts.onRuntimeSpawned,
    onRuntimeRootExit: () => undefined,
    // Short-lived inventory has no notification consumer. Active Run sessions
    // retain their normal streaming contract without this aggregate budget.
    maxOutputBytes: 8 * 1024 * 1024,
  });
  let cliVersion = "unknown";
  try {
    try {
      cliVersion = codexCliVersion(await rpc.initialize());
    } catch (error) {
      if (!timedOut) throw error;
      return normalizeCodexProviderDiscovery({
        cwd: opts.cwd,
        selectedModel: opts.model,
        configuredMcps: opts.configuredMcps,
      });
    }
    if (opts.modelCatalogOnly) {
      const models = await optionalPaginatedRequest(rpc, "model/list", { includeHidden: false });
      rpc.throwIfFailed();
      return normalizeCodexProviderDiscovery({ cwd: opts.cwd, cliVersion, models });
    }
    const [skills, plugins, models, modelProviderCapabilities, mcpStatuses] = await Promise.all([
      optionalRequest(rpc, "skills/list", { cwds: [opts.cwd], forceReload: true }),
      optionalRequest(rpc, "plugin/installed", { cwds: [opts.cwd] }),
      optionalPaginatedRequest(rpc, "model/list", { includeHidden: false }),
      optionalRequest(rpc, "modelProvider/capabilities/read", {}),
      optionalPaginatedRequest(rpc, "mcpServerStatus/list", { detail: "toolsAndAuthOnly" }),
    ]);
    const pluginDetails = await readInstalledPluginDetails(rpc, plugins);
    rpc.throwIfFailed();
    return normalizeCodexProviderDiscovery({
      cwd: opts.cwd,
      cliVersion,
      selectedModel: opts.model,
      skills,
      plugins,
      pluginDetails,
      models,
      modelProviderCapabilities,
      mcpStatuses,
      configuredMcps: opts.configuredMcps,
    });
  } finally {
    clearTimeout(timeout);
    opts.signal.removeEventListener("abort", abortFromHost);
    controller.abort();
    // Cleanup failure is authoritative: the host retains the spawn-time handle
    // and must keep Project deletion/shutdown pending until a retry observes
    // the complete process group gone.
    await rpc.close();
  }
}
export interface CodexContextUsage {
  usedTokens: number;
  aggregateTokens?: number;
  modelContextWindow?: number;
}

/** Codex reports cumulative traffic and last-request occupancy together. Keep
 * those meanings separate so aggregate billing telemetry can never trigger a
 * context rollover. */
export function codexContextUsageSnapshot(tokenUsage: {
  total?: unknown;
  last?: unknown;
  modelContextWindow?: unknown;
} | undefined): CodexContextUsage | undefined {
  const aggregate = mapCodexTokenUsage(tokenUsage?.total);
  const last = mapCodexTokenUsage(tokenUsage?.last);
  if (!last) return undefined;
  const modelContextWindow = typeof tokenUsage?.modelContextWindow === "number" &&
    Number.isFinite(tokenUsage.modelContextWindow) && tokenUsage.modelContextWindow > 0
    ? tokenUsage.modelContextWindow
    : undefined;
  return {
    usedTokens: last.totalTokens ?? (last.inputTokens ?? 0) + (last.outputTokens ?? 0),
    ...(aggregate?.totalTokens !== undefined ? { aggregateTokens: aggregate.totalTokens } : {}),
    ...(modelContextWindow ? { modelContextWindow } : {}),
  };
}

function rateWindowLabel(window: Record<string, unknown>): string | undefined {
  const usedPercent = typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
    ? Math.max(0, Math.min(100, window.usedPercent))
    : undefined;
  if (usedPercent === undefined) return undefined;
  const minutes = typeof window.windowDurationMins === "number" && window.windowDurationMins > 0
    ? window.windowDurationMins
    : undefined;
  const duration = minutes === undefined
    ? "Rate limit"
    : minutes % (24 * 60) === 0
      ? `${minutes / (24 * 60)}d limit`
      : minutes % 60 === 0
        ? `${minutes / 60}h limit`
        : `${minutes}m limit`;
  return `${duration} ${Math.round(usedPercent)}% used`;
}

export function formatCodexStatus(input: {
  sessionId: string;
  model?: string;
  context?: CodexContextUsage;
  rateLimits?: unknown;
}): string {
  const parts = [`Codex session ${input.sessionId}`, `Model ${input.model ?? "provider default"}`];
  if (input.context?.modelContextWindow) {
    const usedPercent = Math.min(100, (input.context.usedTokens / input.context.modelContextWindow) * 100);
    parts.push(`Context ${Math.round(usedPercent)}% used (${input.context.usedTokens.toLocaleString()} of ${input.context.modelContextWindow.toLocaleString()} tokens)`);
  } else if (input.context) {
    parts.push(`Context occupancy ${input.context.usedTokens.toLocaleString()} tokens; context-window size not reported`);
  } else {
    parts.push("Context usage not yet reported");
  }
  parts.push(...formatCodexRateLimits(input.rateLimits));
  return parts.join(" · ");
}

export function formatCodexRateLimits(rateLimits: unknown): string[] {
  const parts: string[] = [];
  const byId = codexRateLimitBuckets(rateLimits);
  const snapshots = Object.entries(byId ?? {}).flatMap(([id, value]) => {
    const snapshot = object(value);
    return snapshot ? [{ id: id as string | undefined, snapshot }] : [];
  });
  const qualify = snapshots.length > 1;
  for (const { id, snapshot } of snapshots) {
    const name = typeof snapshot.limitName === "string" && snapshot.limitName.trim()
      ? snapshot.limitName.trim()
      : id;
    for (const candidate of [object(snapshot.primary), object(snapshot.secondary)]) {
      if (!candidate) continue;
      const label = rateWindowLabel(candidate);
      if (label) parts.push(qualify && name ? `${name}: ${label}` : label);
    }
    if (snapshot.rateLimitReachedType) {
      parts.push(qualify && name ? `${name}: Provider limit reached` : "Provider limit reached");
    }
  }
  return parts;
}

/** Wakes native-command waits on asynchronous provider observations. A command
 * acknowledgement alone is not completion or fresh context evidence. */
export class ContextUsageObservationGate {
  private version = 0;
  private readonly waiters = new Set<() => void>();

  currentVersion(): number {
    return this.version;
  }

  observe(): void {
    this.version += 1;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  waitAfter(version: number, timeoutMs = 10_000): Promise<void> {
    if (this.version > version) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onUsage = () => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.waiters.delete(onUsage);
        reject(new Error("Codex native command observation timed out"));
      }, timeoutMs);
      timeout.unref?.();
      this.waiters.add(onUsage);
    });
  }
}

interface CompactOperation {
  rpcStatus?: "accepted" | "rejected";
  turnId?: string;
  itemId?: string;
  itemCompleted: boolean;
  terminalStatus?: string;
  usage?: CodexContextUsage;
  closed: boolean;
}

import { CodexResponseText } from "./codex-response-text.js";

export class CodexAppServerSession implements RuntimeSession {
  readonly validatesResumeBeforeTurn = true;
  private readonly backgroundTasks: CodexBackgroundTasks;
  private nativeTaskReceiptSeen = false;
  private readonly nativeTaskItems = new Map<string,string>();
  private nativeTaskHold = false;
  private closingNativeTasks = false;
  private activeTurnId?: string;
  private observedTurnStarts = 0;
  private goalOwned = false;
  private goalStatus?: NativeGoalSnapshot["status"];
  private goalMarkerEmitted = false;
  private goalPauseAttempted = false;
  private accountGeneration = 0;
  private readonly usageByTurnId = new Map<string, TokenUsage>();
  private readonly providerRequestUsageByTurnId = new Map<string, TokenUsage[]>();
  private readonly usageCheckpointsByTurnId = new Map<string, Set<string>>();
  private baselineTotal?: TokenUsage;
  private latestTotal?: TokenUsage;
  private latestContextUsage?: CodexContextUsage;
  private readonly contextUsageGate = new ContextUsageObservationGate();
  private compactOperation?: CompactOperation;
  private lastCompletedTurnId?: string;
  private readonly nativeCommandNotifications = new WeakSet<JsonRpcNotification>();
  private capabilitiesSnapshot?: EngineCapabilities;
  private capabilitiesDiscovery?: Promise<EngineCapabilities>;
  private capabilitiesDirty = true;
  private catalogGeneration = 0;
  private providerModelGeneration = 0;
  private readonly mcpStartup = new Map<string, { status: string; error?: string }>();
  readonly events: AsyncIterable<AgentEvent>;
  readonly processIdentity: RuntimeSession["processIdentity"];

  private constructor(
    readonly engineAgentId: string,
    private readonly rpc: JsonRpcProcess,
    private readonly cwd: string,
    fresh: boolean,
    private readonly seedHistory: OpenRuntimeSessionOptions["history"],
    private activeModel: string | undefined,
    private readonly configuredMcps: EngineMcpServer[],
    private readonly onCapabilitiesChanged: (() => void) | undefined,
    private readonly cliVersion: string,
    private readonly expectedBillingMode?: "subscription" | "api",
  ) {
    this.backgroundTasks = new CodexBackgroundTasks(engineAgentId, (method, params) => rpc.request(method, params));
    this.processIdentity = rpc.processIdentity;
    if (fresh) this.baselineTotal = zeroUsage();
    this.events = this.eventStream();
  }

  static async open(opts: AppServerSessionOptions): Promise<CodexAppServerSession> {
    if (!opts.onRuntimeSpawned) {
      throw new Error("persistent runtime opening requires a spawn-time termination registrar");
    }
    let session: CodexAppServerSession | undefined;
    const {sandboxMode:effectiveSandboxMode,config:sessionConfig}=codexCapabilityRuntimeOptions(opts.sandboxMode,opts.capabilityRestrictions);
    const restrictedConnectors=new Set(opts.capabilityRestrictions?.restrictedConnectorNames??[]);
    const nativeApprovalRequests = new Set<string>();
    const pendingNativeApprovals = new Map<string, { turnId: string; controller: AbortController }>();
    const approvalPolicy = opts.handleElicitation ? "on-request" : "never";
    const rpc = new JsonRpcProcess({
      bin: opts.bin,
      args: [
        "app-server",
        "--stdio",
        "-c", `sandbox_mode=${JSON.stringify(effectiveSandboxMode)}`,
        "-c", `approval_policy=${JSON.stringify(approvalPolicy)}`,
        ...(opts.enableFastMode ? ["-c", "features.fast_mode=true"] : []),
      ],
      cwd: opts.cwd,
      environment: opts.environment,
      signal: opts.signal,
      killGraceMs: opts.killGraceMs,
      onRuntimeSpawned: opts.onRuntimeSpawned,
      onRuntimeRootExit: detail => {
        for (const pending of pendingNativeApprovals.values()) pending.controller.abort();
        pendingNativeApprovals.clear();
        session?.stopCompactObservation();
        opts.onRuntimeRootExit(detail);
      },
      onNotification: (notification) => {
        const params = object(notification.params);
        const turn = object(params?.turn);
        if (session && params?.threadId === session.engineAgentId && notification.method === "turn/completed") {
          for (const pending of pendingNativeApprovals.values()) if (pending.turnId === turn?.id) pending.controller.abort();
        }
        if (session && params?.threadId === session.engineAgentId && notification.method === "serverRequest/resolved" &&
            (typeof params.requestId === "string" || typeof params.requestId === "number")) pendingNativeApprovals.get(String(params.requestId))?.controller.abort();
        session?.observeNotification(notification);
      },
      handleServerRequest: async (requestId, method, params) => {
        if (CODEX_NATIVE_APPROVAL_METHODS.has(method) || method === "item/tool/requestUserInput") {
          if (!session || nativeApprovalRequests.has(String(requestId)) || nativeApprovalRequests.size >= 10_000) throw new Error("Native approval has no fresh owned identity");
          nativeApprovalRequests.add(String(requestId));
          const controller = new AbortController();
          const turnId = object(params)?.turnId;
          if (typeof turnId !== "string") throw new Error("Native approval has no exact turn");
          pendingNativeApprovals.set(String(requestId), { turnId, controller });
          try {
            const questionOptions = { ...opts, signal: AbortSignal.any([opts.signal, controller.signal]) };
            return method === "item/tool/requestUserInput"
              ? await answerCodexNativeQuestions(questionOptions, session.engineAgentId, () => session?.activeTurnId, String(requestId), params)
              : await answerCodexNativeApproval(questionOptions, session.engineAgentId, () => session?.activeTurnId, String(requestId), method, params);
          } finally { pendingNativeApprovals.delete(String(requestId)); }
        }
        if (method === "mcpServer/elicitation/request") {
          if (!opts.handleElicitation) throw new Error("MCP elicitation is unavailable");
          return opts.handleElicitation(normalizeElicitationRequest(params));
        }
        if (/request[_/]?user[_/]?input|ask[_/]?user[_/]?question/iu.test(method)) {
          throw new Error("Ponderosa cannot display this provider-native question. Call ponderosa_decision so the user receives it in their Chat.");
        }
        if (method !== "item/tool/call" || !opts.handleDynamicToolCall) {
          throw new Error(`unsupported server request: ${method}`);
        }
        if (session) await session.validateBillingMode();
        const call = params as DynamicToolCallParams;
        if (/^(?:request_user_input(?:_async)?|AskUserQuestion)$/iu.test(call.tool)) {
          throw new Error("Ponderosa cannot display this provider-native question. Call ponderosa_decision so the user receives it in their Chat.");
        }
        const result = await opts.handleDynamicToolCall({
          id: String(requestId),
          ...(typeof call.callId === "string" && call.callId ? { operationId: call.callId } : {}),
          name: call.namespace ? `${call.namespace}.${call.tool}` : call.tool,
          arguments: call.arguments,
        });
        return {
          success: result.success,
          contentItems: [{ type: "inputText", text: result.text }],
        };
      },
    });
    const cliVersion = codexCliVersion(await rpc.initialize());
    if (opts.expectedBillingMode) await requireCodexBillingMode(rpc, opts.expectedBillingMode);
    const fork = opts.transcriptFork ? await forkCodexTranscript(rpc,opts.transcriptFork.sourceSessionId,opts.transcriptFork.throughId,() => {
      if (opts.signal.aborted) throw new Error("Fork lost Run authority");
      opts.assertHistoryCurrent?.();
    }, {cwd:opts.cwd,model:opts.model || null,serviceTier:serviceTierForSpeed(opts.speed),approvalPolicy:opts.handleElicitation?"on-request":"never",sandbox:effectiveSandboxMode,
      ...(sessionConfig?{config:sessionConfig}:{}),developerInstructions:opts.systemPrompt ?? null}) : undefined;
    if (fork?.sessionId)opts.onTranscriptForkObserved?.(fork.sessionId);
    if (fork && (fork.outcome !== "completed" || !fork.sessionId)) throw new Error("Native transcript fork outcome unknown; do not repeat");
    if (opts.resumeSessionId && !opts.transcriptFork) {
      try {
        const goal = await readNativeGoal(rpc, opts.resumeSessionId);
        if (goal?.status === "active") throw new Error("The saved session has an active native goal; its outcome remains held for review");
      } catch (error) {
        try { await rpc.close(); } catch { /* the host retains the registered cleanup handle */ }
        throw error;
      }
    }
    const response: ThreadResponse = fork?.sessionId ? {thread:{id:fork.sessionId},model:opts.model} : opts.resumeSessionId
      ? await rpc.request<ThreadResponse>("thread/resume", {
          threadId: opts.resumeSessionId,
          cwd: opts.cwd,
          model: opts.model || null,
          serviceTier: serviceTierForSpeed(opts.speed),
          approvalPolicy,
          sandbox: effectiveSandboxMode,
          ...(sessionConfig?{config:sessionConfig}:{}),
          developerInstructions: opts.systemPrompt ?? null,
        })
      : await rpc.request<ThreadResponse>("thread/start", {
          cwd: opts.cwd,
          model: opts.model || null,
          serviceTier: serviceTierForSpeed(opts.speed),
          approvalPolicy,
          sandbox: effectiveSandboxMode,
          ...(sessionConfig?{config:sessionConfig}:{}),
          developerInstructions: opts.systemPrompt ?? null,
          ephemeral: false,
          experimentalRawEvents: false,
          dynamicTools: opts.dynamicTools?.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })) ?? null,
        });
    if (opts.resumeSessionId && response.thread.id !== opts.resumeSessionId) {
      throw new Error("Codex did not confirm the requested saved session");
    }
    session = new CodexAppServerSession(
      response.thread.id,
      rpc,
      opts.cwd,
      !opts.resumeSessionId && !opts.transcriptFork,
      opts.resumeSessionId || opts.transcriptFork ? [] : [...opts.history],
      typeof response.model === "string" && response.model.trim() ? response.model.trim() : opts.model,
      (opts.configuredMcps??[]).filter(server=>!restrictedConnectors.has(server.name)),
      opts.onCapabilitiesChanged,
      cliVersion,
      opts.expectedBillingMode,
    );
    return session;
  }

  async nativeHistory(): Promise<import("@ponderosa/core").NativeHistoryCatalog> {
    if (this.activeTurnId) throw new Error("Native thread has active work");
    const points: string[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      if (seen.size >= 100) throw new Error("Native history exceeds bounded lookup");
      const page = object(await this.rpc.request("thread/turns/list", {threadId:this.engineAgentId,limit:100,itemsView:"notLoaded",...(cursor?{cursor}:{})}));
      if (!page || !Array.isArray(page.data)) throw new Error("Native history unavailable");
      for (const entry of page.data) {
        const turn=object(entry);
        if (turn?.status === "completed" && typeof turn.id === "string") points.push(turn.id);
      }
      if (page.nextCursor === null) break;
      if (typeof page.nextCursor !== "string" || !page.nextCursor || seen.has(page.nextCursor)) throw new Error("Incomplete native history");
      cursor=page.nextCursor;seen.add(cursor);
    } while (true);
    return {sessionId:this.engineAgentId,checkpoints:[],forkPoints:points,fileRewindSupported:false,transcriptForkSupported:true};
  }

  async capabilities(): Promise<EngineCapabilities> {
    if (!this.capabilitiesDirty && this.capabilitiesSnapshot) return this.capabilitiesSnapshot;
    if (this.capabilitiesDiscovery) return this.capabilitiesDiscovery;
    const discovery = this.discoverCapabilities();
    this.capabilitiesDiscovery = discovery;
    try {
      return await discovery;
    } finally {
      if (this.capabilitiesDiscovery === discovery) this.capabilitiesDiscovery = undefined;
    }
  }

  private async discoverCapabilities(): Promise<EngineCapabilities> {
    // A provider notification can invalidate the catalog while its requests are
    // in flight. Repeat inside the same single-flight operation so no caller can
    // publish or observe that stale generation as the refreshed snapshot.
    for (;;) {
      const generation = this.catalogGeneration;
      const [skills, plugins, models, modelProviderCapabilities, mcpStatuses] = await Promise.all([
        optionalRequest(this.rpc, "skills/list", { cwds: [this.cwd], forceReload: true }),
        optionalRequest(this.rpc, "plugin/installed", { cwds: [this.cwd] }),
        optionalPaginatedRequest(this.rpc, "model/list", { includeHidden: false }),
        optionalRequest(this.rpc, "modelProvider/capabilities/read", {}),
        optionalPaginatedRequest(this.rpc, "mcpServerStatus/list", { detail: "toolsAndAuthOnly", threadId: this.engineAgentId }),
      ]);
      const pluginDetails = await readInstalledPluginDetails(this.rpc, plugins);
      const snapshot = normalizeCodexProviderDiscovery({
        cwd: this.cwd,
        cliVersion: this.cliVersion,
        selectedModel: this.activeModel,
        sessionId: this.engineAgentId,
        skills,
        plugins,
        pluginDetails,
        models,
        modelProviderCapabilities,
        mcpStatuses,
        mcpStartup: this.mcpStartup,
        configuredMcps: this.configuredMcps,
      });
      snapshot.catalogVersion = `${this.engineAgentId}:${generation}`;
      if (generation !== this.catalogGeneration) continue;
      this.capabilitiesSnapshot = snapshot;
      this.capabilitiesDirty = false;
      return snapshot;
    }
  }

  async invokeCommand(name: string, argumentsText?: string): Promise<RuntimeCommandResult | void> {
    if (name.startsWith("goal")) {
      await this.validateBillingMode();
      if (this.activeTurnId) throw new Error("Native goal commands require an idle retained session");
      return invokeCodexGoal(this.rpc, this.engineAgentId, name, argumentsText);
    }
    if (argumentsText?.trim()) throw new Error(`/${name} does not accept arguments`);
    const command = (await this.capabilities()).commands.find((candidate) => candidate.name === name);
    if (!command || command.status !== "available" || command.invocation !== "runtime") {
      throw new Error(command?.unavailableReason ?? `/${name} is unavailable in the Codex command catalog`);
    }
    if (name === "compact") {
      if (this.nativeTaskHold) throw new Error("Native terminal work still owns the source Run");
      if (this.compactOperation && !this.compactOperation.terminalStatus && !this.compactOperation.closed) {
        throw new Error("Native compaction is already in progress; do not repeat the command.");
      }
      const operation: CompactOperation = { itemCompleted: false, closed: false };
      this.compactOperation = operation;
      let version = this.contextUsageGate.currentVersion();
      this.latestContextUsage = undefined;
      // Stay inside the existing 60-second HTTP handler budget, including the
      // acknowledgement and all progress/telemetry; never stack timeouts.
      const deadline = Date.now() + 45_000;
      const liveDeadline = deadline - 5_000;
      // This RPC returns {} immediately. Completion belongs to the matching
      // contextCompaction item and its terminal turn, not to this response.
      try {
        void this.rpc.request("thread/compact/start", { threadId: this.engineAgentId }).then(() => {
          operation.rpcStatus = "accepted";
          this.contextUsageGate.observe();
        }, () => {
          operation.rpcStatus = "rejected";
          this.contextUsageGate.observe();
        });
      } catch {
        operation.rpcStatus = "rejected";
      }
      try {
        while (!operation.closed) {
          if (operation.rpcStatus === "rejected" || operation.terminalStatus && operation.terminalStatus !== "completed") {
            return { outcome: operation.terminalStatus === "failed" || operation.terminalStatus === "interrupted" ? "failed" : "outcome_unknown",
              message: "Compaction did not complete successfully; its outcome and context usage are unconfirmed. Do not repeat the command solely to refresh telemetry. Use Context Refresh before more work." };
          }
          if (operation.rpcStatus === "accepted" && operation.itemCompleted && operation.terminalStatus === "completed" && operation.usage) {
            return { outcome: "completed", contextUsage: { usedTokens: operation.usage.usedTokens,
              ...(operation.usage.modelContextWindow ? { windowTokens: operation.usage.modelContextWindow } : {}),
              ...(operation.usage.aggregateTokens !== undefined ? { aggregateTokens: operation.usage.aggregateTokens } : {}),
              providerSessionGeneration: this.engineAgentId } };
          }
          const remaining = liveDeadline - Date.now();
          if (remaining <= 0) break;
          await this.contextUsageGate.waitAfter(version, remaining);
          version = this.contextUsageGate.currentVersion();
        }
      } catch {
        // Missing completion/telemetry is an uncertain native mutation, never
        // permission to replay the operation or trust the pre-command getter.
      }
      // Stored history can recover a lost completion notification, never a
      // missing operation identity or fresh post-compaction occupancy.
      if (!operation.closed && operation.rpcStatus === "accepted" &&
          operation.turnId && operation.itemId &&
          (!operation.terminalStatus || operation.terminalStatus === "completed" && !operation.itemCompleted)) {
        const confirmed = await this.readStoredCompactionCompletion(operation, deadline);
        if (confirmed && !operation.closed &&
            (!operation.terminalStatus || operation.terminalStatus === "completed")) {
          operation.itemCompleted = true;
          operation.terminalStatus = "completed";
        }
      }
      const completed = operation.itemCompleted && operation.terminalStatus === "completed";
      return { outcome: completed ? "completed" : "outcome_unknown", message: completed
        ? "Compaction completed; updated context usage is unavailable. Do not repeat the command solely to refresh telemetry. Use Context Refresh before more work."
        : "Compaction was started; completion and updated context usage are unconfirmed. Do not repeat the command. Use Context Refresh before more work." };
    }
    if (name === "status") {
      const rateLimits = await optionalRequest(this.rpc, "account/rateLimits/read", undefined);
      return { message: formatCodexStatus({ sessionId: this.engineAgentId, model: this.activeModel, context: this.latestContextUsage, rateLimits }) };
    }
    throw new Error(`unsupported Codex runtime command: ${name}`);
  }

  private async readStoredCompactionCompletion(operation: CompactOperation, deadline: number): Promise<boolean> {
    const { turnId, itemId } = operation;
    if (!turnId || !itemId || operation.closed || operation.rpcStatus !== "accepted") return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<boolean> => {
      const metadata = object(await this.rpc.request("thread/read", { threadId: this.engineAgentId }));
      if (object(metadata?.thread)?.id !== this.engineAgentId) return false;
      const cursors = new Set<string>();
      let cursor: string | undefined;
      // Bounded history only; absence past the cap is unknown, never replay.
      for (let page = 0; page < 4 && Date.now() < deadline && !operation.closed; page++) {
        const response = object(await this.rpc.request("thread/turns/list", {
          threadId: this.engineAgentId, limit: 100, sortDirection: "desc", itemsView: "full",
          ...(cursor ? { cursor } : {}),
        }));
        if (!Array.isArray(response?.data) || response.data.length > 100) return false;
        const matches = response.data.filter(candidate => object(candidate)?.id === turnId);
        if (matches.length) {
          if (matches.length !== 1) return false;
          const turn = object(matches[0]);
          if (turn?.status !== "completed" || turn.error !== null || turn.itemsView !== "full" ||
              !Array.isArray(turn.items)) return false;
          const items = turn.items.filter(candidate => object(candidate)?.id === itemId);
          return items.length === 1 && object(items[0])?.type === "contextCompaction";
        }
        const next = response?.nextCursor;
        if (typeof next !== "string" || !next || next.length > 4096 || cursors.has(next)) return false;
        cursors.add(next);
        cursor = next;
      }
      return false;
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    try {
      return await Promise.race([read(), new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), remaining);
      })]);
    } catch {
      // Unsupported/version-mismatched history, transport loss and invalid
      // evidence retain the existing unknown outcome. No mutation is retried.
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  contextUsage(): { usedTokens: number; windowTokens?: number; aggregateTokens?: number; providerSessionGeneration: string } | undefined {
    if (!this.latestContextUsage) return undefined;
    return {
      usedTokens: this.latestContextUsage.usedTokens,
      ...(this.latestContextUsage.modelContextWindow
        ? { windowTokens: this.latestContextUsage.modelContextWindow }
        : {}),
      ...(this.latestContextUsage.aggregateTokens !== undefined
        ? { aggregateTokens: this.latestContextUsage.aggregateTokens }
        : {}),
      providerSessionGeneration: this.engineAgentId,
    };
  }

  async rateLimitStatus(): Promise<string[]> {
    return formatCodexRateLimits(
      await optionalRequest(this.rpc, "account/rateLimits/read", undefined),
    );
  }

  private observeNotification(notification: JsonRpcNotification): void {
    if (notification.method === "account/updated") this.accountGeneration++;
    const compact = this.compactOperation;
    const params = object(notification.params);
    if (params?.threadId === this.engineAgentId && (!compact || compact.closed)) {
      const turn = object(params.turn);
      if (notification.method === "turn/started" && typeof turn?.id === "string") {
        this.activeTurnId = turn.id;
        this.observedTurnStarts++;
      }
      if (notification.method === "turn/completed" && turn?.id === this.activeTurnId) this.activeTurnId = undefined;
    }
    if (compact && !compact.closed && params?.threadId === this.engineAgentId) {
      const turn = object(params.turn);
      if (notification.method === "turn/started" && !compact.turnId &&
          typeof turn?.id === "string" && turn.id !== this.lastCompletedTurnId) compact.turnId = turn.id;
      if (compact.turnId && (params.turnId === compact.turnId || turn?.id === compact.turnId)) {
        // JsonRpcProcess also queues this exact object. Keep native lifecycle
        // out of the next ordinary Run even when several commands precede it.
        this.nativeCommandNotifications.add(notification);
      }
      if (compact.turnId && params.turnId === compact.turnId) {
        const item = object(params.item);
        if (item?.type === "contextCompaction" && typeof item.id === "string") {
          if (notification.method === "item/started" && !compact.itemId) compact.itemId = item.id;
          if (notification.method === "item/completed" && item.id === compact.itemId) compact.itemCompleted = true;
        }
      }
      if (notification.method === "turn/completed" && compact.turnId && turn && turn.id === compact.turnId) {
        compact.terminalStatus = typeof turn.status === "string" ? turn.status : "unknown";
      }
      this.contextUsageGate.observe();
    }
    if (notification.method === "thread/tokenUsage/updated") {
      const params = notification.params as {
        threadId?: unknown;
        tokenUsage?: { total?: unknown; last?: unknown; modelContextWindow?: unknown };
      } | undefined;
      const usage = params?.threadId === this.engineAgentId
        ? codexContextUsageSnapshot(params.tokenUsage) : undefined;
      if (usage) {
        this.latestContextUsage = usage;
        if (compact && !compact.closed && compact.itemCompleted &&
            object(notification.params)?.turnId === compact.turnId) compact.usage = usage;
        if (this.nativeCommandNotifications.has(notification) && (!this.activeTurnId || this.activeTurnId === compact?.turnId)) {
          const total = mapCodexTokenUsage(params?.tokenUsage?.total);
          if (total) { this.baselineTotal = total; this.latestTotal = total; }
        }
        this.contextUsageGate.observe();
      }
    }
    if (notification.method === "turn/completed" && params?.threadId === this.engineAgentId) {
      const turn = object(params.turn);
      if (typeof turn?.id === "string") this.lastCompletedTurnId = turn.id;
    }
    this.observeCapabilityNotification(notification);
  }

  private observeCapabilityNotification(notification: JsonRpcNotification): void {
    if (notification.method === "model/rerouted") {
      if (!isModelReroutedNotification(notification.params) ||
          notification.params.threadId !== this.engineAgentId) return;
      const raw = notification.params;
      this.observeProviderModel(raw.toModel.trim());
    } else if (notification.method === "thread/settings/updated") {
      const raw = object(notification.params);
      if (raw?.threadId !== this.engineAgentId || !isThreadSettings(raw.threadSettings)) return;
      const threadSettings = raw.threadSettings;
      this.observeProviderModel(threadSettings.model.trim());
    } else if (notification.method === "mcpServer/startupStatus/updated") {
      const raw = notification.params && typeof notification.params === "object"
        ? notification.params as { name?: unknown; status?: unknown; error?: unknown } : undefined;
      if (typeof raw?.name === "string" && typeof raw.status === "string") {
        this.mcpStartup.set(raw.name, {
          status: raw.status,
          ...(typeof raw.error === "string" && raw.error.trim() ? { error: raw.error.trim() } : {}),
        });
      }
      this.invalidateCapabilities();
    } else if (notification.method === "skills/changed" || notification.method === "app/list/updated") {
      this.invalidateCapabilities();
    }
  }

  private observeProviderModel(model: string): void {
    this.providerModelGeneration += 1;
    this.activeModel = model;
    this.invalidateCapabilities();
  }

  private invalidateCapabilities(): void {
    this.capabilitiesDirty = true;
    this.catalogGeneration += 1;
    this.onCapabilitiesChanged?.();
  }

  private async validateBillingMode(): Promise<void> {
    if (!this.expectedBillingMode) return;
    const generation = this.accountGeneration;
    await requireCodexBillingMode(this.rpc, this.expectedBillingMode);
    if (generation !== this.accountGeneration) throw new Error("Native account changed during billing-mode admission; no new input was authorized");
  }

  async startNativeGoal(input: RuntimeTurnInput): Promise<void> {
    input.assertCurrent?.();
    if (this.activeTurnId || this.nativeTaskHold || this.goalOwned) throw new Error("Native session has active work");
    await this.validateBillingMode();
    const current = await readNativeGoal(this.rpc, this.engineAgentId);
    const action = input.nativeAction as {kind:string;objective?:unknown;tokenBudget?:unknown} | undefined;
    let create: {objective:string;tokenBudget?:number|null} | undefined;
    if (action?.kind === "goal-create") {
      if (current !== null) throw new Error("An existing or unavailable native goal cannot be replaced");
      if (typeof action.objective !== "string" || !action.objective.trim() || action.objective.length > 32_000 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(action.objective))
        throw new Error("A nonempty bounded native goal objective is required");
      if (action.tokenBudget !== undefined && action.tokenBudget !== null &&
          (!Number.isSafeInteger(action.tokenBudget) || (action.tokenBudget as number) <= 0))
        throw new Error("Native goal budget must be positive or null");
      create = {objective:action.objective.trim(),
        ...(action.tokenBudget !== undefined ? {tokenBudget:action.tokenBudget as number|null} : {})};
    } else if (!current || current.status !== "paused") throw new Error("An exact paused native goal is required");
    input.assertCurrent?.();
    // From the moment the mutation is sent, its effects may already be live.
    // Never repeat it on a lost or malformed response.
    this.goalOwned = true;
    this.goalPauseAttempted = false;
    this.goalStatus = "active";
    try {
      const goal = await setNativeGoalOnce(this.rpc, this.engineAgentId, "active", create);
      if (goal.objective !== (create?.objective ?? current?.objective) ||
          (create && Object.hasOwn(create,"tokenBudget") && goal.tokenBudget !== create.tokenBudget))
        throw new Error("Native goal activation changed the requested objective or budget");
      input.assertCurrent?.();
    } catch (error) {
      try { await this.close(); } catch { /* host cleanup retains the registered process */ }
      throw new Error("Native goal activation outcome is unknown; do not repeat it", {cause:error});
    }
  }

  async pauseNativeGoal(): Promise<void> {
    if (!this.goalOwned) throw new Error("No native goal is owned by this Run");
    if (this.goalPauseAttempted) throw new Error("Native goal pause was already attempted; inspect its outcome");
    this.goalPauseAttempted = true;
    try {
      await setNativeGoalOnce(this.rpc, this.engineAgentId, "paused");
      this.goalStatus = "paused";
    } catch (error) { throw new Error("Native goal pause outcome is unknown; do not repeat it", {cause:error}); }
  }

  async startTurn(input: RuntimeTurnInput): Promise<{ turnId: string }> {
    input.assertCurrent?.();
    if (this.nativeTaskHold) throw new Error("Native terminal work still owns the source Run");
    await this.validateBillingMode();
    input.assertCurrent?.();
    if (this.nativeTaskHold) throw new Error("Native terminal work still owns the source Run");
    this.nativeTaskReceiptSeen = false;
    this.nativeTaskItems.clear();
    if (this.compactOperation && !this.compactOperation.closed && !this.compactOperation.terminalStatus) {
      throw new Error("Native compaction is still in progress; its completion is unconfirmed.");
    }
    if (input.nativeAction?.kind === "review") {
      if (input.inputFiles?.length) throw new Error("Native review does not accept typed attachments; submit them in a separate turn");
      if (this.activeTurnId) throw new Error("Native review requires an idle session");
      const turnId = await startCodexReview(this.rpc, this.engineAgentId, input.nativeAction);
      this.activeTurnId = this.lastCompletedTurnId === turnId ? undefined : turnId;
      return { turnId };
    }
    const prompt = this.seedHistory.length > 0
      ? renderSeedPrompt(this.seedHistory, input.prompt)
      : input.prompt;
    // Verify admitted media before changing retained native plan settings.
    let content = codexTurnContent(input, prompt);
    if (input.nativeAction?.kind === "plan") {
      const model = input.model || this.activeModel;
      if (!model) throw new Error("Native plan mode requires the selected provider model");
      await setCodexPlanMode(this.rpc, this.engineAgentId, input.nativeAction, model, input.effort);
      input.assertCurrent?.();
      content = codexTurnContent(input, prompt);
    }
    input.assertCurrent?.();
    this.seedHistory.splice(0);
    const providerModelGeneration = this.providerModelGeneration;
    const response = await this.rpc.request<TurnResponse>("turn/start", {
      threadId: this.engineAgentId,
      input: content,
      ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
      ...(input.model ? { model: input.model } : {}),
      serviceTier: serviceTierForSpeed(input.speed),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.nativeAction?.kind === "structured" ? { outputSchema: input.nativeAction.outputSchema } : {}),
    });
    this.activeTurnId = this.lastCompletedTurnId === response.turn.id ? undefined : response.turn.id;
    const acceptedModel = input.model?.trim() || this.activeModel;
    // A matching-thread model notification is more authoritative than RPC
    // success, including when it arrives before this continuation resumes.
    if (providerModelGeneration === this.providerModelGeneration && acceptedModel !== this.activeModel) {
      this.activeModel = acceptedModel;
      this.invalidateCapabilities();
    }
    return { turnId: response.turn.id };
  }

  async steer(input: RuntimeTurnInput): Promise<RuntimeSteerResult> {
    if (!steeringPreflight(input)) return { status: "not_active", reason: "Run authority changed before steering submission" };
    await this.validateBillingMode();
    if (!steeringPreflight(input)) return { status: "not_active", reason: "Run authority changed before steering submission" };
    if (input.nativeAction) return { status: "not_steerable", reason: "Native actions require a new scheduler-owned turn" };
    if (!this.activeTurnId) return { status: "not_active" };
    const content = codexTurnContent(input);
    if (!steeringPreflight(input)) return { status: "not_active", reason: "Run authority changed before steering submission" };
    try {
      const response = await this.rpc.request<SteerResponse>("turn/steer", {
        threadId: this.engineAgentId,
        expectedTurnId: this.activeTurnId,
        input: content,
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

  async listNativeTasks() {
    if (!this.isAlive()) throw new Error("Native session is unavailable");
    const tasks = await this.backgroundTasks.list();
    if (tasks.some(task => !task.itemId || this.nativeTaskItems.get(task.itemId) !== task.processId))
      throw new Error("Native registry includes work without an exact current-source item receipt");
    return tasks;
  }

  async stopNativeTask(taskKey: string) {
    if (!this.isAlive()) throw new Error("Native session is unavailable");
    const owned = [...this.nativeTaskItems].some(([itemId,processId]) => JSON.stringify([this.engineAgentId,itemId,processId]) === taskKey);
    if (!owned) throw new Error("Native terminal has no current-source item receipt");
    return this.backgroundTasks.stop(taskKey);
  }

  async interrupt(): Promise<void> {
    if (!this.activeTurnId) return;
    await this.rpc.request("turn/interrupt", { threadId: this.engineAgentId, turnId: this.activeTurnId });
  }

  isAlive(): boolean {
    return this.rpc.isAlive();
  }

  close(): Promise<void> {
    this.closingNativeTasks = true;
    this.stopCompactObservation();
    return this.rpc.close();
  }

  private stopCompactObservation(): void {
    if (this.compactOperation) this.compactOperation.closed = true;
    this.contextUsageGate.observe();
  }

  private async *retainBackgroundTasks(): AsyncIterable<AgentEvent> {
    this.nativeTaskHold = true;
    const observed = new Map<string, string>();
    while (!this.closingNativeTasks && this.isAlive()) {
      const tasks = await this.listNativeTasks();
      const current = new Set(tasks.map(task => task.taskKey));
      for (const [key, id] of observed) if (!current.has(key)) {
        yield { type: "work_item_update", workItemId: `native:${key}`, title: `Native terminal: ${id}`, status: "done" };
        observed.delete(key);
      }
      for (const task of tasks) if (!observed.has(task.taskKey)) {
        observed.set(task.taskKey, task.taskId);
        yield { type: "work_item_update", workItemId: `native:${task.taskKey}`, title: `Native terminal: ${task.taskId}`, status: "running" };
      }
      if (!tasks.length) { this.nativeTaskHold = false; return; }
      // Read cadence for an existing native registry, never a scheduled model turn.
      await new Promise<void>(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("Native terminal lifetime ended without a complete empty registry");
  }

  private async *eventStream(): AsyncIterable<AgentEvent> {
    // The transport may have observed completion before this queued reader advances.
    let eventTurnId = this.activeTurnId;
    let consumedTurnStarts = 0;
    let heldCompletion: Extract<AgentEvent, {type:"turn_done"}> | undefined;
    let heldCompletionTurnId: string | undefined;
    let goalTerminalTurnId: string | undefined;
    let goalUsage: TokenUsage[] = [];
    let goalRequests: TokenUsage[] = [];
    const goalMarker = (status:"running"|"done", state?:string): AgentEvent => ({
      type:"work_item_update", workItemId:`native-goal:${this.engineAgentId}`, status,
      title:state ? `Native goal: ${state}` : "Native goal",
    });
    const terminalGoal = (): AgentEvent => {
      const status = this.goalStatus;
      this.goalOwned = false;
      const usage = sumProviderRequestUsage(goalUsage);
      const result: AgentEvent = status === "complete" && heldCompletion
        ? {...heldCompletion, ...(usage ? {usage} : {}), ...(goalRequests.length ? {providerRequestUsage:goalRequests} : {})}
        : {type:"error", terminalStatus:"unknown", message:`Native goal stopped with status ${status ?? "unknown"}; its remaining work was not repeated.`};
      heldCompletion = undefined;
      heldCompletionTurnId = undefined;
      goalTerminalTurnId = undefined;
      goalUsage = [];
      goalRequests = [];
      this.goalPauseAttempted = false;
      return result;
    };
    yield { type: "session", sessionId: this.engineAgentId };
    if (this.goalOwned && !this.goalMarkerEmitted) {
      this.goalMarkerEmitted = true;
      yield goalMarker("running");
    }
    const responseText = new CodexResponseText(this.engineAgentId);
    for await (const notification of this.rpc.notifications) {
      if (this.goalOwned && !this.goalMarkerEmitted) {
        this.goalMarkerEmitted = true;
        yield goalMarker("running");
      }
      if (this.nativeCommandNotifications.has(notification)) continue;
      const params = object(notification.params);
      if (notification.method === "thread/goal/updated" && params?.threadId === this.engineAgentId) {
        let goal: NativeGoalSnapshot | null;
        try { goal = codexGoalSnapshot(params.goal, this.engineAgentId); }
        catch (error) { try { await this.close(); } catch { /* retain host cleanup authority */ } throw error; }
        if (!goal) { await this.close(); throw new Error("Native goal update is missing its goal"); }
        this.goalStatus = goal.status;
        if (goal.status === "active") {
          goalTerminalTurnId = undefined;
          this.goalOwned = true;
          if (!this.goalMarkerEmitted) { this.goalMarkerEmitted = true; yield goalMarker("running"); }
        } else if (this.goalOwned) {
          if (goal.status === "complete" && typeof params.turnId === "string") goalTerminalTurnId = params.turnId;
          if (!eventTurnId && !this.activeTurnId && consumedTurnStarts === this.observedTurnStarts &&
              (goal.status !== "complete" || goalTerminalTurnId === heldCompletionTurnId && !!heldCompletionTurnId)) {
            if (goal.status !== "complete") { try { await this.close(); } catch { /* host keeps cleanup authority */ } }
            yield goalMarker("done", goal.status);
            this.goalMarkerEmitted = false;
            yield terminalGoal();
          }
        }
        continue;
      }
      if (notification.method === "thread/goal/cleared" && params?.threadId === this.engineAgentId && this.goalOwned) {
        this.goalStatus = undefined;
        if (!eventTurnId && !this.activeTurnId && consumedTurnStarts === this.observedTurnStarts) {
          try { await this.close(); } catch { /* host keeps cleanup authority */ }
          yield goalMarker("done", "cleared");
          this.goalMarkerEmitted = false;
          yield terminalGoal();
        }
        continue;
      }
      if (notification.method.startsWith("item/") || notification.method.startsWith("turn/")) {
        if (params?.threadId !== this.engineAgentId) continue;
        if (notification.method === "turn/started") {
          const turn = object(params.turn);
          if (typeof turn?.id !== "string" || !turn.id) throw new Error("Native turn start has no identity");
          eventTurnId = turn.id;
          consumedTurnStarts++;
        } else if (notification.method === "turn/completed") {
          if (object(params.turn)?.id !== eventTurnId || !eventTurnId) continue;
        } else if (params.turnId !== eventTurnId || !eventTurnId) continue;
      }
      yield* codexNativeObservation(notification.method, notification.params, this.engineAgentId, eventTurnId);
      yield* responseText.map(notification.method, notification.params);
      if (notification.method === "thread/tokenUsage/updated") {
        const params = notification.params as { threadId?: unknown; turnId?: unknown; tokenUsage?: { total?: unknown; last?: unknown; modelContextWindow?: unknown } } | undefined;
        if (typeof params?.turnId === "string" && params.threadId === this.engineAgentId) {
          const total = mapCodexTokenUsage(params.tokenUsage?.total);
          const requestUsage = mapCodexTokenUsage(params.tokenUsage?.last);
          if (total || requestUsage) {
            const contextUsage = codexContextUsageSnapshot(params.tokenUsage);
            const modelContextWindow = contextUsage?.modelContextWindow;
            if (contextUsage) this.latestContextUsage = contextUsage;

            // A resumed thread replays its prior cumulative total before the new
            // turn's events. That checkpoint is the durable interval baseline.
            if (total && params.turnId !== eventTurnId) {
              this.baselineTotal = total;
              this.latestTotal = total;
            } else if (total) {
              const usage = this.baselineTotal ? subtractUsage(total, this.baselineTotal) : undefined;
              if (usage) this.usageByTurnId.set(params.turnId, usage);
              else this.usageByTurnId.delete(params.turnId);
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
            // A resumed thread first replays old token checkpoints. Preserve
            // those for aggregate baselining/status, but only emit pressure
            // observations for the currently accepted provider turn.
            if (requestUsage && this.latestContextUsage && params.turnId === eventTurnId) yield {
              type: "context_usage",
              providerSessionId: this.engineAgentId,
              providerSessionGeneration: this.engineAgentId,
              usedTokens: this.latestContextUsage.usedTokens,
              ...(this.latestContextUsage.aggregateTokens !== undefined
                ? { aggregateTokens: this.latestContextUsage.aggregateTokens }
                : {}),
              ...(modelContextWindow ? { windowTokens: modelContextWindow } : {}),
            };
          }
        }
        continue;
      }
      const taskParams = object(notification.params), taskItem = object(taskParams?.item);
      if (taskParams?.threadId === this.engineAgentId && taskParams.turnId === eventTurnId &&
          ["item/started", "item/completed"].includes(notification.method) && taskItem?.type === "commandExecution" &&
          typeof taskItem.processId === "string" && taskItem.processId.length > 0) {
        if (typeof taskItem.id !== "string" || !taskItem.id || taskItem.id.length > 1024 || taskItem.processId.length > 1024 ||
            /[\u0000-\u001f\u007f-\u009f]/u.test(taskItem.id + taskItem.processId) || this.nativeTaskItems.size >= 1000 && !this.nativeTaskItems.has(taskItem.id))
          throw new Error("Invalid or excessive current-source native terminal identity");
        this.nativeTaskItems.set(taskItem.id,taskItem.processId);
        this.nativeTaskReceiptSeen = true;
      }
      const completedTurnId = notification.method === "turn/completed"
        ? ((notification.params as { turn?: { id?: unknown } } | undefined)?.turn?.id)
        : undefined;
      const completedRequestUsage = typeof completedTurnId === "string"
        ? this.providerRequestUsageByTurnId.get(completedTurnId) ?? []
        : [];
      const completedUsage = typeof completedTurnId === "string"
        ? this.usageByTurnId.get(completedTurnId) ?? sumProviderRequestUsage(completedRequestUsage)
        : undefined;
      const providerRequestUsage = completedUsage
        ? reconcileProviderRequestUsage(completedUsage, completedRequestUsage)
        : undefined;
      for (const event of mapCodexAppServerNotification(notification, this.cwd, completedUsage, providerRequestUsage)) {
        if (event.type === "turn_done" && this.nativeTaskReceiptSeen) {
          try { yield* this.retainBackgroundTasks(); }
          catch {
            const closing = this.close();
            void closing.catch(() => undefined);
            yield { type: "error", terminalStatus: "unknown", message: "Native terminal inventory could not establish completion; source outcome held without replay" };
            await closing;
            return;
          }
        }
        if (event.type === "error" && this.goalOwned) {
          // An active goal can schedule more work after a failed turn. Retain
          // unknown effects and drain its process before returning the error.
          try { await this.close(); } catch { /* host retains process cleanup authority */ }
          yield event;
          return;
        }
        if (event.type === "turn_done") {
          let goal: NativeGoalSnapshot | null | undefined;
          try { goal = await readNativeGoal(this.rpc, this.engineAgentId); }
          catch (error) { try { await this.close(); } catch { /* retain host cleanup authority */ } throw error; }
          if (goal?.status === "active" || goal && consumedTurnStarts < this.observedTurnStarts) {
            this.goalOwned = true;
            this.goalStatus = goal.status;
            if (!this.goalMarkerEmitted) { this.goalMarkerEmitted = true; yield goalMarker("running"); }
          } else if (this.goalOwned) {
            this.goalStatus = goal?.status;
          }
          if (this.goalOwned) {
            heldCompletion = event;
            heldCompletionTurnId = typeof completedTurnId === "string" ? completedTurnId : undefined;
            if (event.usage) goalUsage.push(event.usage);
            if (event.providerRequestUsage) goalRequests.push(...event.providerRequestUsage);
            if (this.goalStatus !== "active" && !this.activeTurnId && consumedTurnStarts === this.observedTurnStarts &&
                (this.goalStatus !== "complete" || !!heldCompletionTurnId && goalTerminalTurnId === heldCompletionTurnId)) {
              if (this.goalStatus !== "complete") { try { await this.close(); } catch { /* host keeps cleanup authority */ } }
              yield goalMarker("done", this.goalStatus ?? "unknown");
              this.goalMarkerEmitted = false;
              yield terminalGoal();
            }
            continue;
          }
        }
        yield event;
      }
      if (typeof completedTurnId === "string") {
        eventTurnId = undefined;
        this.usageByTurnId.delete(completedTurnId);
        this.providerRequestUsageByTurnId.delete(completedTurnId);
        this.usageCheckpointsByTurnId.delete(completedTurnId);
        if (this.latestTotal) this.baselineTotal = this.latestTotal;
      }
    }
    if (this.goalOwned) {
      yield {type:"error", terminalStatus:"unknown", message:"Native goal stream ended before its outcome was confirmed; work remains held."};
    }
  }
}

function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
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
  if ([...sums.values()].some(value => tokenCount(value) === undefined)) return undefined;
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
  const cacheWriteInputTokens = delta("cacheWriteInputTokens");
  const outputTokens = delta("outputTokens");
  const reasoningOutputTokens = delta("reasoningOutputTokens");
  const totalTokens = delta("totalTokens");
  if (totalTokens === undefined || inputTokens === undefined || outputTokens === undefined) return undefined;
  if ((cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0) > inputTokens) return undefined;
  if (reasoningOutputTokens !== undefined && reasoningOutputTokens > outputTokens) return undefined;
  return {
    inputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    outputTokens,
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    totalTokens,
  };
}

export function mapCodexTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const number = (key: string) => tokenCount(raw[key]);
  const inputTokens = number("inputTokens");
  const cachedInputTokens = number("cachedInputTokens");
  const outputTokens = number("outputTokens");
  const reasoningOutputTokens = number("reasoningOutputTokens");
  const providerTotal = number("totalTokens");
  // Codex's generated app-server TokenUsageBreakdown currently exposes cached
  // reads but no cache-write counter. Keep that gap explicit rather than
  // guessing from input totals; downstream TokenUsage still preserves cache
  // writes for providers that report them canonically.
  if ([inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, providerTotal].every((item) => item === undefined)) return undefined;
  const totalTokens = providerTotal ?? tokenSum(inputTokens, outputTokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
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
    const message = String(params?.message ?? "Codex app-server stopped");
    const code = providerErrorCodeFromDetail(message);
    return [{ type: "error", message, ...(code ? { code } : {}) }];
  }
  if (notification.method === "item/agentMessage/delta") {
    // These raw deltas have no Chat authority. eventStream separately normalizes
    // candidate items; completed text below remains execution-scoped Work log.
    return [];
  }
  if (notification.method === "item/reasoning/summaryTextDelta" || notification.method === "item/reasoning/textDelta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    return delta ? [{ type: "reasoning", delta }] : [];
  }
  if (notification.method === "turn/completed") {
    const turn = params?.turn as {
      status?: string;
      error?: { message?: string; code?: unknown; codexErrorInfo?: unknown; retryAfterMs?: unknown } | null;
    } | undefined;
    if (turn?.status === "failed") {
      const message = turn.error?.message ?? "Codex turn failed";
      return [{ ...codexErrorEvent(turn.error, message), terminalStatus: "failed" }];
    }
    if (turn?.status !== "completed") {
      return [{ type: "error", terminalStatus: turn?.status === "interrupted" ? "interrupted" : "unknown", message: turn?.status === "interrupted"
        ? "Codex turn was interrupted; successful completion was not observed."
        : "Codex turn ended without a recognized completed status; its outcome is unconfirmed." }];
    }
    return [{
      type: "turn_done",
      ...(usage ? { usage } : {}),
      ...(providerRequestUsage ? { providerRequestUsage } : {}),
    }];
  }
  if (notification.method !== "item/started" && notification.method !== "item/completed") return [];
  const item = object(params?.item);
  if (!item || typeof item.type !== "string") return [{ type: "work_start", kind: "native_tool" }];
  if (notification.method === "item/started" && (item.type === "commandExecution" || item.type === "fileChange")) {
    const boundary: AgentEvent = { type: "work_start", kind: item.type === "commandExecution" ? "command" : "file_change",
      ...(typeof item.id === "string" ? { callId: item.id } : {}) };
    if (item.type === "fileChange" || typeof item.command !== "string") return [boundary];
    return [boundary, {
      type: "command",
      command: item.command,
      cwd: typeof item.cwd === "string" ? item.cwd : cwd,
      ...(typeof item.id === "string" ? { callId: item.id } : {}),
    }];
  }
  if (notification.method === "item/completed" && item.type === "commandExecution") {
    return [{
      type: "tool_result",
      id: typeof item.id === "string" ? item.id : "command",
      output: typeof item.aggregatedOutput === "string" ? sanitizeTerminalOutput(item.aggregatedOutput) : "",
      ...commandOutcome(item.exitCode, item.signal),
    }];
  }
  if (notification.method === "item/completed" && item.type === "agentMessage") {
    return typeof item.text === "string" && item.text.trim()
      // Each completed agentMessage is a semantic response block, not a token
      // delta. Keep adjacent blocks separated in the durable Work log.
      ? [{ type: "text", delta: `${item.text.trimEnd()}\n\n`,
          ...(item.phase === "commentary" ? { presentation: "progress" as const } : {}) }]
      : [];
  }
  if (notification.method === "item/completed" && item.type === "fileChange") {
    // Completion-only/reordered edits are work evidence even without a changes payload.
    return [{ type: "work_start", kind: "file_change",
      ...(typeof item.id === "string" ? { callId: item.id } : {}) },
    ...(Array.isArray(item.changes) ? item.changes : []).flatMap((change) => {
      if (!change || typeof change !== "object") return [];
      const value = change as { path?: unknown; kind?: unknown; diff?: unknown };
      return typeof value.path === "string" ? [{
        type: "file_change" as const,
        path: value.path,
        kind: mapFileChangeKind(typeof value.kind === "string" ? value.kind : undefined),
        ...(typeof value.diff === "string" ? { diff: value.diff } : {}),
        ...(typeof item.id === "string" ? { callId: item.id } : {}),
      }] : [];
    })];
  }
  if (notification.method === "item/started" && item.type === "mcpToolCall") {
    if (item.arguments === undefined) return [{ type: "work_start", kind: "native_tool" }];
    return [{
      type: "tool_call",
      id: typeof item.id === "string" ? item.id : "mcp",
      name: `${String(item.server ?? "mcp")}.${String(item.tool ?? "tool")}`,
      input: item.arguments,
    }];
  }
  if (notification.method === "item/completed" && item.type === "mcpToolCall") {
    const isError = Boolean(item.error);
    return [normalizedToolResult(
      typeof item.id === "string" ? item.id : "mcp",
      JSON.stringify(item.result ?? item.error ?? ""),
      isError,
    )];
  }
  if (notification.method === "item/started" && item.type === "dynamicToolCall") {
    if (item.arguments === undefined) return [{ type: "work_start", kind: "native_tool" }];
    const namespace = typeof item.namespace === "string" && item.namespace ? `${item.namespace}.` : "";
    return [{
      type: "tool_call",
      id: typeof item.id === "string" ? item.id : "dynamic-tool",
      name: `${namespace}${String(item.tool ?? "tool")}`,
      input: item.arguments,
    }];
  }
  if (notification.method === "item/completed" && item.type === "dynamicToolCall") {
    const isError = item.success === false;
    let voiceReplyStreamId: string | undefined;
    // Provider-specific content-item parsing stays in the engine. This receipt
    // alone grants no authority; the host compares its operation and scoped stream.
    if (item.success === true && (item.tool === "ponderosa_voice_reply" || item.tool === "ponderosa_reply_stream") &&
        (item.namespace === undefined || item.namespace === null || item.namespace === "") &&
        Array.isArray(item.contentItems) && item.contentItems.length === 1) {
      const content = object(item.contentItems[0]);
      if (content?.type === "inputText" && typeof content.text === "string") {
        try {
          const receipt = object(JSON.parse(content.text));
          if (receipt?.authorized === true && typeof receipt.streamId === "string" && receipt.streamId.trim() && receipt.streamId.length <= 512) voiceReplyStreamId = receipt.streamId;
        } catch { /* Prose/invalid receipts cannot acknowledge authorization. */ }
      }
    }
    const normalized = normalizedToolResult(
      typeof item.id === "string" ? item.id : "dynamic-tool",
      JSON.stringify(item.contentItems ?? []), isError,
    );
    return [{ ...normalized, ...(voiceReplyStreamId && normalized.isError !== true ? { voiceReplyStreamId, isError: false } : {}) }];
  }
  // A small passive/answer allowlist, rather than a finite tool denylist. Native
  // searches/images/collaboration/review/tool outputs, future and malformed types
  // fence on either lifecycle edge, without inventing a public tool projection.
  if (["agentMessage", "reasoning", "plan", "userMessage", "contextCompaction"].includes(item.type)) return [];
  return [{ type: "work_start", kind: "native_tool" }];
}

/** Observe the executing harness, not the host status cache. No account fields
 * or credentials cross the adapter boundary. This RPC is not a turn transaction. */
async function requireCodexBillingMode(rpc: JsonRpcProcess, expected: "subscription" | "api"): Promise<void> {
  const response = object(await rpc.request("account/read", { refreshToken: false }));
  const account = object(response?.account);
  const mode = account?.type === "apiKey" ? "api"
    : account?.type === "chatgpt" || account?.type === "chatgptAuthTokens" ? "subscription" : undefined;
  if (mode !== expected) throw new Error("Executing Codex harness billing mode is unavailable or differs from the human selection; input retained");
}
