import type { CreateProjectRequest } from "@ponderosa/core";

export type ProjectFolderMode = "none" | "existing";

export function projectCreationDisabled(input: {
  label: string;
  mode: ProjectFolderMode;
  existingPath: string;
  pending: boolean;
  defaultEngine: string;
}): boolean {
  return input.pending || !input.label.trim() || !input.defaultEngine ||
    (input.mode === "existing" && !input.existingPath.trim());
}

export function createProjectRequest(input: {
  label: string;
  mode: ProjectFolderMode;
  existingPath: string;
  defaultEngine: CreateProjectRequest["defaultEngine"];
  defaultModel?: string;
  defaultEffort?: string;
}): CreateProjectRequest {
  return {
    label: input.label.trim(),
    defaultEngine: input.defaultEngine,
    ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
    ...(input.defaultEffort ? { defaultEffort: input.defaultEffort } : {}),
    ...(input.mode === "existing"
      ? { hostPath: input.existingPath.trim() }
      : {}),
  };
}
