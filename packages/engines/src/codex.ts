// The Codex adapter (SPEC §5). Drives the already-authenticated `codex` CLI as a
// subscription-backed engine (AGENTS.md invariant 1 — NEVER an API key). Spawns
// `codex exec --json` / `codex exec resume`, streams JSONL, and maps it to
// AgentEvents. The spawn/exec-vs-resume mechanics are invisible outside this file.
//
// Decision (README): we spawn the CLI directly rather than depend on the
// `@openai/codex` TS SDK. The CLI's JSON contract is stable and gives us direct
// control over the `resume` flag quirks (no -C/-s on the resume subcommand) and
// the `-c` config overrides. The `Adapter` interface hides the choice entirely.

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  Adapter,
  ApiPriceProfile,
  AgentEvent,
  ContinueOptions,
  EngineCapabilities,
  EffortOption,
  ModelOption,
  OpenRuntimeSessionOptions,
  RuntimeSession,
  SeedOptions,
} from "@ponderosa/core";
import { codexApiPriceProfile } from "./api-pricing.js";
import { mapCodexEvent } from "./events.js";
import { streamProcess, type RuntimeProcessFaults, type SpawnFn } from "./process.js";
import { composerCapabilities, discoverCliMcps, discoverEnginePlugins, discoverMarkdownCommands, parseCodexMcpList } from "./capabilities.js";
import { CodexAppServerSession } from "./codex-app-server.js";
import { renderSeedPrompt } from "./seed-history.js";

export type { SpawnFn };

export interface CodexAdapterOptions {
  /** Path/name of the codex binary. Default: "codex". */
  bin?: string;
  /** Injected spawn (for tests). Default: node:child_process.spawn. */
  spawnFn?: SpawnFn;
  /**
   * Codex sandbox mode. Default "workspace-write" (edit the project + run commands
   * within it, headlessly). SPEC §11 allows full host access on the solo box; set
   * "danger-full-access" via option or PONDEROSA_CODEX_SANDBOX to widen it.
   */
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  /** ms to wait after SIGTERM before SIGKILL on cancel. Default 3000. */
  killGraceMs?: number;
  /** Override the CLI model cache path. Primarily useful for tests. */
  modelsCachePath?: string;
  processFaults?: RuntimeProcessFaults;
}

// Model availability differs by Codex version, account type, and subscription.
// The authenticated CLI maintains this cache from its model-list response, so it
// is a better source than a hardcoded catalog. Keep the default option as a safe
// fallback when Codex has not populated the cache yet.
const DEFAULT_MODELS: ModelOption[] = [{ id: "", label: "Codex default" }];

interface CodexCachedModel {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
}

interface CodexCachedReasoningLevel {
  effort?: unknown;
}

interface CodexModelsCache {
  models?: unknown;
}

export function readCodexModels(cachePath: string): ModelOption[] {
  try {
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as CodexModelsCache;
    if (!Array.isArray(cache.models)) return DEFAULT_MODELS;

    const seen = new Set<string>();
    const models = (cache.models as CodexCachedModel[]).flatMap((model) => {
      if (
        model.visibility !== "list" ||
        typeof model.slug !== "string" ||
        model.slug.trim() === "" ||
        seen.has(model.slug)
      ) {
        return [];
      }
      seen.add(model.slug);
      const hasEffortMetadata = Array.isArray(model.supported_reasoning_levels);
      const efforts = hasEffortMetadata
        ? (model.supported_reasoning_levels as CodexCachedReasoningLevel[]).reduce<EffortOption[]>((options, level) => {
            if (typeof level.effort !== "string" || !level.effort.trim() || options.some((option) => option.id === level.effort)) return options;
            options.push({ id: level.effort, label: effortLabel(level.effort) });
            return options;
          }, [])
        : [];
      return [{
        id: model.slug,
        label:
          typeof model.display_name === "string" && model.display_name.trim() !== ""
            ? model.display_name
            : model.slug,
        ...(hasEffortMetadata ? { efforts } : {}),
        ...(typeof model.default_reasoning_level === "string" && efforts.some((option) => option.id === model.default_reasoning_level)
          ? { defaultEffort: model.default_reasoning_level }
          : {}),
      }];
    });

    return models.length > 0 ? [...DEFAULT_MODELS, ...models] : DEFAULT_MODELS;
  } catch {
    return DEFAULT_MODELS;
  }
}

function effortLabel(effort: string): string {
  if (effort === "xhigh") return "Extra high";
  return `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;
}

const DEFAULT_EFFORTS: EffortOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

/**
 * Render an agent's chat history + the current prompt into a single seed prompt.
 * Deliberately minimal (SPEC §4/§5): no assembled packet — the agent reads the
 * repo's md files and git state from its cwd. In v1, `seed()` usually fires on the
 * first message, so `history` is empty or a single line.
 */
export { renderSeedPrompt } from "./seed-history.js";

export class CodexAdapter implements Adapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly modelSpecificEfforts = true;

  private readonly bin: string;
  private readonly spawnFn: SpawnFn;
  private readonly sandboxMode: string;
  private readonly killGraceMs: number;
  private readonly modelsCachePath: string;
  private readonly processFaults?: RuntimeProcessFaults;

  constructor(opts: CodexAdapterOptions = {}) {
    this.bin = opts.bin ?? "codex";
    this.spawnFn = opts.spawnFn ?? nodeSpawn;
    this.sandboxMode =
      opts.sandboxMode ?? process.env.PONDEROSA_CODEX_SANDBOX ?? "workspace-write";
    this.killGraceMs = opts.killGraceMs ?? 3000;
    const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
    this.modelsCachePath = opts.modelsCachePath ?? path.join(codexHome, "models_cache.json");
    this.processFaults = opts.processFaults;
  }

  listModels(): ModelOption[] {
    return readCodexModels(this.modelsCachePath);
  }

  listEfforts(model?: string): EffortOption[] {
    const models = this.listModels();
    if (model) return models.find((option) => option.id === model)?.efforts ?? DEFAULT_EFFORTS;
    const concreteModels = models.filter((option) => option.id);
    const reportedModels = concreteModels.filter((option) => option.efforts !== undefined);
    if (reportedModels.length === 0) return DEFAULT_EFFORTS;
    const candidates = reportedModels.length === concreteModels.length
      ? reportedModels[0]!.efforts!
      : DEFAULT_EFFORTS;
    return candidates.filter((candidate) =>
      reportedModels.every((option) => option.efforts!.some((effort) => effort.id === candidate.id)),
    );
  }

  defaultModel(): string | undefined {
    return this.listModels().find((option) => option.id)?.id;
  }

  defaultEffort(model?: string): string | undefined {
    const selectedModel = this.listModels().find((option) => option.id === (model ?? this.defaultModel()));
    const efforts = this.listEfforts(selectedModel?.id);
    return selectedModel?.defaultEffort ?? efforts.find((option) => option.id === "medium")?.id ?? efforts[0]?.id;
  }

  apiPriceProfile(model?: string): ApiPriceProfile | undefined {
    return codexApiPriceProfile(model);
  }

  async capabilities(cwd: string): Promise<EngineCapabilities> {
    const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
    const plugins = discoverEnginePlugins([
      { path: path.join(cwd, ".codex", "plugins"), requireInstallMarker: false },
      { path: path.join(codexHome, "plugins", "cache"), requireInstallMarker: true },
    ]);
    const commands = [...discoverMarkdownCommands([
      { path: path.join(cwd, ".codex", "skills"), source: "skill", skillFilesOnly: true },
      { path: path.join(codexHome, "skills"), source: "skill", skillFilesOnly: true },
    ]), ...plugins.flatMap((plugin) => plugin.commands)];
    const mcpServers = await discoverCliMcps(this.bin, ["mcp", "list"], cwd, parseCodexMcpList);
    return {
      steering: true,
      persistentSessions: true,
      commands,
      mcpServers,
      composerCapabilities: composerCapabilities(commands, plugins, mcpServers, "$"),
    };
  }

  openSession(opts: OpenRuntimeSessionOptions): Promise<RuntimeSession> {
    return CodexAppServerSession.open({
      ...opts,
      bin: this.bin,
      spawnFn: this.spawnFn,
      sandboxMode: this.sandboxMode,
      killGraceMs: this.killGraceMs,
    });
  }

  /** Config overrides accepted by BOTH `exec` and `exec resume`. */
  private configArgs(model?: string, effort?: string): string[] {
    const args = [
      "-c",
      `sandbox_mode=${JSON.stringify(this.sandboxMode)}`,
      "-c",
      'approval_policy="never"',
    ];
    if (model) args.push("-m", model);
    if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
    return args;
  }

  seed(opts: SeedOptions): AsyncIterable<AgentEvent> {
    const prompt = renderSeedPrompt(opts.history, opts.prompt);
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      ...this.configArgs(opts.model, opts.effort),
      "-",
    ];
    return this.run(args, opts.cwd, opts.signal, opts.environment, prompt, opts.onRuntimeRootExit);
  }

  continue(opts: ContinueOptions): AsyncIterable<AgentEvent> {
    const args = [
      "exec",
      "resume",
      opts.resumeSessionId,
      "--json",
      "--skip-git-repo-check",
      ...this.configArgs(opts.model, opts.effort),
      "-",
    ];
    return this.run(args, opts.cwd, opts.signal, opts.environment, opts.prompt, opts.onRuntimeRootExit);
  }

  /** Spawn codex, stream JSONL, and yield mapped AgentEvents. */
  private run(
    args: string[],
    cwd: string,
    signal: AbortSignal,
    environment?: Record<string, string>,
    stdin?: string,
    onRuntimeRootExit?: () => void,
  ): AsyncIterable<AgentEvent> {
    return streamProcess({
      bin: this.bin,
      args,
      cwd,
      signal,
      onRuntimeRootExit,
      environment,
      spawnFn: this.spawnFn,
      killGraceMs: this.killGraceMs,
      map: mapCodexEvent,
      label: "codex",
      stdin,
      faults: this.processFaults,
    });
  }
}
