// @ponderosa/engines — Adapter interface (re-exported from core) + engine adapters
// + event mappers. The ONLY package that knows engine-specific event shapes
// (AGENTS.md invariant 2). apps/server depends on this; nothing here calls a
// provider HTTP API or reads an API key (invariant 1) — engines are driven as
// already-authenticated CLIs (subscription auth).

export { CodexAdapter, renderSeedPrompt } from "./codex.js";
export type { CodexAdapterOptions, SpawnFn } from "./codex.js";
export { mapCodexEvent, mapFileChangeKind } from "./events.js";
export type { CodexMapContext } from "./events.js";
export { LineBuffer, parseJsonLine, parseJsonlChunks } from "./jsonl.js";
export { codexAuthStatus, codexHome } from "./auth.js";

// Re-export the Adapter contract from core so consumers import engines in one place.
export type { Adapter, AgentEvent, EngineAuthStatus } from "@ponderosa/core";

import type { Adapter, EngineAuthStatus } from "@ponderosa/core";
import { codexAuthStatus } from "./auth.js";
import { CodexAdapter } from "./codex.js";

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
  ];
}
