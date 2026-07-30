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
  AUTO_ALLOWED_DECISION_OPTION_ID,
  conversationComposerRuntime,
  decisionChoice,
  mergeConversationMessages,
  mergeDecisionEvents,
  mergeOperationalEvents,
};
export type { MainTimelineEntry };
