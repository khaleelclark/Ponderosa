import type { ThreadDto } from "@ponderosa/core";

/** Stable, typeable handle derived from the agent's current display name. */
export function agentMentionHandle(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

/** Resolve every distinct @mention against the agents currently in a master chat. */
export function findMentionedAgents(text: string, threads: ThreadDto[]): ThreadDto[] {
  const byHandle = new Map(
    threads.map((thread) => [agentMentionHandle(thread.title).toLocaleLowerCase(), thread]),
  );
  const mentioned = new Map<string, ThreadDto>();

  for (const match of text.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)/gu)) {
    const thread = byHandle.get(match[1]!.toLocaleLowerCase());
    if (thread) mentioned.set(thread.id, thread);
  }

  return [...mentioned.values()];
}

export function findMentionedAgent(text: string, threads: ThreadDto[]): ThreadDto | undefined {
  return findMentionedAgents(text, threads)[0];
}
