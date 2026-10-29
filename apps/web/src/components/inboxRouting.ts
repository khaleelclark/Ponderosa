import type {
  AgentDto,
  AgentHealthDto,
  InboxSourceDto,
} from "@ponderosa/core";

export const INBOX_REPLY_TARGET_KEY = "messages:composer:reply-target";
export const INBOX_SOURCE_KEY = "messages:composer:source";

export type InboxReplyTarget = {
  id: string;
  title: string;
  handle: string;
  projectId: string;
  conversationId?: string;
};

export type InboxSourceIdentity = {
  projectId: string;
  conversationId: string;
};

export type InboxRuntimePayload = {
  activeRunDelivery?: "steer" | "queue";
  engine?: string;
  model?: string;
  effort?: string;
  speed?: string;
};

export type InboxSubmissionIntentState = {
  epoch: number;
  sourceKey?: string;
};

export type InboxSubmissionIntentEvent =
  | { kind: "source-selected"; sourceKey: string }
  | { kind: "recipient-selected" | "recipient-cleared" | "draft-mutated" }
  | { kind: "recipient-projection-missing" };

export function inboxDeliveryConfirmation(input: {
  recipientTitles: string[];
  queuedRecipientTitles: string[];
  unavailableCount: number;
  creationRecovering: boolean;
}): string | undefined {
  if (input.creationRecovering) {
    return "Agent creation is committed and recovery is finishing. It will appear when ready.";
  }
  const unavailable = input.unavailableCount
    ? ` ${input.unavailableCount} unavailable recipient${
      input.unavailableCount === 1 ? " was" : "s were"
    } skipped.`
    : "";
  // HTTP intake is not provider delivery. The canonical per-recipient receipt
  // supplies the eventual delivered/queued label; do not pre-announce success.
  return unavailable.trim() || undefined;
}

export function inboxSourceIntentKey(
  projectId: string,
  source: InboxSourceDto,
  agents: Iterable<Pick<AgentDto, "id" | "conversationId">>,
): string {
  const conversationId = inboxSourceConversationId(source, agents);
  return JSON.stringify([
    projectId,
    conversationId ?? (source.kind === "agent" ? `legacy-agent:${source.agentId}` : "unknown"),
  ]);
}

/** Explicit routing changes advance the retry boundary. Projection loss does not. */
export function reduceInboxSubmissionIntent(
  state: InboxSubmissionIntentState,
  event: InboxSubmissionIntentEvent,
): InboxSubmissionIntentState {
  if (event.kind === "recipient-projection-missing") return state;
  if (event.kind === "source-selected") {
    return event.sourceKey === state.sourceKey
      ? state
      : { epoch: state.epoch + 1, sourceKey: event.sourceKey };
  }
  return { ...state, epoch: state.epoch + 1 };
}

/** Exact runtime scalars that can be emitted by the selected All Messages action. */
export function inboxRuntimePayloadSnapshot(input: {
  newAgentRequested: boolean;
  recipientCount: number;
  selectedEngineId?: string;
  defaultEngine?: string;
  runtime: { model: string; effort: string; speed: string };
}): InboxRuntimePayload {
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

export function parseInboxSourceIdentity(
  raw: string | undefined,
): InboxSourceIdentity | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<InboxSourceIdentity>;
    return typeof value.projectId === "string" && value.projectId &&
        typeof value.conversationId === "string" && value.conversationId
      ? value as InboxSourceIdentity
      : undefined;
  } catch {
    return undefined;
  }
}

export function eligibleInboxTargets(
  targets: Iterable<InboxReplyTarget>,
  conversationId?: string,
): InboxReplyTarget[] {
  return [...targets].filter(
    target => !conversationId || target.conversationId === conversationId,
  );
}

export function busyInboxMentionHandles(
  targets: Iterable<Pick<InboxReplyTarget, "id" | "handle">>,
  health: Iterable<Pick<AgentHealthDto, "agentId" | "runtimeActivity">>,
): string[] {
  const activeAgentIds = new Set([...health].flatMap(item =>
    item.runtimeActivity ? [item.agentId] : []
  ));
  return [...targets].flatMap(target =>
    activeAgentIds.has(target.id) ? [target.handle] : []
  );
}

export function authoritativeInboxReplyTarget<T extends InboxReplyTarget>(
  target: T | undefined,
  projectId: string | undefined,
  conversationId: string | undefined,
): T | undefined {
  if (!target) return undefined;
  if (projectId && target.projectId !== projectId) return undefined;
  if (conversationId && target.conversationId !== conversationId) return undefined;
  return target;
}

export function inboxSourceConversationId(
  source: InboxSourceDto | undefined,
  agents: Iterable<Pick<AgentDto, "id" | "conversationId">>,
): string | undefined {
  if (!source) return undefined;
  if (source.kind !== "agent") return source.conversationId;
  if (source.conversationId) return source.conversationId;
  return [...agents].find(agent => agent.id === source.agentId)?.conversationId;
}

export function inboxRuntimeSelectionReady(
  selectedAgentId: string | undefined,
  initializedAgentId: string | undefined,
): boolean {
  return Boolean(selectedAgentId && selectedAgentId === initializedAgentId);
}

export function inboxSourceIdentity(
  projectId: string,
  source: InboxSourceDto | undefined,
  agents: Iterable<Pick<AgentDto, "id" | "conversationId">>,
): InboxSourceIdentity | undefined {
  const conversationId = inboxSourceConversationId(source, agents);
  return conversationId ? { projectId, conversationId } : undefined;
}

export function inboxComposerConversationId(
  selectedConversationId: string | undefined,
  replyConversationId: string | undefined,
  source: InboxSourceIdentity | undefined,
): string | undefined {
  return selectedConversationId ?? replyConversationId ?? source?.conversationId;
}
