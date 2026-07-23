import type { AgentDto, ProjectDto } from "@ponderosa/core";
import type { Route } from "./routing";

export interface TriggerAgentDestination {
  project: ProjectDto;
  agent: AgentDto;
}

/** Build the global picker without inventing a Project or Agent assignment. */
export function triggerAgentDestinations(
  projects: readonly ProjectDto[],
  agentsByProject: readonly (readonly AgentDto[] | undefined)[],
): TriggerAgentDestination[] {
  return projects.flatMap((project, index) =>
    (agentsByProject[index] ?? [])
      .filter((agent) => !agent.archived)
      .map((agent) => ({ project, agent })));
}

/** Resolve only an explicit, chat-assigned Agent selection to Trigger setup. */
export function routeForTriggerAgentSelection(
  agentId: string,
  destinations: readonly TriggerAgentDestination[],
): Route | undefined {
  if (!agentId) return undefined;
  const destination = destinations.find(({ agent }) => agent.id === agentId);
  if (!destination || destination.agent.conversationIds.length === 0) return undefined;
  return {
    kind: "agent",
    projectId: destination.project.id,
    agentId: destination.agent.id,
    view: "triggers",
    createTrigger: true,
  };
}
