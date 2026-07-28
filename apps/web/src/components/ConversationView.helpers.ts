import type {
  EngineCommand,
  EngineDto,
  ConversationMessageDto,
  ProjectEngineCapabilitiesDto,
  TeamOperationalEventDto,
  ConversationDecisionEventDto,
} from "@ponderosa/core";
import { uniqueBy } from "../collections";
import { engineIsAvailable } from "../conversationEngine";

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

function decisionChoice(decision: ConversationDecisionEventDto["decision"]): string | undefined {
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

interface OperationalEventGroup {
  id: string;
  representative: TeamOperationalEventDto;
  events: TeamOperationalEventDto[];
}

/**
 * Team Chat is an audit projection, so only collapse consecutive rows that
 * are indistinguishable to the reader. The source events stay available in a
 * disclosure and are never removed from the canonical response.
 */
function groupAdjacentOperationalEvents(
  events: TeamOperationalEventDto[],
): OperationalEventGroup[] {
  const groups: OperationalEventGroup[] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    const sameAsPrevious = previous &&
      event.kind !== "request" &&
      previous.representative.kind === event.kind &&
      previous.representative.state === event.state &&
      previous.representative.text === event.text &&
      previous.representative.agentIds.join("\u0000") === event.agentIds.join("\u0000");
    if (sameAsPrevious) {
      previous.events.push(event);
      continue;
    }
    groups.push({ id: event.id, representative: event, events: [event] });
  }
  return groups;
}

function conversationComposerRuntime(
  engine:
    | (Pick<EngineDto, "id" | "authenticated" | "available"> & {
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
  conversationComposerRuntime,
  decisionChoice,
  groupAdjacentOperationalEvents,
  mergeConversationMessages,
  mergeDecisionEvents,
  mergeOperationalEvents,
};
export type { MainTimelineEntry, OperationalEventGroup };
