import type { ThreadDto } from "@ponderosa/core";

/** Stable, typeable handle derived from the agent's current display name. */
export function agentMentionHandle(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

/** Resolve the first @mention against the agents currently in a master chat. */
export function findMentionedAgent(text: string, threads: ThreadDto[]): ThreadDto | undefined {
  const match = /(?:^|\s)@([\p{L}\p{N}_-]+)/u.exec(text);
  if (!match) return undefined;

  const handle = match[1]!.toLocaleLowerCase();
  return threads.find((thread) => agentMentionHandle(thread.title).toLocaleLowerCase() === handle);
}
