import type { EngineDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useIsMutating, type QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queryKeys";
import {
  runtimeControlState,
  runtimeSelectionAfterChange,
  type RuntimeControlState,
  type RuntimeSelection,
} from "../conversationEngine";

// Share a queue across every surface editing the same next-Run owner. The key
// also detaches an observer on navigation, freezing queued mutation options.
export function runtimeMutationOptions(owner: string) {
  return { mutationKey: queryKeys.runtimeSelection(owner), scope: { id: `runtime:${owner}` } };
}

export function useRuntimeSaving(owner: string) {
  return useIsMutating({ mutationKey: queryKeys.runtimeSelection(owner), exact: true }) > 0;
}

// A newly opened surface must inherit the queued choice, not an older server
// snapshot. Read the existing mutation cache rather than adding another store.
export function pendingRuntimeSelection(queryClient: QueryClient, owner: string) {
  const queued = queryClient.getMutationCache().findAll({
    mutationKey: queryKeys.runtimeSelection(owner), exact: true, status: "pending",
  });
  const selection: { engine?: string; model?: string | null; effort?: string | null; speed?: string | null } = {};
  for (const item of queued) {
    const variables = item.state.variables as { patch?: object } & Record<string, unknown>;
    const patch = variables.patch ?? variables;
    for (const [field, agentKey, chatKey] of [
      ["engine", "activeEngine", "defaultEngine"], ["model", "model", "defaultModel"],
      ["effort", "effort", "defaultEffort"], ["speed", "speed", "defaultSpeed"],
    ] as const) {
      const key: string = agentKey in patch ? agentKey : chatKey;
      if (key in patch) Object.assign(selection, { [field]: (patch as Record<string, unknown>)[key] });
    }
  }
  return selection;
}

export interface RuntimeControls extends RuntimeControlState {
  selectModel(model: string): RuntimeSelection;
  selectEffort(effort: string): RuntimeSelection;
  selectSpeed(speed: string): RuntimeSelection;
}

export function useRuntimeControls({
  engine,
  preferences,
  project,
  selection,
  onChange,
}: {
  engine: EngineDto | undefined;
  preferences?: Pick<WorkspacePreferencesDto, "engineDefaults">;
  project?: Pick<ProjectDto, "defaultEngine" | "defaultModel" | "defaultEffort">;
  selection: RuntimeSelection;
  onChange(selection: RuntimeSelection): void;
}): RuntimeControls {
  const state = runtimeControlState(engine, selection);
  const selectModel = (model: string) => {
    const next = runtimeSelectionAfterChange(engine, preferences, project, selection, { model });
    onChange(next);
    return next;
  };
  const selectEffort = (effort: string) => {
    const next = runtimeSelectionAfterChange(engine, preferences, project, selection, { effort });
    onChange(next);
    return next;
  };
  const selectSpeed = (speed: string) => {
    const next = runtimeSelectionAfterChange(
      engine,
      preferences,
      project,
      selection,
      { speed },
    );
    onChange(next);
    return next;
  };
  return { ...state, selectModel, selectEffort, selectSpeed };
}
