import type { AgentDto, AllChatSourceDto } from "@ponderosa/core";

export const ALL_CHAT_REPLY_TARGET_KEY = "messages:composer:reply-target";
export const ALL_CHAT_SOURCE_KEY = "messages:composer:source";

export type AllChatReplyTarget = {
  id: string;
  title: string;
  handle: string;
  projectId: string;
  conversationId?: string;
};

export type AllChatSourceIdentity = {
  projectId: string;
  conversationId: string;
};

export type AllChatRuntimePayload = {
  engine?: string;
  model?: string;
  effort?: string;
  speed?: string;
};

export type AllChatSubmissionIntentState = {
  epoch: number;
  sourceKey?: string;
};

export type AllChatSubmissionIntentEvent =
  | { kind: "source-selected"; sourceKey: string }
  | { kind: "recipient-selected" | "recipient-cleared" | "draft-mutated" }
  | { kind: "recipient-projection-missing" };

export function allChatSourceIntentKey(
  projectId: string,
  source: AllChatSourceDto,
  agents: Iterable<Pick<AgentDto, "id" | "conversationId">>,
): string {
  const conversationId = allChatSourceConversationId(source, agents);
  return JSON.stringify([
    projectId,
    conversationId ?? (source.kind === "agent" ? `legacy-agent:${source.agentId}` : "unknown"),
  ]);
}

/** Explicit routing changes advance the retry boundary. Projection loss does not. */
export function reduceAllChatSubmissionIntent(
  state: AllChatSubmissionIntentState,
  event: AllChatSubmissionIntentEvent,
): AllChatSubmissionIntentState {
  if (event.kind === "recipient-projection-missing") return state;
  if (event.kind === "source-selected") {
    return event.sourceKey === state.sourceKey
      ? state
      : { epoch: state.epoch + 1, sourceKey: event.sourceKey };
  }
  return { ...state, epoch: state.epoch + 1 };
}

export function allChatSubmissionSettlementStillCurrent(input: {
  capturedEpoch: number;
  currentEpoch: number;
  capturedSourceKey?: string;
  currentSourceKey?: string;
  capturedTargetId?: string;
  currentTargetId?: string;
}): boolean {
  return input.capturedEpoch === input.currentEpoch &&
    input.capturedSourceKey === input.currentSourceKey &&
    input.capturedTargetId === input.currentTargetId;
}

/** Exact runtime scalars that can be emitted by the selected All Messages action. */
export function allChatRuntimePayloadSnapshot(input: {
  newAgentRequested: boolean;
  recipientCount: number;
  selectedEngineId?: string;
  defaultEngine?: string;
  runtime: { model: string; effort: string; speed: string };
}): AllChatRuntimePayload {
  const singleRecipient = input.recipientCount === 1;
  return {
    ...(input.newAgentRequested ? {
      engine: input.selectedEngineId ?? input.defaultEngine ?? "codex",
    } : {}),
    ...((input.newAgentRequested || singleRecipient) && input.runtime.model
      ? { model: input.runtime.model }
      : {}),
    ...((input.newAgentRequested || singleRecipient) && input.runtime.effort
      ? { effort: input.runtime.effort }
      : {}),
    ...(singleRecipient && input.runtime.speed
      ? { speed: input.runtime.speed }
      : {}),
  };
}

export function parseAllChatSourceIdentity(
  raw: string | undefined,
): AllChatSourceIdentity | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<AllChatSourceIdentity>;
    return typeof value.projectId === "string" && value.projectId &&
        typeof value.conversationId === "string" && value.conversationId
      ? value as AllChatSourceIdentity
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseAllChatReplyTarget(
  raw: string | undefined,
): AllChatReplyTarget | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<AllChatReplyTarget>;
    if (
      typeof value.id !== "string" || !value.id ||
      typeof value.title !== "string" || !value.title ||
      typeof value.handle !== "string" || !value.handle ||
      typeof value.projectId !== "string" || !value.projectId ||
      (value.conversationId !== undefined &&
        (typeof value.conversationId !== "string" || !value.conversationId))
    ) return undefined;
    return value as AllChatReplyTarget;
  } catch {
    return undefined;
  }
}

export function eligibleAllChatTargets(
  targets: Iterable<AllChatReplyTarget>,
  conversationId?: string,
): AllChatReplyTarget[] {
  return [...targets].filter(
    target => !conversationId || target.conversationId === conversationId,
  );
}

export function authoritativeAllChatReplyTarget<T extends AllChatReplyTarget>(
  target: T | undefined,
  projectId: string | undefined,
  conversationId: string | undefined,
): T | undefined {
  if (!target) return undefined;
  if (projectId && target.projectId !== projectId) return undefined;
  if (conversationId && target.conversationId !== conversationId) return undefined;
  return target;
}

export function allChatSourceConversationId(
  source: AllChatSourceDto | undefined,
  agents: Iterable<Pick<AgentDto, "id" | "conversationId">>,
): string | undefined {
  if (!source) return undefined;
  if (source.kind !== "agent") return source.conversationId;
  if (source.conversationId) return source.conversationId;
  return [...agents].find(agent => agent.id === source.agentId)?.conversationId;
}

export function allChatRuntimeSelectionReady(
  selectedAgentId: string | undefined,
  initializedAgentId: string | undefined,
): boolean {
  return Boolean(selectedAgentId && selectedAgentId === initializedAgentId);
}

export function allChatSourceIdentity(
  projectId: string,
  source: AllChatSourceDto | undefined,
  agents: Iterable<Pick<AgentDto, "id" | "conversationId">>,
): AllChatSourceIdentity | undefined {
  const conversationId = allChatSourceConversationId(source, agents);
  return conversationId ? { projectId, conversationId } : undefined;
}

export function allChatComposerConversationId(
  selectedConversationId: string | undefined,
  replyConversationId: string | undefined,
  source: AllChatSourceIdentity | undefined,
): string | undefined {
  return selectedConversationId ?? replyConversationId ?? source?.conversationId;
}
