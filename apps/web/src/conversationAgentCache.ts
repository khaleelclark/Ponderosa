import type { AgentDto } from "@ponderosa/core";

/** Conversation detail shares a key prefix with receipt queries; ignore other shapes. */
export function replaceCachedConversationAgent(
  current: unknown,
  updated: AgentDto,
): unknown {
  if (!current || typeof current !== "object" || !("agents" in current) ||
      !Array.isArray(current.agents)) return current;
  return {
    ...current,
    agents: current.agents.map(agent =>
      agent && typeof agent === "object" && "id" in agent && agent.id === updated.id
        ? updated
        : agent),
  };
}
