import {
  type AgentStreamEvent,
  type SseEventEnvelope,
} from "@ponderosa/core";
import type { StoredLogEvent } from "@ponderosa/agents";

function isAgentStreamEvent(event: StoredLogEvent["event"]): event is AgentStreamEvent {
  return event.type !== "user_message";
}

function envelope(agentId: string, stored: StoredLogEvent, replayed = false): SseEventEnvelope | undefined {
  if (!isAgentStreamEvent(stored.event)) return undefined;
  return { agentId, seq: stored.seq, ts: stored.ts, event: stored.event, ...(replayed ? { replayed: true } : {}) };
}

function writeSse(res: NodeJS.WritableStream, name: string, id: number | undefined, data: unknown): boolean {
  return res.write(
    `${id === undefined ? "" : `id: ${id}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

export {
  isAgentStreamEvent,
  envelope,
  writeSse,
};
