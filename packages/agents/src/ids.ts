// Deterministic projection-row ids. Derived purely from (agentId, seq[, index]),
// NEVER random — so replaying the log during a rebuild yields byte-identical rows
// (the property the rebuild test asserts).

export function messageId(agentId: string, seq: number): string {
  return `${agentId}:m:${seq}`;
}

export function workItemId(agentId: string, providerWorkItemId: string): string {
  return `${agentId}:work-item:${providerWorkItemId}`;
}

export function artifactId(agentId: string, seq: number, index: number): string {
  return `${agentId}:a:${seq}:${index}`;
}

export function eventRowId(agentId: string, seq: number): string {
  return `${agentId}:e:${seq}`;
}
