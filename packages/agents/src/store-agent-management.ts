import type { AgentDeletionPreviewDto, AgentDto } from "@ponderosa/core";

export class AgentDeletionConflictError extends Error {
  constructor(readonly currentPreview: AgentDeletionPreviewDto) {
    super("Agent organization changed after deletion preview");
    this.name = "AgentDeletionConflictError";
  }
}

function requireManagementPermissions(value: unknown): AgentDto["managementPermissions"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("management permissions must be an object");
  const permissions = value as Record<string, unknown>;
  if (typeof permissions.allowAutomaticDescendantDeletion !== "boolean" ||
      typeof permissions.allowAutomaticDescendantReorganization !== "boolean") {
    throw new Error("management permissions must contain exact boolean values");
  }
  return {
    allowAutomaticDescendantDeletion: permissions.allowAutomaticDescendantDeletion,
    allowAutomaticDescendantReorganization: permissions.allowAutomaticDescendantReorganization,
  };
}

export { requireManagementPermissions };
