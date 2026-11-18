import type { EngineDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useIsMutating, type QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queryKeys";
import type {MutationNotifier} from "../components/MutationNotifications";
import {productApiPath} from "../api/productScope";
import {createClientId} from "../clientId";
import {
  runtimeControlState,
  runtimeSelectionAfterChange,
  type RuntimeControlState,
  type RuntimeSelection,
} from "../conversationEngine";

// Share a queue across every surface editing the same next-Run owner. The key
// also detaches an observer on navigation, freezing queued mutation options.
export function runtimeFeedbackKey(owner:string,namespace=productApiPath("/api/conversations")):string {
  return JSON.stringify([namespace,owner,"runtime-selection"]);
}
export function runtimeMutationKey(owner:string,namespace=productApiPath("/api/conversations")) {
  return [...queryKeys.runtimeSelection(owner),namespace] as const;
}
export function runtimeMutationOptions(owner: string, notify?:MutationNotifier) {
  const key=runtimeFeedbackKey(owner);
  return { mutationKey: runtimeMutationKey(owner), scope: { id: `runtime:${key}` },
    ...(notify ? {onError:(error:unknown)=>notify({key,incident:createClientId("runtime-feedback-"),severity:"error",message:"Runtime Selection Not Saved",description:"The last saved selection is retained. Review the original Chat or Agent before choosing again.",details:error instanceof Error?error.message:String(error)})} : {}),
  };
}

export function useRuntimeSaving(owner: string) {
  return useIsMutating({ mutationKey: runtimeMutationKey(owner), exact: true }) > 0;
}

// A newly opened surface must inherit the queued choice, not an older server
// snapshot. Read the existing mutation cache rather than adding another store.
export function pendingRuntimeSelection(queryClient: QueryClient, owner: string) {
  const queued = queryClient.getMutationCache().findAll({
    mutationKey: runtimeMutationKey(owner), exact: true, status: "pending",
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
