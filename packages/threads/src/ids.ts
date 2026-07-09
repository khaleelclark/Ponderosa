// Deterministic projection-row ids. Derived purely from (threadId, seq[, index]),
// NEVER random — so replaying the log during a rebuild yields byte-identical rows
// (the property the rebuild test asserts).

export function messageId(threadId: string, seq: number): string {
  return `${threadId}:m:${seq}`;
}

/** A task id keyed by the seq of the run's opening user_message. */
export function taskId(threadId: string, runSeq: number): string {
  return `${threadId}:t:${runSeq}`;
}

export function artifactId(threadId: string, seq: number, index: number): string {
  return `${threadId}:a:${seq}:${index}`;
}

export function eventRowId(threadId: string, seq: number): string {
  return `${threadId}:e:${seq}`;
}
