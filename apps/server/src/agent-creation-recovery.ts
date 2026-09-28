import type { AgentStore } from "@ponderosa/agents";

/** Settle an already-canonical Agent creation only after its communication
 * projection is available. Route-specific retry responses stay with callers. */
export async function reconcileCommittedAgentCreation(input: {
  store: Pick<AgentStore, "updateAgentCreationOperation">;
  deletingAgentIds: Set<string>;
  operationId: string;
  projectId: string;
  communicationEventId: string;
  agentIds: readonly string[];
  reconcile: (filter: {
    projectId: string;
    communicationEventId: string;
    allowQuarantinedAgentIds: ReadonlySet<string>;
  }) => Promise<unknown>;
}): Promise<boolean> {
  try {
    await input.reconcile({
      projectId: input.projectId,
      communicationEventId: input.communicationEventId,
      allowQuarantinedAgentIds: new Set(input.agentIds),
    });
    input.store.updateAgentCreationOperation(input.operationId, {
      status: "completed",
      lastError: null,
    });
    for (const agentId of input.agentIds) input.deletingAgentIds.delete(agentId);
    return true;
  } catch {
    return false;
  }
}
