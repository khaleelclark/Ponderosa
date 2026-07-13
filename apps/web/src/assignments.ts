import type {
  CancelAssignmentResponse,
  AssignmentEventEnvelope,
  AssignmentDto,
} from "@ponderosa/core";

export type { AssignmentStatus } from "@ponderosa/core";

export interface AssignmentStore {
  lastSeq: number;
  assignments: ReadonlyMap<string, AssignmentDto>;
}

export interface AssignmentTreeNode extends AssignmentDto {
  children: AssignmentTreeNode[];
}

export interface AssignmentUiBinding {
  store: AssignmentStore;
  cancelling?: ReadonlySet<string>;
  cancel(run: AssignmentDto): void;
}

export function isAssignmentUiEnabled(env: Record<string, string | undefined>): boolean {
  const value = env.PUBLIC_PONDEROSA_ASSIGNMENTS ?? env.VITE_PONDEROSA_ASSIGNMENTS;
  return value !== "0" && value !== "false";
}

export const emptyAssignmentStore = (): AssignmentStore => ({
  lastSeq: 0,
  assignments: new Map(),
});

export function hydrateAssignmentStore(runs: readonly AssignmentDto[]): AssignmentStore {
  return { ...emptyAssignmentStore(), assignments: new Map(runs.map((run) => [run.id, run])) };
}

/**
 * Normalizes the authoritative replayable lifecycle envelope into UI state.
 */
export function applyAssignmentEnvelope(store: AssignmentStore, envelope: AssignmentEventEnvelope): AssignmentStore {
  if (envelope.seq <= store.lastSeq) return store;

  const assignment = envelope.event.assignment;
  const current = store.assignments.get(assignment.id);
  if (current && assignment.version <= current.version) {
    return { ...store, lastSeq: envelope.seq };
  }

  const assignments = new Map(store.assignments);
  assignments.set(assignment.id, assignment);
  return { ...store, lastSeq: envelope.seq, assignments };
}

/** Applies only server-confirmed cancellation states; requests remain local UI state. */
export function applyCancellationResult(
  store: AssignmentStore,
  result: CancelAssignmentResponse,
): AssignmentStore {
  const assignments = new Map(store.assignments);
  for (const affected of result.affected) {
    const current = assignments.get(affected.assignmentId);
    if (!current || affected.version < current.version) continue;
    assignments.set(affected.assignmentId, {
      ...current,
      status: affected.status,
      version: affected.version,
      updatedAt: affected.updatedAt,
      canCancel: affected.status === "queued" || affected.status === "running" || affected.status === "awaiting_disposition",
    });
  }
  return { ...store, assignments };
}

export function buildAssignmentTree(runs: Iterable<AssignmentDto>): AssignmentTreeNode[] {
  const nodes = new Map<string, AssignmentTreeNode>();
  for (const run of runs) nodes.set(run.id, { ...run, children: [] });

  const roots: AssignmentTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentAssignmentId ? nodes.get(node.parentAssignmentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (items: AssignmentTreeNode[]) => {
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    items.forEach((item) => sort(item.children));
  };
  sort(roots);
  return roots;
}

export function assignmentRootsByParentThread(
  runs: Iterable<AssignmentDto>,
): ReadonlyMap<string, readonly AssignmentTreeNode[]> {
  const grouped = new Map<string, AssignmentTreeNode[]>();
  for (const root of buildAssignmentTree(runs)) {
    grouped.set(root.parentAgentId, [...(grouped.get(root.parentAgentId) ?? []), root]);
  }
  return grouped;
}
