import type { CommunicationEvent } from "@ponderosa/core";
import type { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { canonicalDefaultReplyRoute } from "./required-reply-route.js";

/** Read eligibility from this Run's canonical intake, never caller flags or
 * provider history. Advisory prompt selection and the tool route share it;
 * capability, lease/fence, steering and receipt checks remain in the route. */
export function canonicalVoiceReplyInput(
  store: AgentStore,
  coordination: CoordinationV3Store,
  scope: { runId: string; agentId: string; conversationId?: string },
): { input: CommunicationEvent; activationId: string } | undefined {
  const { runId, agentId, conversationId } = scope;
  if (!conversationId || coordination.requestIdsAttachedToRun(runId, agentId).length ||
      canonicalDefaultReplyRoute(coordination, runId, agentId)?.intent !== "direct_to_user" ||
      coordination.requiredReplyObligationsForRun(runId).some(o => o.state === "satisfied")) return undefined;
  const ids = coordination.activationIdsAttachedToRun(runId, agentId);
  if (ids.length !== 1) return undefined;
  const activations = coordination.activationPayloads(agentId, ids, runId);
  if (activations.length !== 1 || activations[0]!.kind !== "human_message" ||
      activations[0]!.promptClass !== "human") return undefined;
  const payload = activations[0]!.payload as {
    communication?: Partial<CommunicationEvent>; dispatch?: { voiceReply?: unknown };
  } | undefined;
  const eventId = payload?.communication?.eventId;
  if (typeof eventId !== "string" || payload?.dispatch?.voiceReply !== true) return undefined;
  const canonical = coordination.runtimeCommunication(eventId);
  if (!canonical?.activations?.some(a => a.id === ids[0] && a.agentId === agentId)) return undefined;
  const accepted = canonical.payload as {
    communication?: CommunicationEvent;
    dispatch?: { voiceReply?: unknown; activeRunDelivery?: unknown; conversationId?: unknown; recipients?: Array<{ agentId?: unknown }> };
  } | undefined;
  const input = accepted?.communication;
  const dispatch = accepted?.dispatch;
  const agent = store.getAgent(agentId);
  const chat = store.getConversation(conversationId);
  if (!input || input.eventId !== eventId || input.intent !== "user_dm" || input.sender?.kind !== "user" ||
      input.sender.userId !== "local-operator" || input.audience?.kind !== "user_agents" ||
      input.audience.userId !== input.sender.userId || !Array.isArray(input.audience.agentIds) ||
      input.audience.agentIds.length !== 1 || input.audience.agentIds[0] !== agentId ||
      input.conversationId !== conversationId || input.document !== undefined ||
      dispatch?.voiceReply !== true || dispatch.activeRunDelivery !== "queue" || dispatch.conversationId !== conversationId ||
      !Array.isArray(dispatch.recipients) || dispatch.recipients.length !== 1 || dispatch.recipients[0]?.agentId !== agentId ||
      !agent || agent.archived || !chat || chat.archived || agent.projectId !== input.projectId ||
      chat.projectId !== input.projectId || canonical.projectId !== input.projectId || agent.conversationId !== chat.id ||
      coordination.voiceReplyRunTiming(eventId, agentId)?.runId !== runId) return undefined;
  return { input, activationId: ids[0]! };
}
