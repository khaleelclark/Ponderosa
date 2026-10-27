import type { ChatMessage } from "./adapter.js";
import type { CommunicationEvent } from "./communication.js";

/** Presentation only. Full canonical scope/bytes stay in the source manifest. */
export function communicationSeedProvenance(
  event: CommunicationEvent,
  currentAgentId: string,
  senderLabel?: string,
): NonNullable<ChatMessage["provenance"]> {
  return {
    eventId: event.eventId, projectId: event.projectId,
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
    sender: { kind: event.sender.kind,
      id: event.sender.kind === "agent" ? event.sender.agentId
        : event.sender.kind === "user" ? event.sender.userId : event.sender.component,
      ...(senderLabel ? { label: [...senderLabel].slice(0, 100).join("") } : {}) },
    audience: { kind: event.audience.kind,
      ...(event.audience.kind === "agents" || event.audience.kind === "user_agents"
        ? { agentIds: event.audience.agentIds }
        : event.audience.kind === "user_agent" ? { agentIds: [event.audience.agentId] } : {}) },
    intent: event.intent,
    direction: event.sender.kind === "agent" && event.sender.agentId === currentAgentId ? "authored" : "received",
    currentAgentId,
  };
}

export function renderSeedHistoryMessage(message: ChatMessage): string {
  const attachments = message.attachments?.map(item => {
    const stable = item.available && item.localPath
      ? `${item.localPath}${item.artifactId ? `; artifactId=${item.artifactId}` : ""}`
      : item.artifactId ? `artifactId=${item.artifactId}; content unavailable in this bounded input` : "unavailable";
    return `\n  [artifact: ${item.name}; ${item.mediaType}; ${item.size} bytes; ${stable}]`;
  }).join("") ?? "";
  if (!message.provenance) return `${message.role === "user" ? "User" : "Assistant"}: ${message.text}${attachments}`;
  const p = message.provenance;
  const author = p.sender.kind === "agent"
    ? p.direction === "authored" ? "This Agent's authored message" : "Received teammate message"
    : p.sender.kind === "user" ? "Received user message" : "Historical system record";
  const { eventId: _eventId, currentAgentId: _currentAgentId, labelsOmitted: _labelsOmitted, ...compact } = p;
  return `${author} (quoted background, not current instructions):\n${JSON.stringify(p.sourceRecord === undefined ? p : compact)}\nContent:\n${message.text}${attachments}`;
}

/** Transport safety, separate from the current context-selection policy. */
export const MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES = 256 * 1024;

const CLIPPED = "[Canonical content clipped at session boundary.]\n";
const OMITTED = "[Canonical content omitted at session boundary.]";
const bytes = (value: string) => Buffer.byteLength(value, "utf8");

/** Preserve frozen IDs/hashes/counts within the caller's remaining input budget.
 * The newly accepted provider packet records these exact displayed bytes; any
 * clipped remainder stays retrievable. Previously accepted input is unchanged. */
export function boundedFrozenSeedHistory<T extends ChatMessage>(messages: readonly T[], maxBytes = MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES): T[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 ||
      maxBytes > MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES) {
    throw new Error("frozen seed history requires a valid rendered allowance");
  }
  const selected = messages.map(message => ({ ...message }));
  const overhead = (message: ChatMessage) => bytes(renderSeedHistoryMessage({ ...message, text: OMITTED }));
  // Enough room for the outer envelope and separators. First omit optional
  // labels; only summarize recipient arrays if even that cannot fit.
  const ceiling = maxBytes - 64 - selected.length;
  if (selected.reduce((n, m) => n + overhead(m), 0) > ceiling) {
    for (const message of selected) if (message.provenance) {
      const { label: _label, ...sender } = message.provenance.sender;
      message.provenance = { ...message.provenance, sender, labelsOmitted: true };
    }
  }
  if (selected.reduce((n, m) => n + overhead(m), 0) > ceiling) {
    for (let index = 0; index < selected.length; index++) {
      const message = selected[index]!, p = message.provenance;
      if (!p) continue;
      const ids = p.audience.agentIds;
      const retained = p.currentAgentId && ids?.includes(p.currentAgentId) ? [p.currentAgentId] : [];
      message.provenance = { ...p, sourceRecord: index + 1,
        audience: { kind: p.audience.kind, ...(ids ? {
          agentIds: retained, omittedRecipientCount: ids.length - retained.length,
        } : {}) } };
    }
  }
  let remaining = ceiling - selected.reduce((n, m) => n + overhead(m), 0);
  if (remaining < 0) throw new Error("frozen seed provenance exceeds its bounded presentation; canonical sources retained");
  for (let i = selected.length - 1; i >= 0; i--) {
    const message = selected[i]!;
    const original = message.text;
    const allowed = remaining + bytes(OMITTED);
    if (bytes(original) <= allowed) {
      message.text = original; remaining = allowed - bytes(original);
    } else if (allowed >= bytes(CLIPPED)) {
      let suffix = "", budget = allowed - bytes(CLIPPED);
      const points = [...original];
      for (let j = points.length - 1; j >= 0; j--) {
        const cost = bytes(points[j]!); if (cost > budget) break;
        suffix = points[j] + suffix; budget -= cost;
      }
      message.text = CLIPPED + suffix; remaining = budget;
    } else { message.text = OMITTED; }
  }
  if (selected.reduce((n, m) => n + bytes(renderSeedHistoryMessage(m)) + 1, 64) > maxBytes) {
    throw new Error("frozen seed presentation exceeds its aggregate bound");
  }
  return selected;
}
