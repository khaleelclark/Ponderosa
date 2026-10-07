import { CODEX_APP_TOOL_POLICY_ARGS } from './codex-tool-policy.js';
import {
  classifyToolFailure,
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
  safeProviderConnectionUrl,
} from "@ponderosa/core";
import { stripVTControlCharacters } from "node:util";
import { commandOutcome, mapFileChangeKind, providerErrorCodeFromDetail } from "./events.js";
import { JsonRpcProcess, type JsonRpcNotification } from "./json-rpc-process.js";
import { renderSeedPrompt } from "./seed-history.js";
import { normalizeCodexProviderDiscovery } from "./capabilities.js";

interface ThreadResponse { thread: { id: string }; model?: string }
interface TurnResponse { turn: { id: string } }
interface SteerResponse { turnId: string }
interface DynamicToolCallParams {
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
  catch { return undefined; }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
      if (!response) return undefined;
      if (Array.isArray(response.data)) data.push(...response.data);
      const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
        ? response.nextCursor
        : undefined;
      if (!nextCursor) return { data, nextCursor: null };
      if (seenCursors.has(nextCursor)) throw new Error(`${method} repeated pagination cursor`);
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error(`${method} exceeded pagination limit`);
  } catch {
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
      ...CODEX_APP_TOOL_POLICY_ARGS,
    ],
    cwd: opts.cwd,
    signal: controller.signal,
    killGraceMs: opts.killGraceMs,
    onRuntimeSpawned: opts.onRuntimeSpawned,
    onRuntimeRootExit: () => undefined,
  });
  try {
    try {
      await rpc.initialize();
    } catch (error) {
      if (!timedOut) throw error;
      return normalizeCodexProviderDiscovery({
        cwd: opts.cwd,
        selectedModel: opts.model,
        configuredMcps: opts.configuredMcps,
      });
    }
    const [skills, plugins, models, modelProviderCapabilities, mcpStatuses] = await Promise.all([
      optionalRequest(rpc, "skills/list", { cwds: [opts.cwd], forceReload: true }),
      optionalRequest(rpc, "plugin/installed", { cwds: [opts.cwd] }),
      optionalPaginatedRequest(rpc, "model/list", { includeHidden: false }),
      optionalRequest(rpc, "modelProvider/capabilities/read", {}),
      optionalPaginatedRequest(rpc, "mcpServerStatus/list", { detail: "toolsAndAuthOnly" }),
    ]);
    const pluginDetails = await readInstalledPluginDetails(rpc, plugins);
    return normalizeCodexProviderDiscovery({
      cwd: opts.cwd,
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
  const response = object(rateLimits);
  const byId = object(response?.rateLimitsByLimitId);
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

/** Orders structured commands against asynchronous provider usage
 * notifications. A command response alone is not proof that the session's
 * observable context state has advanced. */
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
        reject(new Error("Codex compact completed without a post-compaction context usage observation"));
      }, timeoutMs);
      timeout.unref?.();
      this.waiters.add(onUsage);
    });
  }
}


export class CodexAppServerSession implements RuntimeSession {
  private activeTurnId?: string;
  private readonly usageByTurnId = new Map<string, TokenUsage>();
  private readonly providerRequestUsageByTurnId = new Map<string, TokenUsage[]>();
  private readonly usageCheckpointsByTurnId = new Map<string, Set<string>>();
  private baselineTotal?: TokenUsage;
  private latestTotal?: TokenUsage;
  private latestContextUsage?: CodexContextUsage;
  private readonly contextUsageGate = new ContextUsageObservationGate();
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
  ) {
    this.processIdentity = rpc.processIdentity;
    if (fresh) this.baselineTotal = zeroUsage();
    this.events = this.eventStream();
  }

  static async open(opts: AppServerSessionOptions): Promise<CodexAppServerSession> {
    if (!opts.onRuntimeSpawned) {
      throw new Error("persistent runtime opening requires a spawn-time termination registrar");
    }
    let session: CodexAppServerSession | undefined;
    const { sandboxMode: effectiveSandboxMode, config: sessionConfig } = codexCapabilityRuntimeOptions(
      opts.sandboxMode,
      opts.capabilityRestrictions,
    );
    const restrictedConnectors = new Set(opts.capabilityRestrictions?.restrictedConnectorNames ?? []);
    const rpc = new JsonRpcProcess({
      bin: opts.bin,
      args: [
        "app-server",
        "--stdio",
        "-c", `sandbox_mode=${JSON.stringify(effectiveSandboxMode)}`,
        "-c", 'approval_policy="never"',
        ...CODEX_APP_TOOL_POLICY_ARGS,
        ...(opts.enableFastMode ? ["-c", "features.fast_mode=true"] : []),
      ],
      cwd: opts.cwd,
      environment: opts.environment,
      signal: opts.signal,
      killGraceMs: opts.killGraceMs,
      onRuntimeSpawned: opts.onRuntimeSpawned,
      onRuntimeRootExit: opts.onRuntimeRootExit,
      onNotification: (notification) => session?.observeNotification(notification),
      handleServerRequest: async (requestId, method, params) => {
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
        const call = params as DynamicToolCallParams;
        if (/^(?:request_user_input(?:_async)?|AskUserQuestion)$/iu.test(call.tool)) {
          throw new Error("Ponderosa cannot display this provider-native question. Call ponderosa_decision so the user receives it in their Chat.");
        }
        const result = await opts.handleDynamicToolCall({
          id: String(requestId),
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
          serviceTier: serviceTierForSpeed(opts.speed),
          approvalPolicy: "never",
          sandbox: effectiveSandboxMode,
          developerInstructions: opts.systemPrompt ?? null,
          config: sessionConfig ?? null,
        })
      : await rpc.request<ThreadResponse>("thread/start", {
          cwd: opts.cwd,
          model: opts.model || null,
          serviceTier: serviceTierForSpeed(opts.speed),
          approvalPolicy: "never",
          sandbox: effectiveSandboxMode,
          developerInstructions: opts.systemPrompt ?? null,
          config: sessionConfig ?? null,
          ephemeral: false,
          experimentalRawEvents: false,
          dynamicTools: opts.dynamicTools?.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })) ?? null,
        });
    session = new CodexAppServerSession(
      response.thread.id,
      rpc,
      opts.cwd,
      !opts.resumeSessionId,
      opts.resumeSessionId ? [] : [...opts.history],
      typeof response.model === "string" && response.model.trim() ? response.model.trim() : opts.model,
      (opts.configuredMcps ?? []).filter(server => !restrictedConnectors.has(server.name)),
      opts.onCapabilitiesChanged,
    );
    return session;
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
    if (argumentsText?.trim()) throw new Error(`/${name} does not accept arguments`);
    const command = (await this.capabilities()).commands.find((candidate) => candidate.name === name);
    if (!command || command.status !== "available" || command.invocation !== "runtime") {
      throw new Error(command?.unavailableReason ?? `/${name} is unavailable in the Codex command catalog`);
    }
    if (name === "compact") {
      const previousUsageVersion = this.contextUsageGate.currentVersion();
      await this.rpc.request("thread/compact/start", { threadId: this.engineAgentId });
      await this.contextUsageGate.waitAfter(previousUsageVersion);
      return;
    }
    if (name === "status") {
      const rateLimits = await optionalRequest(this.rpc, "account/rateLimits/read", undefined);
      return { message: formatCodexStatus({ sessionId: this.engineAgentId, model: this.activeModel, context: this.latestContextUsage, rateLimits }) };
    }
    throw new Error(`unsupported Codex runtime command: ${name}`);
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
    if (notification.method === "thread/tokenUsage/updated") {
      const params = notification.params as {
        tokenUsage?: { total?: unknown; last?: unknown; modelContextWindow?: unknown };
      } | undefined;
      const usage = codexContextUsageSnapshot(params?.tokenUsage);
      if (usage) {
        this.latestContextUsage = usage;
        this.contextUsageGate.observe();
      }
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

  async startTurn(input: RuntimeTurnInput): Promise<{ turnId: string }> {
    const prompt = this.seedHistory.length > 0
      ? renderSeedPrompt(this.seedHistory.splice(0), input.prompt)
      : input.prompt;
    const providerModelGeneration = this.providerModelGeneration;
    const response = await this.rpc.request<TurnResponse>("turn/start", {
      threadId: this.engineAgentId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
      ...(input.model ? { model: input.model } : {}),
      serviceTier: serviceTierForSpeed(input.speed),
      ...(input.effort ? { effort: input.effort } : {}),
    });
    this.activeTurnId = response.turn.id;
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
        const params = notification.params as { turnId?: unknown; tokenUsage?: { total?: unknown; last?: unknown; modelContextWindow?: unknown } } | undefined;
        if (typeof params?.turnId === "string") {
          const total = mapCodexTokenUsage(params.tokenUsage?.total);
          const requestUsage = mapCodexTokenUsage(params.tokenUsage?.last);
          if (total || requestUsage) {
            const contextUsage = codexContextUsageSnapshot(params.tokenUsage);
            const modelContextWindow = contextUsage?.modelContextWindow;
            if (contextUsage) this.latestContextUsage = contextUsage;

            // A resumed thread replays its prior cumulative total before the new
            // turn's events. That checkpoint is the durable interval baseline.
            if (total && params.turnId !== this.activeTurnId) {
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
            if (requestUsage && this.latestContextUsage && params.turnId === this.activeTurnId) yield {
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
  const number = (key: string) => typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] as number : undefined;
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
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    totalTokens: providerTotal ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

function normalizedToolResult(
  id: string,
  output: string,
  isError: boolean,
): Extract<AgentEvent, { type: "tool_result" }> {
  const failure = classifyToolFailure(output, isError);
  const canonicalIsError = isError || failure !== undefined;
  return {
    type: "tool_result",
    id,
    output,
    ...(canonicalIsError ? { isError: true } : {}),
    ...(failure ? { failureCategory: failure.category, retryable: failure.retryable, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) } : {}),
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
    // Deltas are transport-only progress. Canonical chat records the completed
    // item below so one engine answer never becomes dozens of message rows.
    return [];
  }
  if (notification.method === "item/reasoning/summaryTextDelta" || notification.method === "item/reasoning/textDelta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    return delta ? [{ type: "reasoning", delta }] : [];
  }
  if (notification.method === "turn/completed") {
    const turn = params?.turn as {
      status?: string;
      error?: { message?: string; code?: unknown } | null;
    } | undefined;
    if (turn?.status === "failed") {
      const message = turn.error?.message ?? "Codex turn failed";
      const rawCode = typeof turn.error?.code === "string" ? turn.error.code : undefined;
      const code = providerErrorCodeFromDetail(message, rawCode);
      return [{ type: "error", message, terminalStatus: "failed", ...(code ? { code } : {}) }];
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
  const item = params?.item as Record<string, unknown> | undefined;
  if (!item || typeof item.type !== "string") return [];
  if (notification.method === "item/started" && item.type === "commandExecution") {
    return typeof item.command === "string" ? [{
      type: "command",
      command: item.command,
      cwd: typeof item.cwd === "string" ? item.cwd : cwd,
      ...(typeof item.id === "string" ? { callId: item.id } : {}),
    }] : [];
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
  if (notification.method === "item/completed" && item.type === "fileChange" && Array.isArray(item.changes)) {
    return item.changes.flatMap((change) => {
      if (!change || typeof change !== "object") return [];
      const value = change as { path?: unknown; kind?: unknown; diff?: unknown };
      return typeof value.path === "string" ? [{
        type: "file_change" as const,
        path: value.path,
        kind: mapFileChangeKind(typeof value.kind === "string" ? value.kind : undefined),
        ...(typeof value.diff === "string" ? { diff: value.diff } : {}),
        ...(typeof item.id === "string" ? { callId: item.id } : {}),
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
    const isError = Boolean(item.error);
    return [normalizedToolResult(
      typeof item.id === "string" ? item.id : "mcp",
      JSON.stringify(item.result ?? item.error ?? ""),
      isError,
    )];
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
    const isError = item.success === false;
    return [normalizedToolResult(
      typeof item.id === "string" ? item.id : "dynamic-tool",
      JSON.stringify(item.contentItems ?? []),
      isError,
    )];
  }
  return [];
}
