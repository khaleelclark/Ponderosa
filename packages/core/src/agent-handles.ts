export const RESERVED_AGENT_MENTION_HANDLES = new Set([
  "broadcast",
  "everyone",
  "new-agent",
  "operator",
  "user",
]);

/** Convert a display name into the readable base used for Agent mentions. */
export function agentMentionHandleBase(displayName: string): string {
  const normalized = displayName
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  return normalized || "Agent";
}

/** Allocate a case-insensitively unique Project-scoped handle. */
export function allocateAgentMentionHandle(
  displayName: string,
  reservedHandles: Iterable<string> | ((normalizedHandle: string) => boolean),
  firstSuffix = 2,
): string {
  const occupied = typeof reservedHandles === "function" ? reservedHandles :
    new Set([...reservedHandles].map(handle => handle.toLocaleLowerCase()));
  const taken = (handle: string) => {
    const normalized = handle.toLocaleLowerCase();
    return RESERVED_AGENT_MENTION_HANDLES.has(normalized) ||
      (typeof occupied === "function" ? occupied(normalized) : occupied.has(normalized));
  };
  const base = agentMentionHandleBase(displayName);
  if (!taken(base)) return base;
  for (let suffix = Math.max(2, firstSuffix); suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error("Agent mention handle space is exhausted");
}
