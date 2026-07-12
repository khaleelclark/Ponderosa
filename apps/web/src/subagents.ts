import type {
  CancelSubagentResponse,
  SubagentEventEnvelope,
  SubagentRunDto,
} from "@ponderosa/core";

export type { SubagentStatus } from "@ponderosa/core";

export interface SubagentStore {
  lastSeq: number;
  runs: ReadonlyMap<string, SubagentRunDto>;
}

export interface SubagentTreeNode extends SubagentRunDto {
  children: SubagentTreeNode[];
}

export interface SubagentUiBinding {
  store: SubagentStore;
  cancelling?: ReadonlySet<string>;
  cancel(run: SubagentRunDto): void;
}

export function isSubagentUiEnabled(env: Record<string, string | undefined>): boolean {
  const value = env.PUBLIC_PONDEROSA_SUBAGENTS ?? env.VITE_PONDEROSA_SUBAGENTS;
  return value !== "0" && value !== "false";
}

export const emptySubagentStore = (): SubagentStore => ({
  lastSeq: 0,
  runs: new Map(),
});

export function hydrateSubagentStore(runs: readonly SubagentRunDto[]): SubagentStore {
  return { ...emptySubagentStore(), runs: new Map(runs.map((run) => [run.id, run])) };
}

/**
 * Normalizes the authoritative replayable lifecycle envelope into UI state.
 */
export function applySubagentEnvelope(store: SubagentStore, envelope: SubagentEventEnvelope): SubagentStore {
  if (envelope.seq <= store.lastSeq) return store;

  const run = envelope.event.run;
  const current = store.runs.get(run.id);
  if (current && run.version <= current.version) {
    return { ...store, lastSeq: envelope.seq };
  }

  const runs = new Map(store.runs);
  runs.set(run.id, run);
  return { ...store, lastSeq: envelope.seq, runs };
}

/** Applies only server-confirmed cancellation states; requests remain local UI state. */
export function applyCancellationResult(
  store: SubagentStore,
  result: CancelSubagentResponse,
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
      canCancel: affected.status === "queued" || affected.status === "running" || affected.status === "awaiting_disposition",
    });
  }
  return { ...store, runs };
}

export function buildSubagentTree(runs: Iterable<SubagentRunDto>): SubagentTreeNode[] {
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

export function subagentRootsByParentThread(
  runs: Iterable<SubagentRunDto>,
): ReadonlyMap<string, readonly SubagentTreeNode[]> {
  const grouped = new Map<string, SubagentTreeNode[]>();
  for (const root of buildSubagentTree(runs)) {
    if (!root.parentThreadId) continue;
    grouped.set(root.parentThreadId, [...(grouped.get(root.parentThreadId) ?? []), root]);
  }
  return grouped;
}
