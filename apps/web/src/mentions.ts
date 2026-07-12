import type { ThreadDto } from "@ponderosa/core";

/** Stable, typeable handle derived from the agent's current display name. */
export function agentMentionHandle(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

/**
 * Return the distinct, canonical handles mentioned in text. Keeping this
 * independent of thread data lets the composer update its local UI without
 * causing the whole master-chat transcript to re-render on every keystroke.
 */
export function findMentionedHandles(text: string, handles: Iterable<string>): string[] {
  const byHandle = new Map(
    [...handles].map((handle) => [handle.toLocaleLowerCase(), handle]),
  );
  const mentioned = new Map<string, string>();

  for (const match of text.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)/gu)) {
    const handle = byHandle.get(match[1]!.toLocaleLowerCase());
    if (handle) mentioned.set(handle.toLocaleLowerCase(), handle);
  }

  return [...mentioned.values()];
}

/** Whether the reserved collaboration-only broadcast handle is present. */
export function hasEveryoneMention(text: string): boolean {
  return /(?:^|\s)@everyone(?=$|\s|[.,!?;:])/iu.test(text);
}

/** Resolve every distinct @mention against the agents currently in a master chat. */
export function findMentionedAgents(text: string, threads: ThreadDto[]): ThreadDto[] {
  const byHandle = new Map(
    threads.map((thread) => [agentMentionHandle(thread.title).toLocaleLowerCase(), thread]),
  );
  return findMentionedHandles(text, byHandle.keys())
    .map((handle) => byHandle.get(handle.toLocaleLowerCase()))
    .filter((thread): thread is ThreadDto => Boolean(thread));
}

export function findMentionedAgent(text: string, threads: ThreadDto[]): ThreadDto | undefined {
  return findMentionedAgents(text, threads)[0];
}
