export type ProviderUsageCollectionPresentation =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "ready"; warning?: string };

export function providerUsageCollectionPresentation(
  providerCount: number,
  pending: boolean,
  error?: unknown,
): ProviderUsageCollectionPresentation {
  const message = error instanceof Error && error.message.trim()
    ? error.message
    : error
      ? "Provider usage could not be loaded."
      : undefined;
  if (providerCount > 0) {
    return { kind: "ready", ...(message ? { warning: message } : {}) };
  }
  if (pending) return { kind: "loading" };
  if (message) return { kind: "error", message };
  return { kind: "empty" };
}
