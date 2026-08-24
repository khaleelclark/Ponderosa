import type {
  AgentDto,
  AgentWorkingCopyDto,
  ProjectDto,
} from "@ponderosa/core";

export interface ResolvedAgentWorkingCopy {
  id: string;
  mode: AgentWorkingCopyDto["mode"];
  rootPath: string;
  branch?: string;
  baseHead?: string;
}

export class AgentWorkingCopyUnavailableError extends Error {
  readonly code = "agent_working_copy_unavailable";

  constructor(
    readonly workingCopy: AgentWorkingCopyDto,
    message = workingCopy.failure ?? "This Agent's working folder is unavailable.",
  ) {
    super(message);
    this.name = "AgentWorkingCopyUnavailableError";
  }
}

export function sharedWorkingCopy(
  project: Pick<ProjectDto, "id" | "hostPath">,
  updatedAt: string,
): AgentWorkingCopyDto {
  return {
    id: `shared:${project.id}`,
    mode: "shared",
    state: "ready",
    rootPath: project.hostPath,
    updatedAt,
  };
}

/** Resolve durable Agent filesystem authority without consulting provider state.
 * Filesystem retention and Git validation remain server responsibilities. */
export function resolveAgentWorkingCopy(
  agent: Pick<AgentDto, "id" | "projectId" | "workingCopy">,
  project: Pick<ProjectDto, "id" | "hostPath">,
): ResolvedAgentWorkingCopy {
  if (agent.projectId !== project.id) {
    throw new AgentWorkingCopyUnavailableError(
      agent.workingCopy,
      "This Agent's working folder belongs to a different Project.",
    );
  }
  const workingCopy = agent.workingCopy;
  if (workingCopy.state !== "ready") {
    throw new AgentWorkingCopyUnavailableError(workingCopy);
  }
  if (workingCopy.mode === "shared") {
    if (
      workingCopy.id !== `shared:${project.id}` ||
      workingCopy.rootPath !== project.hostPath ||
      workingCopy.branch !== undefined ||
      workingCopy.baseHead !== undefined
    ) {
      throw new AgentWorkingCopyUnavailableError(
        workingCopy,
        "This Agent's Shared folder identity is inconsistent with its Project.",
      );
    }
    return {
      id: workingCopy.id,
      mode: workingCopy.mode,
      rootPath: project.hostPath,
    };
  }
  if (!workingCopy.id.startsWith("copy:") || !workingCopy.rootPath || !workingCopy.branch) {
    throw new AgentWorkingCopyUnavailableError(
      workingCopy,
      "This Agent's Separate Git copy identity is incomplete.",
    );
  }
  return {
    id: workingCopy.id,
    mode: workingCopy.mode,
    rootPath: workingCopy.rootPath,
    branch: workingCopy.branch,
    ...(workingCopy.baseHead ? { baseHead: workingCopy.baseHead } : {}),
  };
}
