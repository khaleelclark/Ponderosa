import type { EngineDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { effortOptionsForModel, effortSelectionIsCompatible, engineAvailabilityPresentation, engineIsAvailable, modelSelectionIsCompatible, resolveConversationEngine, selectedRunConfig } from "../src/conversationEngine";

const engine = (id: string, authenticated: boolean): EngineDto => ({
  id,
  displayName: id,
  models: [],
  efforts: [],
  configured: true,
  authenticated,
  available: authenticated,
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

  it("distinguishes configured authentication from proven provider availability", () => {
    expect(engineIsAvailable({ ...engine("claude", true), available: false })).toBe(false);
    expect(engineIsAvailable(engine("codex", true))).toBe(true);
    expect(engineIsAvailable({ ...engine("codex", true), enabled: false })).toBe(false);
  });

  it("keeps the workspace operational when one enabled provider is available", () => {
    const presentation = engineAvailabilityPresentation([
      { ...engine("codex", true), displayName: "Codex" },
      { ...engine("claude", true), displayName: "Claude", available: false, availabilityDetail: "Subscription access is inactive." },
    ]);
    expect(presentation.label).toBe("Engine ready");
    expect(presentation.severity).toBe("success");
    expect(presentation.detail).toContain("1 of 2 enabled engines ready");
    expect(presentation.detail).toContain("Claude is unavailable: Subscription access is inactive.");
  });

  it("needs attention only when no enabled provider can run work", () => {
    const presentation = engineAvailabilityPresentation([
      { ...engine("claude", true), displayName: "Claude", available: false },
      { ...engine("codex", true), displayName: "Codex", enabled: false },
    ]);
    expect(presentation.label).toBe("Needs attention");
    expect(presentation.severity).toBe("warning");
    expect(presentation.detail).toContain("No enabled engine can currently run work");
    expect(presentation.detail).toContain("Codex is disabled");
  });

  it("forwards the selected model and effort to the first Project-chat run", () => {
    expect(selectedRunConfig("gpt-5.6-luna", "high")).toEqual({
      model: "gpt-5.6-luna",
      effort: "high",
    });
    expect(selectedRunConfig("", "")).toEqual({});
  });

  it("uses the exact provider effort roster for the selected model", () => {
    const configured: EngineDto = {
      ...engine("codex", true),
      models: [
        { id: "sol", label: "Sol", efforts: [{ id: "ultra", label: "Ultra" }] },
        { id: "luna", label: "Luna", efforts: [{ id: "high", label: "High" }] },
      ],
      efforts: [{ id: "high", label: "High" }, { id: "ultra", label: "Ultra" }],
    };
    expect(effortOptionsForModel(configured, "luna").map((option) => option.id)).toEqual(["high"]);
    expect(effortOptionsForModel(configured, "sol").map((option) => option.id)).toEqual(["ultra"]);
    expect(effortOptionsForModel(configured, "").map((option) => option.id)).toEqual(["high", "ultra"]);
  });

  it("preserves saved selections while provider catalog metadata is unknown", () => {
    const unknown: EngineDto = { ...engine("codex", true), modelCatalogKnown: false };
    expect(modelSelectionIsCompatible(unknown, "saved-model")).toBe(true);
    expect(effortSelectionIsCompatible(unknown, "saved-model", "ultra")).toBe(true);

    const known: EngineDto = { ...unknown, modelCatalogKnown: true };
    expect(modelSelectionIsCompatible(known, "saved-model")).toBe(false);
    expect(effortSelectionIsCompatible(known, "", "ultra")).toBe(false);

    const partial: EngineDto = {
      ...known,
      models: [{ id: "known-model", label: "Known model" }],
      efforts: [{ id: "high", label: "High" }],
    };
    expect(modelSelectionIsCompatible(partial, "known-model")).toBe(true);
    expect(effortSelectionIsCompatible(partial, "known-model", "saved-effort")).toBe(true);
  });
});
