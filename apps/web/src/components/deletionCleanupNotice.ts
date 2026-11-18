/** A removed owner and completed physical cleanup are distinct outcomes. */
export function deletionCleanupNotice(kind: "Chat" | "Agent", result: { deleted: boolean; cleanupPending: boolean }): string | undefined {
  if (!result.deleted) return `${kind} deletion is still pending. Saved data may remain.`;
  if (result.cleanupPending) return `${kind} removed, but cleanup is still pending. Saved data, including memory, may remain.`;
}
