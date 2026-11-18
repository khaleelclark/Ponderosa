import { parseNativeTurnCommand, type CommunicationEvent, type NativeTurnAction } from "@ponderosa/core";

/** Inputs are current leased source IDs, never rendered context or history. */
export function selectNativeCommand(input: {
  projectId: string;
  agentId: string;
  conversationId: string;
  communicationIds: string[];
  read(id: string): CommunicationEvent | undefined;
  documentText(event: CommunicationEvent): string | undefined;
}): NativeTurnAction | undefined {
  let selected: NativeTurnAction | undefined;
  for (const id of new Set(input.communicationIds)) {
    const event = input.read(id);
    if (!event || event.eventId !== id) throw new Error("Canonical communication source is unavailable");
    if (event.projectId !== input.projectId || event.sender.kind !== "user") continue;
    const addressed = event.intent === "broadcast"
      ? event.conversationId === input.conversationId
      : event.intent === "user_dm" && (event.audience.kind === "user_agent"
        ? event.audience.agentId === input.agentId
        : event.audience.kind === "user_agents" && event.audience.agentIds.includes(input.agentId));
    if (!addressed) continue;
    const text = event.document ? input.documentText(event) : event.text;
    if (text === undefined) throw new Error("Canonical human command document is unavailable");
    const action = parseNativeTurnCommand(text);
    if (!action) continue;
    // One native operation per provider turn; never silently choose the first.
    if (selected) throw new Error("Multiple native actions share this Run; submit each command separately");
    selected = action;
  }
  return selected;
}
