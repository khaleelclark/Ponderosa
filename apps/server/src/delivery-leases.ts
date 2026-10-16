export function leaseAgentDelivery(
  agentLeases: Map<string, number>,
  agentIds: readonly string[],
): () => void {
  const uniqueAgentIds = [...new Set(agentIds)];
  for (const agentId of uniqueAgentIds) {
    agentLeases.set(agentId, (agentLeases.get(agentId) ?? 0) + 1);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const agentId of uniqueAgentIds) {
      const remaining = (agentLeases.get(agentId) ?? 1) - 1;
      if (remaining > 0) agentLeases.set(agentId, remaining);
      else agentLeases.delete(agentId);
    }
  };
}

export function leaseConversationDelivery(
  conversationLeases: Map<string, number>,
  agentLeases: Map<string, number>,
  conversationId: string,
  agentIds: readonly string[],
): () => void {
  conversationLeases.set(conversationId, (conversationLeases.get(conversationId) ?? 0) + 1);
  const releaseAgents = leaseAgentDelivery(agentLeases, agentIds);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (conversationLeases.get(conversationId) ?? 1) - 1;
    if (remaining > 0) conversationLeases.set(conversationId, remaining);
    else conversationLeases.delete(conversationId);
    releaseAgents();
  };
}

/** Replay a committed communication while keeping its delivery owners leased.
 * A failed projection/read is still committed; callers must return their
 * route-specific recovering response rather than attempting a second send. */
export async function reconcileLeasedCommunicationReplay<T>(input: {
  conversationLeases: Map<string, number>;
  agentLeases: Map<string, number>;
  conversationId: string;
  agentIds: readonly string[];
  projectId: string;
  communicationEventId: string;
  reconcile: (filter: { projectId: string; communicationEventId: string }) => Promise<unknown>;
  read: () => T;
}): Promise<{ recovered: true; value: T } | { recovered: false }> {
  const release = leaseConversationDelivery(
    input.conversationLeases,
    input.agentLeases,
    input.conversationId,
    input.agentIds,
  );
  try {
    await input.reconcile({
      projectId: input.projectId,
      communicationEventId: input.communicationEventId,
    });
    return { recovered: true, value: input.read() };
  } catch {
    return { recovered: false };
  } finally {
    release();
  }
}
