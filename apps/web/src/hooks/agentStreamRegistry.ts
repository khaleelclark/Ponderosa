const liveStreamsByAgent = new Map<string, Set<symbol>>();

/**
 * Records one connected Agent stream. A token per registration keeps duplicate
 * hook mounts independent so one cleanup cannot hide another live stream.
 */
export function registerLiveAgentStream(agentId: string): () => void {
  const token = Symbol(agentId);
  const registrations = liveStreamsByAgent.get(agentId) ?? new Set<symbol>();
  registrations.add(token);
  liveStreamsByAgent.set(agentId, registrations);

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const current = liveStreamsByAgent.get(agentId);
    current?.delete(token);
    if (current?.size === 0) liveStreamsByAgent.delete(agentId);
  };
}

export function hasLiveAgentStream(agentId: string): boolean {
  return (liveStreamsByAgent.get(agentId)?.size ?? 0) > 0;
}
