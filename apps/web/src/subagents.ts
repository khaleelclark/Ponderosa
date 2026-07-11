export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SubagentRunView {
  id: string;
  parentRunId?: string;
  rootRunId: string;
  depth: number;
  displayLabel: string;
  /** Redacted, UI-safe delegation context. Full prompts require separate access. */
  delegationSummary?: string;
  status: SubagentStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  failure?: { code: string; message: string; retryable: boolean; occurredAt: string };
  version: number;
  cancellable: boolean;
}

export interface SubagentOutputChunk {
  runId: string;
  chunkSeq: number;
  cursor: string;
  text: string;
}

export type SubagentLifecycleEvent =
  | { seq: number; type: "upsert"; run: SubagentRunView }
  | { seq: number; type: "output"; chunk: SubagentOutputChunk };

export interface SubagentCancellationResult {
  affected: Array<{
    runId: string;
    status: SubagentStatus;
    version: number;
    updatedAt: string;
  }>;
}

export interface SubagentStore {
  lastSeq: number;
  runs: ReadonlyMap<string, SubagentRunView>;
  output: ReadonlyMap<string, readonly SubagentOutputChunk[]>;
}

export interface SubagentTreeNode extends SubagentRunView {
  children: SubagentTreeNode[];
}

export interface SubagentUiBinding {
  store: SubagentStore;
  cancelling?: ReadonlySet<string>;
  cancel(run: SubagentRunView): void;
  loadTranscript?(run: SubagentRunView): void;
}

export function isSubagentUiEnabled(env: Record<string, string | undefined>): boolean {
  const value = env.PUBLIC_PONDEROSA_SUBAGENTS ?? env.VITE_PONDEROSA_SUBAGENTS;
  return value === "1" || value === "true";
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
    if (existing.some((chunk) => chunk.chunkSeq === event.chunk.chunkSeq)) {
      return { ...store, lastSeq: event.seq };
    }
    const output = new Map(store.output);
    output.set(event.chunk.runId, [...existing, event.chunk].sort((a, b) => a.chunkSeq - b.chunkSeq));
    return { ...store, lastSeq: event.seq, output };
  }

  const current = store.runs.get(event.run.id);
  if (current && event.run.version <= current.version) {
    return { ...store, lastSeq: event.seq };
  }

  const runs = new Map(store.runs);
  runs.set(event.run.id, event.run);
  return { ...store, lastSeq: event.seq, runs };
}

/** Applies only server-confirmed cancellation states; requests remain local UI state. */
export function applyCancellationResult(
  store: SubagentStore,
  result: SubagentCancellationResult,
): SubagentStore {
  const runs = new Map(store.runs);
  for (const affected of result.affected) {
    const current = runs.get(affected.runId);
    if (!current || affected.version < current.version) continue;
    runs.set(affected.runId, {
      ...current,
      status: affected.status,
      version: affected.version,
      updatedAt: affected.updatedAt,
      cancellable: affected.status === "queued" || affected.status === "running",
    });
  }
  return { ...store, runs };
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
