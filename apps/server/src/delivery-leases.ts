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
