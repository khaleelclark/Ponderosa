import type { ThreadDto } from "@ponderosa/core";

export function activeCollaborationRecipients(threads: ThreadDto[]): ThreadDto[] {
  return threads.filter((thread) => !thread.archived);
}

export function retainActiveRecipientIds(selectedIds: Iterable<string>, threads: ThreadDto[]): string[] {
  const activeIds = new Set(activeCollaborationRecipients(threads).map((thread) => thread.id));
  return [...new Set(selectedIds)].filter((id) => activeIds.has(id));
}

/** Resolve the #everyone UX into the same immutable stable-ID payload as manual selection. */
export function allActiveRecipientIds(threads: ThreadDto[]): string[] {
  return activeCollaborationRecipients(threads).map((thread) => thread.id);
}
