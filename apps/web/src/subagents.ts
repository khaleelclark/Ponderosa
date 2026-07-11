export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SubagentRunView {
  id: string;
  parentRunId?: string;
  rootRunId: string;
  depth: number;
  title: string;
  prompt: string;
  status: SubagentStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  resultSummary?: string;
  failure?: { code?: string; message: string };
  version: number;
  cancellable: boolean;
}

export interface SubagentOutputChunk {
  runId: string;
  cursor: number;
  text: string;
}

export type SubagentLifecycleEvent =
  | { seq: number; type: "upsert"; run: SubagentRunView }
  | { seq: number; type: "patch"; runId: string; version: number; patch: Partial<Omit<SubagentRunView, "id" | "version">> }
  | { seq: number; type: "output"; chunk: SubagentOutputChunk };

export interface SubagentStore {
  lastSeq: number;
  runs: ReadonlyMap<string, SubagentRunView>;
  output: ReadonlyMap<string, readonly SubagentOutputChunk[]>;
}

export interface SubagentTreeNode extends SubagentRunView {
  children: SubagentTreeNode[];
}

export const emptySubagentStore = (): SubagentStore => ({
  lastSeq: 0,
  runs: new Map(),
  output: new Map(),
});

/**
 * Normalizes replayable lifecycle events into UI state. The transport adapter is
 * responsible only for converting its wire payload into this small event union.
 */
export function applySubagentEvent(store: SubagentStore, event: SubagentLifecycleEvent): SubagentStore {
  if (event.seq <= store.lastSeq) return store;

  if (event.type === "output") {
    const existing = store.output.get(event.chunk.runId) ?? [];
    if (existing.some((chunk) => chunk.cursor === event.chunk.cursor)) {
      return { ...store, lastSeq: event.seq };
    }
    const output = new Map(store.output);
    output.set(event.chunk.runId, [...existing, event.chunk].sort((a, b) => a.cursor - b.cursor));
    return { ...store, lastSeq: event.seq, output };
  }

  const current = store.runs.get(event.type === "upsert" ? event.run.id : event.runId);
  const incomingVersion = event.type === "upsert" ? event.run.version : event.version;
  if (current && incomingVersion <= current.version) {
    return { ...store, lastSeq: event.seq };
  }
  if (event.type === "patch" && !current) {
    // A replay can deliver a patch before its snapshot/upsert. Keep advancing the
    // global cursor; the next authoritative upsert supplies the complete node.
    return { ...store, lastSeq: event.seq };
  }

  const runs = new Map(store.runs);
  const next = event.type === "upsert"
    ? event.run
    : { ...current!, ...event.patch, id: event.runId, version: event.version };
  runs.set(next.id, next);
  return { ...store, lastSeq: event.seq, runs };
}

export function buildSubagentTree(runs: Iterable<SubagentRunView>): SubagentTreeNode[] {
  const nodes = new Map<string, SubagentTreeNode>();
  for (const run of runs) nodes.set(run.id, { ...run, children: [] });

  const roots: SubagentTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentRunId ? nodes.get(node.parentRunId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (items: SubagentTreeNode[]) => {
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    items.forEach((item) => sort(item.children));
  };
  sort(roots);
  return roots;
}

export function subagentTranscript(store: SubagentStore, runId: string): string {
  return (store.output.get(runId) ?? []).map((chunk) => chunk.text).join("");
}
