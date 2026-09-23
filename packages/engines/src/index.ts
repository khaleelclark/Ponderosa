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
export { processBirthMarker, processGroupAlive, recoveredRuntimeProcessHandle, runtimeProcessIdentity, terminateProcessGroup } from "./process-termination.js";
export { JSONL_MAX_RECORD_BYTES, JsonlRecordLimitError, LineBuffer, parseJsonLine, parseJsonlChunks } from "./jsonl.js";
export { codexAuthStatus, codexAvailabilityStatus, codexHome, claudeAuthStatus, claudeAvailabilityStatus } from "./auth.js";
export { shouldRolloverEngineSession, classifyProviderFailure } from "./session-recovery.js";
export type { ProviderFailureKind } from "./session-recovery.js";
export {
  normalizeCodexProviderUsage,
  parseClaudeUsageText,
  readClaudeProviderUsage,
  readCodexProviderUsage,
} from "./provider-usage.js";
export { composerCapabilities, discoverEnginePlugins, discoverMarkdownCommands, parseClaudeMcpList, parseCodexMcpList } from "./capabilities.js";

// Re-export the Adapter contract from core so consumers import engines in one place.
export type { Adapter, AgentEvent, EngineAuthStatus, EngineAvailabilityStatus } from "@ponderosa/core";

import type { Adapter, EngineAuthStatus, EngineAvailabilityStatus } from "@ponderosa/core";
import { claudeAuthStatus, claudeAvailabilityStatus, codexAuthStatus, codexAvailabilityStatus } from "./auth.js";
import { CodexAdapter } from "./codex.js";
import { ClaudeAdapter } from "./claude.js";

export interface EngineRegistration {
  adapter: Adapter;
  authStatus?: () => Promise<EngineAuthStatus>;
  /** Explicit, provider-backed entitlement check; never run during polling. */
  availabilityProbe?: () => Promise<EngineAvailabilityStatus>;
}

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
  const codexBin = configuredProviderBinary(env, "PONDEROSA_CODEX_BIN", "codex");
  const claudeBin = configuredProviderBinary(env, "PONDEROSA_CLAUDE_BIN", "claude");
  return [
    {
      adapter: new CodexAdapter({ bin: codexBin }),
      authStatus: () => codexAuthStatus(env),
      availabilityProbe: () => codexAvailabilityStatus(env),
    },
    {
      adapter: new ClaudeAdapter({
        bin: claudeBin,
        modelEnvironment: env,
      }),
      authStatus: () => claudeAuthStatus(env),
      availabilityProbe: () => claudeAvailabilityStatus(env),
    },
  ];
}
