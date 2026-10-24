// @ponderosa/engines — Adapter interface (re-exported from core) + engine adapters
// + event mappers. The ONLY package that knows engine-specific event shapes
// (AGENTS.md invariant 2). apps/server depends on this; nothing here calls a
// provider HTTP API or reads an API key (invariant 1) — engines are driven as
// already-authenticated CLIs (subscription auth).

export { CodexAdapter, renderSeedPrompt } from "./codex.js";
export { CodexAppServerSession, mapCodexAppServerNotification } from "./codex-app-server.js";
export type { CodexAdapterOptions } from "./codex.js";
export { ClaudeAdapter } from "./claude.js";
export { ClaudeModelCatalogProbe, claudeModelDisplayName, normalizeClaudeProviderModels } from "./claude-models.js";
export { ClaudeStreamSession } from "./claude-stream-session.js";
export type { ClaudeAdapterOptions } from "./claude.js";
export { mapCodexEvent, mapFileChangeKind } from "./events.js";
export { AgentEventProjectionError, projectAgentEvent } from "./agent-event-projection.js";
export { mapClaudeEvent } from "./claude-events.js";
export type { CodexMapContext } from "./events.js";
export { streamProcess } from "./process.js";
export { processBirthMarker, processGroupAlive, recoveredRuntimeProcessHandle, runtimeProcessHandle, runtimeProcessIdentity, terminateProcessGroup } from "./process-termination.js";
export { spawnWindowsContainedProcess } from "./windows-job-process.js";
export type { NativeProcessTreeAuthority } from "./process-termination.js";
export { JSONL_MAX_RECORD_BYTES, JsonlRecordLimitError, LineBuffer, parseJsonLine, parseJsonlChunks } from "./jsonl.js";
export { codexAuthStatus, codexAvailabilityStatus, codexHome, claudeAuthStatus, claudeAvailabilityStatus } from "./auth.js";
export { shouldRolloverEngineSession, preserveEngineSessionRecoverySignal, classifyProviderFailure } from "./session-recovery.js";
export type { ProviderFailureKind } from "./session-recovery.js";
export {
  normalizeCodexProviderUsage,
  parseClaudeUsageText,
  readClaudeProviderUsage,
  readCodexProviderUsage,
} from "./provider-usage.js";
export { composerCapabilities, parseClaudeMcpList, parseCodexMcpList } from "./capabilities.js";

// Re-export the Adapter contract from core so consumers import engines in one place.
export type { Adapter, AgentEvent, EngineAuthStatus, EngineAvailabilityStatus, EngineRegistration } from "@ponderosa/core";

import { executableAvailable } from "./contained-spawn.js";
import { runtimeEnvironment } from "./runtime-environment.js";
import type { EngineRegistration } from "@ponderosa/core";
import { claudeAuthStatus, claudeAvailabilityStatus, codexAuthStatus, codexAvailabilityStatus } from "./auth.js";
import { CodexAdapter } from "./codex.js";
import { ClaudeAdapter } from "./claude.js";

function configuredProviderBinary(
  env: NodeJS.ProcessEnv,
  key: "PONDEROSA_CODEX_BIN" | "PONDEROSA_CLAUDE_BIN",
  fallback: "codex" | "claude",
): string {
  return env[key]?.trim() || fallback;
}

export function defaultEngineRegistrations(
  env: NodeJS.ProcessEnv = process.env,
): EngineRegistration[] {
  env = runtimeEnvironment(env);
  const codexBin = configuredProviderBinary(env, "PONDEROSA_CODEX_BIN", "codex");
  const claudeBin = configuredProviderBinary(env, "PONDEROSA_CLAUDE_BIN", "claude");
  const installed = (bin: string): boolean => executableAvailable({ bin, cwd: process.cwd(), env });
  return [
    {
      adapter: new CodexAdapter({ bin: codexBin }),
      isInstalled: () => installed(codexBin),
      authStatus: options => installed(codexBin)
        ? codexAuthStatus(env, options) : Promise.resolve({ authenticated: false }),
      availabilityProbe: options => codexAvailabilityStatus(env, undefined, () => codexAuthStatus(env, options), options),
    },
    {
      adapter: new ClaudeAdapter({
        bin: claudeBin,
        modelEnvironment: env,
      }),
      isInstalled: () => installed(claudeBin),
      authStatus: () => installed(claudeBin)
        ? claudeAuthStatus(env) : Promise.resolve({ authenticated: false }),
      availabilityProbe: options => claudeAvailabilityStatus(env, undefined, undefined, options),
    },
  ];
}

export { spawnContainedCli } from "./contained-spawn.js";
export { runtimeEnvironment } from "./runtime-environment.js";

export {CodexResponseText} from "./codex-response-text.js";
