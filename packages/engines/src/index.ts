// @ponderosa/engines — Adapter interface (re-exported from core) + engine adapters
// + event mappers. The ONLY package that knows engine-specific event shapes
// (AGENTS.md invariant 2). apps/server depends on this; nothing here calls a
// provider HTTP API or reads an API key (invariant 1) — engines are driven as
// already-authenticated CLIs (subscription auth).

export { CodexAdapter, renderSeedPrompt } from "./codex.js";
export { CodexAppServerSession, mapCodexAppServerNotification } from "./codex-app-server.js";
export type { CodexAdapterOptions, SpawnFn } from "./codex.js";
export { ClaudeAdapter } from "./claude.js";
export { ClaudeStreamSession } from "./claude-stream-session.js";
export type { ClaudeAdapterOptions } from "./claude.js";
export { mapCodexEvent, mapFileChangeKind } from "./events.js";
export { mapClaudeEvent } from "./claude-events.js";
export type { CodexMapContext } from "./events.js";
export { streamProcess } from "./process.js";
export type { ProcessStreamSnapshot, RuntimeProcessFaults } from "./process.js";
export { LineBuffer, parseJsonLine, parseJsonlChunks } from "./jsonl.js";
export { codexAuthStatus, codexHome, claudeAuthStatus } from "./auth.js";
export { shouldRolloverEngineSession } from "./session-recovery.js";
export { discoverMarkdownCommands, parseClaudeMcpList, parseCodexMcpList } from "./capabilities.js";

// Re-export the Adapter contract from core so consumers import engines in one place.
export type { Adapter, AgentEvent, EngineAuthStatus } from "@ponderosa/core";

import type { Adapter, EngineAuthStatus } from "@ponderosa/core";
import { claudeAuthStatus, codexAuthStatus } from "./auth.js";
import { CodexAdapter } from "./codex.js";
import { ClaudeAdapter } from "./claude.js";

export interface EngineRegistration {
  adapter: Adapter;
  authStatus?: () => Promise<EngineAuthStatus>;
}

export function defaultEngineRegistrations(): EngineRegistration[] {
  return [
    {
      adapter: new CodexAdapter(),
      authStatus: codexAuthStatus,
    },
    {
      adapter: new ClaudeAdapter(),
      authStatus: claudeAuthStatus,
    },
  ];
}
