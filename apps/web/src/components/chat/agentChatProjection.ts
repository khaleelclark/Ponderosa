import type { AgentRunDto, MessageDto } from "@ponderosa/core";

function isDirectMessage(message: MessageDto): boolean {
  return (
    message.communicationIntent === "user_dm" ||
    message.communicationIntent === "direct_to_user"
  );
}

/**
 * Agent Chat is the Agent's addressed work timeline, not a duplicate room.
 * Include direct user communication, Collaboration delivered to this Agent,
 * and the Agent's replies from Runs started by those Collaboration messages.
 */
export function projectAgentChat(
  messages: MessageDto[],
  runs: AgentRunDto[],
): { messages: MessageDto[]; runs: AgentRunDto[] } {
  const agentId = messages[0]?.agentId ?? runs[0]?.agentId;
  const directMessages = messages.filter(isDirectMessage);
  const incomingTeamMessages = agentId
    ? messages.filter(
        message =>
          message.communicationIntent === "collaboration" &&
          message.authorAgentId !== agentId,
      )
    : [];
  const incomingTeamEventIds = new Set(
    incomingTeamMessages.flatMap(message =>
      message.communicationEventId ? [message.communicationEventId] : [],
    ),
  );
  const teamRunIds = new Set(
    runs.flatMap(run =>
      run.communicationEventId &&
      incomingTeamEventIds.has(run.communicationEventId)
        ? [run.id]
        : [],
    ),
  );
  const teamResponses = agentId
    ? messages.filter(
        message =>
          message.communicationIntent === "collaboration" &&
          message.authorAgentId === agentId &&
          Boolean(message.executionId && teamRunIds.has(message.executionId)),
      )
    : [];
  const visibleMessageIds = new Set(
    [...directMessages, ...incomingTeamMessages, ...teamResponses].map(
      message => message.id,
    ),
  );
  const visibleMessages = messages.filter(message =>
    visibleMessageIds.has(message.id),
  );
  const visibleCommunicationIds = new Set(
    visibleMessages.flatMap(message =>
      message.communicationEventId ? [message.communicationEventId] : [],
    ),
  );
  const visibleResponseRunIds = new Set(
    visibleMessages.flatMap(message =>
      message.executionId ? [message.executionId] : [],
    ),
  );
  const visibleRuns = runs.filter(
    run =>
      run.wakeCause === "direct_message" ||
      Boolean(
        run.communicationEventId &&
          visibleCommunicationIds.has(run.communicationEventId),
      ) ||
      visibleResponseRunIds.has(run.id),
  );

  return { messages: visibleMessages, runs: visibleRuns };
}
