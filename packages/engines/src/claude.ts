// The Claude adapter (SPEC §5, the planned second engine). Drives the
// already-authenticated `claude` CLI (Claude Code) as a subscription-backed engine
// — Claude Pro/Max via the on-disk OAuth profile, NEVER the Anthropic API and
// NEVER an API key (AGENTS.md invariant 1). Spawns `claude -p --output-format
// stream-json` and resumes with `--resume <session-id>`. The choice of the CLI
// (vs the Agent SDK library) is invisible outside this file (invariant 2).

import { spawn as nodeSpawn } from "node:child_process";
import type {
  Adapter,
  ApiPriceProfile,
  AgentEvent,
  ContinueOptions,
  EngineCapabilities,
  EffortOption,
  ModelOption,
  OpenRuntimeSessionOptions,
  RuntimeProcessHandle,
  RuntimeSession,
  SeedOptions,
} from "@ponderosa/core";
import { claudeApiPriceProfile } from "./api-pricing.js";
import { mapClaudeEvent } from "./claude-events.js";
import { renderSeedPrompt } from "./seed-history.js";
import { streamProcess, type SpawnFn } from "./process.js";
import { composerCapabilities, discoverCliMcps, parseClaudeMcpList } from "./capabilities.js";
import { ClaudeStreamSession } from "./claude-stream-session.js";

export interface ClaudeAdapterOptions {
  /** Path/name of the claude binary. Default: "claude". */
  bin?: string;
  /** Injected spawn (for tests). */
  spawnFn?: SpawnFn;
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

const DEFAULT_EFFORTS: EffortOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
];

export class ClaudeAdapter implements Adapter {
  readonly id = "claude";
  readonly displayName = "Claude";

  private readonly bin: string;
  private readonly spawnFn: SpawnFn;
  private readonly permissionMode: string;
  private readonly killGraceMs: number;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.bin = opts.bin ?? "claude";
    this.spawnFn = opts.spawnFn ?? nodeSpawn;
    this.permissionMode =
      opts.permissionMode ??
      process.env.PONDEROSA_CLAUDE_PERMISSION_MODE ??
      "bypassPermissions";
    this.killGraceMs = opts.killGraceMs ?? 3000;
  }

  listModels(): ModelOption[] {
    return DEFAULT_MODELS;
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

  apiPriceProfile(model?: string): ApiPriceProfile | undefined {
    return claudeApiPriceProfile(model);
  }

  async capabilities(cwd: string, context?: { model?: string }): Promise<EngineCapabilities> {
    const mcpServers = await discoverCliMcps(this.bin, ["mcp", "list"], cwd, parseClaudeMcpList);
    return {
      steering: true,
      persistentSessions: true,
      ...(context?.model ? { model: context.model } : {}),
      commands: [],
      mcpServers,
      composerCapabilities: composerCapabilities([], [], mcpServers, "/"),
    };
  }

  openSession(opts: OpenRuntimeSessionOptions): Promise<RuntimeSession> {
    return Promise.resolve(new ClaudeStreamSession({
      ...opts,
      bin: this.bin,
      spawnFn: this.spawnFn,
      permissionMode: this.permissionMode,
      killGraceMs: this.killGraceMs,
    }));
  }

  /** Flags shared by seed + continue. */
  private baseArgs(prompt: string, model?: string, effort?: string): string[] {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      this.permissionMode,
    ];
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    return args;
  }

  seed(opts: SeedOptions): AsyncIterable<AgentEvent> {
    const prompt = renderSeedPrompt(opts.history, opts.prompt);
    return this.run(
      this.baseArgs(prompt, opts.model, opts.effort),
      opts.cwd,
      opts.signal,
      opts.environment,
      opts.onRuntimeRootExit,
      opts.onRuntimeSpawned,
    );
  }

  continue(opts: ContinueOptions): AsyncIterable<AgentEvent> {
    const args = [
      ...this.baseArgs(opts.prompt, opts.model, opts.effort),
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
      spawnFn: this.spawnFn,
      killGraceMs: this.killGraceMs,
      map: mapClaudeEvent,
      label: "claude",
    });
  }
}
