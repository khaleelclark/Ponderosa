import type { EngineDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { resolveConversationEngine } from "../src/conversationEngine";

const engine = (id: string, authenticated: boolean): EngineDto => ({
  id,
  displayName: id,
  models: [],
  efforts: [],
  authenticated,
});

describe("Project chat engine initialization", () => {
  it("waits for the live engine query instead of locking in an empty selection", () => {
    expect(resolveConversationEngine(undefined, [])).toBeUndefined();
    expect(resolveConversationEngine(undefined, [engine("codex", true)])).toBe("codex");
  });

  it("keeps a valid persisted default and fails over from a stale one", () => {
    const engines = [engine("codex", true), engine("claude", false)];
    expect(resolveConversationEngine("claude", engines)).toBe("claude");
    expect(resolveConversationEngine("removed", engines)).toBe("codex");
  });
});
