// The Codex adapter (SPEC §5). Drives the already-authenticated `codex` CLI as a
// subscription-backed engine (AGENTS.md invariant 1 — NEVER an API key). Spawns
// `codex exec --json` / `codex exec resume`, streams JSONL, and maps it to
// AgentEvents. The spawn/exec-vs-resume mechanics are invisible outside this file.
//
// Decision (README): we spawn the CLI directly rather than depend on the
// `@openai/codex` TS SDK. The CLI's JSON contract is stable and gives us direct
// control over the `resume` flag quirks (no -C/-s on the resume subcommand) and
// the `-c` config overrides. The `Adapter` interface hides the choice entirely.

import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type {
  Adapter,
  AgentEvent,
  ContinueOptions,
  EngineCapabilities,
  EngineCapabilityDiscoveryOptions,
  EngineModelDiscoveryOptions,
  EngineModelCatalog,
  EngineModelValidationResult,
  EffortOption,
  ModelOption,
  OpenRuntimeSessionOptions,
  ProviderUsage,
  ProviderUsageReadOptions,
  ProviderUsageSnapshot,
  RuntimeProcessHandle,
  RuntimeSession,
  SeedOptions,
} from "@ponderosa/core";
import { mapCodexEvent } from "./events.js";
import { streamProcess } from "./process.js";
import { executablePath } from "./contained-spawn.js";
import { runtimeEnvironment } from "./runtime-environment.js";
import { codexAuthStatus, codexAvailabilityStatus } from "./auth.js";
import { discoverCliMcps, parseCodexMcpDiscovery } from "./capabilities.js";
import { CodexAppServerSession, discoverCodexAppServerCapabilities } from "./codex-app-server.js";
import { renderSeedPrompt } from "./seed-history.js";
import { readCodexProviderUsage, readCodexProviderUsageSnapshot } from "./provider-usage.js";

export interface CodexAdapterOptions {
  /** Path/name of the codex binary. Default: "codex". */
  bin?: string;
  /**
   * Codex sandbox mode. Default "workspace-write" (edit the project + run commands
   * within it, headlessly). SPEC §11 allows full host access on the solo box; set
   * "danger-full-access" via option or PONDEROSA_CODEX_SANDBOX to widen it.
   */
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  /** ms to wait after SIGTERM before SIGKILL on cancel. Default 3000. */
  killGraceMs?: number;
}

// The shared CLI disk cache can belong to another installed client version.
// Concrete choices come from the exact executing client's live inventory.
const DEFAULT_MODELS: ModelOption[] = [{ id: "", label: "Codex default" }];

/**
 * Render an agent's chat history + the current prompt into a single seed prompt.
 * Deliberately minimal (SPEC §4/§5): no assembled packet — the agent reads the
 * repo's md files and git state from its cwd. In v1, `seed()` usually fires on the
 * first message, so `history` is empty or a single line.
 */
export { renderSeedPrompt } from "./seed-history.js";

export class CodexAdapter implements Adapter {
  readonly id = "codex";
  readonly supportsVoiceReplyStream = true;
  readonly displayName = "Codex";
  readonly providerUsageCommand = {
    name: "status",
    description: "Show Codex subscription limits",
  };
  readonly modelSpecificEfforts = true;
  readonly trustedSystemPromptChannel = "developer" as const;

  private readonly bin: string;
  private readonly sandboxMode: string;
  private readonly killGraceMs: number;

  constructor(opts: CodexAdapterOptions = {}) {
    this.bin = opts.bin ?? "codex";
    this.sandboxMode =
      opts.sandboxMode ?? process.env.PONDEROSA_CODEX_SANDBOX ?? "workspace-write";
    this.killGraceMs = opts.killGraceMs ?? 3000;
  }

  listModels(): ModelOption[] { return DEFAULT_MODELS; }
  listEfforts(): EffortOption[] { return []; }

  modelCatalogConfigurationKey(): string {
    const executable = executablePath({ bin: this.bin, cwd: process.cwd(), env: runtimeEnvironment() });
    let identity: unknown;
    try { const file = statSync(executable!); identity = [file.dev, file.ino, file.size, file.mtimeMs]; } catch { /* Missing executables remain gated by host presence. */ }
    return createHash("sha256").update(JSON.stringify([executable ?? this.bin, identity,
      process.env.CODEX_HOME ?? path.join(homedir(), ".codex")])).digest("hex");
  }

  async discoverModelCatalog(cwd: string, context: EngineModelDiscoveryOptions): Promise<EngineModelCatalog> {
    const capabilities = await discoverCodexAppServerCapabilities({ bin: this.bin, cwd,
      sandboxMode: this.sandboxMode, killGraceMs: this.killGraceMs, configuredMcps: [], modelCatalogOnly: true,
      ...context });
    if (!capabilities.modelCatalog) throw new Error("Codex model inventory is unavailable");
    return { ...capabilities.modelCatalog, configurationKey: this.modelCatalogConfigurationKey() };
  }

  async validateModel(_cwd: string, modelId: string, context: EngineModelDiscoveryOptions): Promise<EngineModelValidationResult> {
    const result = await codexAvailabilityStatus({ ...process.env, PONDEROSA_CODEX_BIN: this.bin },
      undefined, () => codexAuthStatus({ ...process.env, PONDEROSA_CODEX_BIN: this.bin }, context), { ...context, model: modelId });
    if (result.available) return { valid: true, model: { id: modelId, label: modelId,
      kind: "exact", source: "provider-probe", availability: "available", validatedAt: new Date().toISOString() } };
    const category = result.failureCategory;
    return { valid: false, errorCode: category === "unavailable" ? "network" : !category || category === "unknown" ? "provider_error" : category,
      error: result.detail ?? "Codex model test did not complete." };
  }

  async capabilities(cwd: string, context: EngineCapabilityDiscoveryOptions): Promise<EngineCapabilities> {
    const configuredMcps = await discoverCliMcps(this.bin, ["mcp", "list", "--json"], cwd, parseCodexMcpDiscovery, context, this.killGraceMs);
    if (context.signal.aborted) throw new Error("codex capability discovery aborted");
    return discoverCodexAppServerCapabilities({
      bin: this.bin,
      cwd,
      model: context?.model,
      sandboxMode: this.sandboxMode,
      killGraceMs: this.killGraceMs,
      configuredMcps,
      signal: context.signal,
      onRuntimeSpawned: context.onRuntimeSpawned,
    });
  }

  async openSession(opts: OpenRuntimeSessionOptions): Promise<RuntimeSession> {
    // A persistent session must have exactly one spawn path, registered through
    // onRuntimeSpawned before readiness. Running a CLI inventory helper here
    // creates an unregistered provider process that daemon shutdown cannot
    // terminate while openSession() is still pending. The live app-server's
    // mcpServerStatus/list response is the authoritative session projection;
    // sessionless discovery still joins it with `codex mcp list --json` above.
    return CodexAppServerSession.open({
      ...opts,
      bin: this.bin,
      sandboxMode: this.sandboxMode,
      killGraceMs: this.killGraceMs,
      // Enable the CLI feature for later turns on this reused session. Only
      // turn/start's explicit serviceTier selects Fast; standard sends null.
      enableFastMode: true,
    });
  }

  readProviderUsage(options: ProviderUsageReadOptions): Promise<ProviderUsage> {
    return readCodexProviderUsage({
      bin: this.bin,
      sandboxMode: this.sandboxMode,
      killGraceMs: this.killGraceMs,
      options,
    });
  }

  readProviderUsageSnapshot(
    options: ProviderUsageReadOptions,
  ): Promise<ProviderUsageSnapshot> {
    return readCodexProviderUsageSnapshot({
      bin: this.bin,
      sandboxMode: this.sandboxMode,
      killGraceMs: this.killGraceMs,
      options,
    });
  }

  /** Config overrides accepted by BOTH `exec` and `exec resume`. */
  private configArgs(model?: string, effort?: string, speed?: string, systemPrompt?: string): string[] {
    const args = [
      "-c",
      `sandbox_mode=${JSON.stringify(this.sandboxMode)}`,
      "-c",
      'approval_policy="never"',
    ];
    if (systemPrompt) args.push("-c", `developer_instructions=${JSON.stringify(systemPrompt)}`);
    if (model) args.push("-m", model);
    if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
    if (speed) {
      if (speed === "fast" || speed === "priority") {
        args.push("-c", "features.fast_mode=true");
      }
      args.push(
        "-c",
        `service_tier=${JSON.stringify(
          speed === "standard" ? "default" : speed,
        )}`,
      );
    }
    return args;
  }

  seed(opts: SeedOptions): AsyncIterable<AgentEvent> {
    const prompt = renderSeedPrompt(opts.history, opts.prompt);
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      ...this.configArgs(opts.model, opts.effort, opts.speed, opts.systemPrompt),
      "-",
    ];
    return this.run(args, opts.cwd, opts.signal, opts.environment, prompt, opts.onRuntimeRootExit, opts.onRuntimeSpawned);
  }

  continue(opts: ContinueOptions): AsyncIterable<AgentEvent> {
    const args = [
      "exec",
      "resume",
      opts.resumeSessionId,
      "--json",
      "--skip-git-repo-check",
      ...this.configArgs(opts.model, opts.effort, opts.speed, opts.systemPrompt),
      "-",
    ];
    return this.run(args, opts.cwd, opts.signal, opts.environment, opts.prompt, opts.onRuntimeRootExit, opts.onRuntimeSpawned);
  }

  /** Spawn codex, stream JSONL, and yield mapped AgentEvents. */
  private run(
    args: string[],
    cwd: string,
    signal: AbortSignal,
    environment?: Record<string, string>,
    stdin?: string,
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
      map: mapCodexEvent,
      label: "codex",
      stdin,
    });
  }
}
