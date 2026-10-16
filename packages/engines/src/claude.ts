// The Claude adapter (SPEC §5, the planned second engine). Drives the
// already-authenticated `claude` CLI (Claude Code) as a subscription-backed engine
// — Claude Pro/Max via the on-disk OAuth profile, NEVER the Anthropic API and
// NEVER an API key (AGENTS.md invariant 1). Spawns `claude -p --output-format
// stream-json` and resumes with `--resume <session-id>`. The choice of the CLI
// (vs the Agent SDK library) is invisible outside this file (invariant 2).

import { createHash } from "node:crypto";
import type {
  Adapter,
  AgentEvent,
  ContinueOptions,
  EngineCapabilities,
  EngineCapabilityDiscoveryOptions,
  EngineModelCatalog,
  EngineModelDiscoveryOptions,
  EngineModelOption,
  EngineModelValidationResult,
  EffortOption,
  ModelOption,
  OpenRuntimeSessionOptions,
  ProviderUsage,
  ProviderUsageReadOptions,
  RuntimeProcessHandle,
  RuntimeSession,
  SeedOptions,
} from "@ponderosa/core";
import { mapClaudeEvent } from "./claude-events.js";
import { renderSeedPrompt } from "./seed-history.js";
import { streamProcess } from "./process.js";
import { composerCapabilities, discoverCliMcps, parseClaudeMcpList } from "./capabilities.js";
import { ClaudeStreamSession } from "./claude-stream-session.js";
import { ClaudeModelCatalogProbe } from "./claude-models.js";
import { readClaudeProviderUsage } from "./provider-usage.js";

export interface ClaudeAdapterOptions {
  /** Path/name of the claude binary. Default: "claude". */
  bin?: string;
  /** Environment used to discover Claude Code's configured model pins. */
  modelEnvironment?: Readonly<Record<string, string | undefined>>;
  /**
   * Claude Code permission mode. Default "bypassPermissions" so the agent can edit
   * files and run commands headlessly (SPEC §11 full-access model on the solo box).
   * Override via option or PONDEROSA_CLAUDE_PERMISSION_MODE.
   */
  permissionMode?: string;
  /** ms to wait after SIGTERM before SIGKILL on cancel. Default 3000. */
  killGraceMs?: number;
}

// Aliases resolve to the account's current models via the CLI; an empty id means
// "let the authenticated CLI choose" (avoids hardcoding ids that go stale).
const DEFAULT_MODELS: ModelOption[] = [
  { id: "", label: "Claude default" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

const CONFIGURED_MODEL_ENVIRONMENT = [
  ["ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME"],
  ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"],
  ["ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"],
  ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME"],
  ["ANTHROPIC_CUSTOM_MODEL_OPTION", "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"],
] as const;

function environmentConfiguredClaudeModels(
  environment: Readonly<Record<string, string | undefined>>,
): EngineModelOption[] {
  const models: EngineModelOption[] = [];
  const seen = new Set<string>();
  for (const [idKey, nameKey] of CONFIGURED_MODEL_ENVIRONMENT) {
    const id = environment[idKey]?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: environment[nameKey]?.trim() || id,
      kind: id.startsWith("claude-") ? "exact" : "alias",
      source: "environment",
      availability: "available",
    });
  }
  return models;
}

function configuredClaudeModels(
  environment: Readonly<Record<string, string | undefined>>,
  operatorModels: EngineModelOption[],
): ModelOption[] {
  // Invocation IDs ending in [1m] must retain that suffix even though Claude
  // uses the suffix-free base ID for entitlement and cost accounting.
  const models = DEFAULT_MODELS.map((model) => ({ ...model }));
  const indexById = new Map(models.map((model, index) => [model.id, index]));
  for (const model of operatorModels) {
    const id = model.id.trim();
    if (!id || indexById.has(id)) continue;
    indexById.set(id, models.length);
    models.push({
      id,
      label: model.label.trim() || id,
      ...(model.supportedEffortLevels
        ? { efforts: model.supportedEffortLevels.map((effort) => ({ id: effort, label: effort })) }
        : {}),
    });
  }
  for (const model of environmentConfiguredClaudeModels(environment)) {
    const index = indexById.get(model.id);
    if (index === undefined) {
      indexById.set(model.id, models.length);
      models.push(model);
    } else {
      models[index] = model;
    }
  }
  return models;
}

const DEFAULT_EFFORTS: EffortOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
];

export class ClaudeAdapter implements Adapter {
  readonly id = "claude";
  readonly displayName = "Claude";
  readonly trustedSystemPromptChannel = "system" as const;
  readonly providerUsageCommand = {
    name: "usage",
    description: "Show Claude subscription usage",
  };

  private readonly bin: string;
  private readonly modelEnvironment: Readonly<Record<string, string | undefined>>;
  private operatorModels: EngineModelOption[] = [];
  private readonly permissionMode: string;
  private readonly killGraceMs: number;
  private readonly modelCatalogProbe: ClaudeModelCatalogProbe;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.bin = opts.bin ?? "claude";
    this.modelEnvironment = opts.modelEnvironment ?? process.env;
    this.permissionMode =
      opts.permissionMode ??
      process.env.PONDEROSA_CLAUDE_PERMISSION_MODE ??
      "bypassPermissions";
    this.killGraceMs = opts.killGraceMs ?? 3000;
    this.modelCatalogProbe = new ClaudeModelCatalogProbe({
      bin: this.bin,
      environment: this.modelEnvironment,
      killGraceMs: this.killGraceMs,
    });
  }

  listModels(): ModelOption[] {
    return configuredClaudeModels(this.modelEnvironment, this.operatorModels);
  }

  configuredModelOptions(): ModelOption[] {
    return environmentConfiguredClaudeModels(this.modelEnvironment);
  }

  setOperatorModelOptions(models: EngineModelOption[]): void {
    this.operatorModels = models.map((model) => ({ ...model }));
  }

  modelCatalogConfigurationKey(): string {
    const configuredEnvironment = Object.fromEntries(
      CONFIGURED_MODEL_ENVIRONMENT.flatMap(([idKey, nameKey]) => [
        [idKey, this.modelEnvironment[idKey]?.trim() ?? ""],
        [nameKey, this.modelEnvironment[nameKey]?.trim() ?? ""],
      ]),
    );
    return createHash("sha256").update(JSON.stringify({
      configuredEnvironment,
      operatorModels: this.operatorModels,
    })).digest("hex");
  }

  configuredModelCatalog(providerModels: EngineModelOption[]): EngineModelOption[] {
    const models = providerModels.map((model) => ({ ...model }));
    const indexById = new Map(models.map((model, index) => [model.id, index]));
    for (const model of this.operatorModels) {
      const id = model.id.trim();
      if (!id || indexById.has(id)) continue;
      indexById.set(id, models.length);
      models.push({
        ...model,
        id,
        label: model.label.trim() || id,
        kind: "exact",
        source: "operator",
      });
    }
    // Host environment configuration remains authoritative on ID collision.
    for (const model of environmentConfiguredClaudeModels(this.modelEnvironment)) {
      const index = indexById.get(model.id);
      if (index === undefined) {
        indexById.set(model.id, models.length);
        models.push(model);
      } else {
        models[index] = model;
      }
    }
    return models;
  }

  async discoverModelCatalog(
    cwd: string,
    context: EngineModelDiscoveryOptions,
  ): Promise<EngineModelCatalog> {
    const result = await this.modelCatalogProbe.discover(cwd, context);
    return {
      models: this.configuredModelCatalog(result.models),
      cliVersion: result.cliVersion,
      configurationKey: this.modelCatalogConfigurationKey(),
    };
  }

  validateModel(
    cwd: string,
    modelId: string,
    context: EngineModelDiscoveryOptions,
  ): Promise<EngineModelValidationResult> {
    return this.modelCatalogProbe.validate(cwd, modelId, context);
  }

  listEfforts(): EffortOption[] {
    return DEFAULT_EFFORTS;
  }

  defaultModel(): string {
    return "sonnet";
  }

  defaultEffort(): string {
    return "high";
  }

  async capabilities(cwd: string, context: EngineCapabilityDiscoveryOptions): Promise<EngineCapabilities> {
    const mcpServers = await discoverCliMcps(this.bin, ["mcp", "list"], cwd, parseClaudeMcpList, context, this.killGraceMs);
    const commands = [{
      name: this.providerUsageCommand.name,
      description: this.providerUsageCommand.description,
      source: "adapter-implemented" as const,
      acceptsArguments: false,
      insertText: `/${this.providerUsageCommand.name}`,
      status: "available" as const,
      invocation: "runtime" as const,
    }];
    return {
      steering: true,
      persistentSessions: true,
      ...(context?.model ? { model: context.model } : {}),
      commands,
      mcpServers,
      composerCapabilities: composerCapabilities(commands, [], mcpServers, "/"),
    };
  }

  openSession(opts: OpenRuntimeSessionOptions): Promise<RuntimeSession> {
    return Promise.resolve(new ClaudeStreamSession({
      ...opts,
      bin: this.bin,
      permissionMode: this.permissionMode,
      killGraceMs: this.killGraceMs,
    }));
  }

  readProviderUsage(options: ProviderUsageReadOptions): Promise<ProviderUsage> {
    return readClaudeProviderUsage({
      bin: this.bin,
      killGraceMs: this.killGraceMs,
      options,
    });
  }

  /** Flags shared by seed + continue. */
  private baseArgs(prompt: string, systemPrompt?: string, model?: string, effort?: string): string[] {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      this.permissionMode,
    ];
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    return args;
  }

  seed(opts: SeedOptions): AsyncIterable<AgentEvent> {
    const prompt = renderSeedPrompt(opts.history, opts.prompt);
    return this.run(
      this.baseArgs(prompt, opts.systemPrompt, opts.model, opts.effort),
      opts.cwd,
      opts.signal,
      opts.environment,
      opts.onRuntimeRootExit,
      opts.onRuntimeSpawned,
    );
  }

  continue(opts: ContinueOptions): AsyncIterable<AgentEvent> {
    const args = [
      ...this.baseArgs(opts.prompt, opts.systemPrompt, opts.model, opts.effort),
      "--resume",
      opts.resumeSessionId,
    ];
    return this.run(args, opts.cwd, opts.signal, opts.environment, opts.onRuntimeRootExit, opts.onRuntimeSpawned);
  }

  private run(
    args: string[],
    cwd: string,
    signal: AbortSignal,
    environment?: Record<string, string>,
    onRuntimeRootExit?: () => void,
    onRuntimeSpawned?: (handle: RuntimeProcessHandle) => void,
  ): AsyncIterable<AgentEvent> {
    return streamProcess({
      bin: this.bin,
      args,
      cwd,
      signal,
      onRuntimeRootExit,
      onRuntimeSpawned,
      environment,
      killGraceMs: this.killGraceMs,
      map: mapClaudeEvent,
      label: "claude",
    });
  }
}
