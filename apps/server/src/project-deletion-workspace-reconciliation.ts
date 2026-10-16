import type { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import type { WorkspaceEventEnvelope } from "@ponderosa/core";

export function reconcileCommittedProjectDeletion(
  workspace: WorkspaceStore,
  publish: (event: WorkspaceEventEnvelope) => void,
  projectId: string,
): WorkspaceEventEnvelope {
  const event = workspace.reconcileProjectDeletion(projectId);
  publish(event);
  return event;
}

export function reconcileCommittedProjectDeletions(
  store: Pick<AgentStore, "listProjectDeletionReceipts">,
  workspace: WorkspaceStore,
  publish: (event: WorkspaceEventEnvelope) => void,
): void {
  for (const receipt of store.listProjectDeletionReceipts()) {
    reconcileCommittedProjectDeletion(workspace, publish, receipt.projectId);
  }
}

export function publishWorkspaceEvent(
  subscribers: Iterable<(event: WorkspaceEventEnvelope) => void>,
  event: WorkspaceEventEnvelope,
  onError: (error: unknown) => void,
): void {
  for (const subscriber of subscribers) {
    try { subscriber(event); }
    catch (error) { onError(error); }
  }
}
