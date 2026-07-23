import type { EngineDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import {
  runtimeControlState,
  runtimeSelectionAfterChange,
  type RuntimeControlState,
  type RuntimeSelection,
} from "../conversationEngine";

export interface RuntimeControls extends RuntimeControlState {
  selectModel(model: string): RuntimeSelection;
  selectEffort(effort: string): RuntimeSelection;
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
  return { ...state, selectModel, selectEffort };
}
