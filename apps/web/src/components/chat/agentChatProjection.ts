import type { AgentRunDto, MessageDto } from "@ponderosa/core";

/**
 * The server has already projected these messages onto this exact Agent's
 * direct_agent_audit surface. Keeping that projection intact preserves legacy
 * entries whose canonical intent is unavailable, the Agent's own Broadcasts,
 * and every explicit inbound or outbound Communication without copying an
 * ambient Project or Team room into Agent Chat.
 *
 * Runs are likewise Agent-scoped. Agent Chat is the consolidated audit surface
 * for everything this Agent did, including Project requests and Automations.
 */
export function projectAgentChat(
  messages: MessageDto[],
  runs: AgentRunDto[],
): { messages: MessageDto[]; runs: AgentRunDto[] } {
  return { messages, runs };
}
