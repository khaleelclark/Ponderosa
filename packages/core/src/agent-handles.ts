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
  reservedHandles: Iterable<string>,
): string {
  const occupied = new Set(
    [...reservedHandles].map(handle => handle.toLocaleLowerCase()),
  );
  for (const reserved of RESERVED_AGENT_MENTION_HANDLES) occupied.add(reserved);
  const base = agentMentionHandleBase(displayName);
  if (!occupied.has(base.toLocaleLowerCase())) return base;
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!occupied.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error("Agent mention handle space is exhausted");
}
