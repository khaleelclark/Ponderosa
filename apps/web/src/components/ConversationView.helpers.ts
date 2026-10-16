import type {
  EngineCommand,
  EngineDto,
  ConversationMessageDto,
  ProjectEngineCapabilitiesDto,
  TeamOperationalEventDto,
  ConversationDecisionEventDto,
  QueuedConversationMessageDto,
} from "@ponderosa/core";
import { uniqueBy } from "../collections";
import { engineIsAvailable } from "../conversationEngine";

/** Reserved response identity for a server-applied provider permission. */
const AUTO_ALLOWED_DECISION_OPTION_ID = "auto_allowed";

function mergeConversationMessages(
  ...groups: ConversationMessageDto[][]
): ConversationMessageDto[] {
  return uniqueBy(
    groups.flat(),
    message => message.id,
    (a, b) =>
      (a.canonicalOrderKey ?? a.createdAt).localeCompare(
        b.canonicalOrderKey ?? b.createdAt,
      ) || a.id.localeCompare(b.id),
  );
}

type MainTimelineEntry =
  | { kind: "message"; id: string; at: string; message: ConversationMessageDto }
  | { kind: "decision"; id: string; at: string; event: ConversationDecisionEventDto }
  | { kind: "decision-response"; id: string; at: string; event: ConversationDecisionEventDto; choice: string };

/** Only the operator's messages belong in the editable queue. Exact receipts
 * cover the interval before its query arrives; never invent their position. */
export function reconcileQueuedMessages(
  canonicalMessages: Array<Pick<ConversationMessageDto, "id" | "communicationEventId" | "communicationSender" | "text" | "createdAt" | "deliveryReceipts"> & { conversationId?: string }>,
  queuedMessages: QueuedConversationMessageDto[],
): QueuedConversationMessageDto[] {
  const canonicalByIdentity = new Map(canonicalMessages.flatMap(message => [
    [message.id, message] as const,
    ...(message.communicationEventId ? [[message.communicationEventId, message] as const] : []),
  ]));
  const current = queuedMessages.filter(queued => {
    const message = canonicalByIdentity.get(queued.messageId);
    // The queue API already checks ownership. Keep its rows if the timeline
    // has not arrived, but never override known canonical sender metadata.
    if (message?.communicationSender && !(message.communicationSender.kind === "user" &&
        message.communicationSender.userId === "local-operator")) return false;
    const receipt = message?.deliveryReceipts?.find(value => value.activationId === queued.deliveryId);
    return !receipt || receipt.queuedForNextRun || receipt.state === "queued";
  });
  const ids = new Set(current.map(message => message.deliveryId));
  return [...current, ...canonicalMessages.flatMap(message =>
    (message.communicationSender?.kind === "user" && message.communicationSender.userId === "local-operator"
      ? message.deliveryReceipts ?? [] : []).filter(receipt => {
      if (!receipt.queuedForNextRun || ids.has(receipt.activationId)) return false;
      ids.add(receipt.activationId);
      return true;
    })
      .map(receipt => ({
        deliveryId: receipt.activationId,
        messageId: message.communicationEventId ?? message.id,
        conversationId: message.conversationId ?? "",
        targetAgentId: receipt.targetAgentId,
        text: message.text,
        createdAt: message.createdAt,
        status: "queued" as const,
      })))];
}

function reconcileQueuedProjectMessages(
  timeline: MainTimelineEntry[],
  queuedMessages: QueuedConversationMessageDto[],
): {
  queuedMessages: QueuedConversationMessageDto[];
  timeline: MainTimelineEntry[];
} {
  const canonicalMessages = timeline.flatMap(entry =>
    entry.kind === "message" ? [entry.message] : [],
  );
  const currentQueuedMessages = reconcileQueuedMessages(canonicalMessages, queuedMessages);
  const queuedMessageIds = new Set(
    currentQueuedMessages.map(message => message.messageId),
  );
  return {
    queuedMessages: currentQueuedMessages,
    timeline: timeline.filter(
      entry =>
        entry.kind !== "message" ||
        (!queuedMessageIds.has(entry.message.id) &&
          !(
            entry.message.communicationEventId &&
            queuedMessageIds.has(entry.message.communicationEventId)
          )),
    ),
  };
}

function decisionChoice(decision: ConversationDecisionEventDto["decision"]): string | undefined {
  if (
    decision.response?.optionId === AUTO_ALLOWED_DECISION_OPTION_ID
  ) {
    return decision.response.text;
  }
  return decision.response?.optionId
    ? decision.options.find((option) => option.id === decision.response?.optionId)?.label
    : decision.response?.text;
}

function mergeDecisionEvents(
  ...groups: ConversationDecisionEventDto[][]
): ConversationDecisionEventDto[] {
  return uniqueBy(
    groups.flat(),
    event => event.id,
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

function mergeOperationalEvents(
  ...groups: TeamOperationalEventDto[][]
): TeamOperationalEventDto[] {
  return uniqueBy(
    groups.flat(),
    event => event.id,
    (a, b) =>
      a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id),
  );
}

function conversationComposerRuntime(
  engine:
    | (Pick<EngineDto, "id" | "authentication" | "intakeReady"> & {
        enabled?: boolean;
      })
    | undefined,
  engineCapabilities: ProjectEngineCapabilitiesDto[],
): {
  commands: EngineCommand[];
  capabilities: ProjectEngineCapabilitiesDto["composerCapabilities"];
} {
  const discovered = engineCapabilities.find(
    item => item.engineId === engine?.id,
  );
  return {
    commands: discovered?.commands ?? [],
    capabilities: engineIsAvailable(engine)
      ? (discovered?.composerCapabilities ?? [])
      : [],
  };
}

export {
  AUTO_ALLOWED_DECISION_OPTION_ID,
  conversationComposerRuntime,
  decisionChoice,
  mergeConversationMessages,
  mergeDecisionEvents,
  mergeOperationalEvents,
  reconcileQueuedProjectMessages,
};
export type { MainTimelineEntry };
