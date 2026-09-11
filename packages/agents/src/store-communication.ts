import type {
  CommunicationDocumentRecord,
  CommunicationDocumentReference,
  CommunicationEvent,
  CommunicationProjection,
} from "@ponderosa/core";
import { messageId as projectedMessageId } from "./ids.js";
import type { StoredLogEvent } from "./log-event.js";

function communicationDocumentReference(projectId: string, document: CommunicationDocumentRecord): CommunicationDocumentReference {
  const root = `/api/projects/${encodeURIComponent(projectId)}/communication-documents/${encodeURIComponent(document.id)}`;
  return { ...document, previewUrl: root, downloadUrl: `${root}/download` };
}

function revisedRenderedText(rendered: string, original: string, replacement: string): string {
  if (rendered === original) return replacement;
  if (original && rendered.endsWith(original)) return `${rendered.slice(0, -original.length)}${replacement}`.trimEnd();
  return replacement;
}

function communicationMessageProjection(agentId: string, stored: StoredLogEvent): CommunicationProjection["message"] | undefined {
  const event = stored.event;
  if (event.type === "user_message") return {
    messageId: projectedMessageId(agentId, stored.seq), role: "user", renderedText: event.text, createdAt: stored.ts, sequence: stored.seq,
    ...(event.attachments?.length ? { attachmentIds: event.attachments.map((item) => item.id) } : {}),
    ...(event.attachments?.length ? { attachments: event.attachments } : {}),
  };
  if (event.type === "communication_projection") return {
    messageId: projectedMessageId(agentId, stored.seq), role: event.role ?? "assistant", renderedText: event.text, createdAt: stored.ts, sequence: stored.seq,
    ...(event.attachments?.length ? { attachmentIds: event.attachments.map((item) => item.id), attachments: event.attachments } : {}),
  };
  return undefined;
}

function userDmAgentIds(event: CommunicationEvent): string[] {
  if (event.intent !== "user_dm" || event.audience.kind === "user") return [];
  return event.audience.kind === "user_agent" ? [event.audience.agentId] : event.audience.agentIds;
}

function normalizedAgentIds(ids: readonly string[]): [string, ...string[]] {
  const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
  if (normalized.length === 0) throw new Error("collaboration requires at least one recipient agent ID");
  return normalized as [string, ...string[]];
}

export {
  communicationDocumentReference,
  revisedRenderedText,
  communicationMessageProjection,
  userDmAgentIds,
  normalizedAgentIds,
};
