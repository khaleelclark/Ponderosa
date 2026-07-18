import type { CreateProjectRequest, ProjectDto } from "@ponderosa/core";

export type ProjectFolderMode = "none" | "existing" | "create";

export function projectCreationDisabled(input: {
  label: string;
  mode: ProjectFolderMode;
  existingPath: string;
  newFolderName: string;
  pending: boolean;
  defaultEngine: string;
}): boolean {
  return input.pending || !input.label.trim() || !input.defaultEngine ||
    (input.mode === "existing" && !input.existingPath.trim()) ||
    (input.mode === "create" && !input.newFolderName.trim());
}

export function createProjectRequest(input: {
  label: string;
  mode: ProjectFolderMode;
  existingPath: string;
  newFolderName: string;
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
      : input.mode === "create"
        ? { createFolderName: input.newFolderName.trim() }
        : {}),
  };
}

export function nextProjectAfterDelete(projects: readonly ProjectDto[], deletedId: string): ProjectDto | undefined {
  return projects.find((project) => project.id !== deletedId);
}
