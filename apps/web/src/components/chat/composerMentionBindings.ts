import type { AgentMentionBindingDto } from "@ponderosa/core";
import { messageTagTokens } from "@ponderosa/core";

/** Preserve authored handles while refreshing the mutable display side of Agent identity. */
export function refreshedMentionBindings(
  text: string,
  known: readonly AgentMentionBindingDto[],
  current: readonly AgentMentionBindingDto[],
): AgentMentionBindingDto[] {
  const handles = new Set(
    messageTagTokens(text).map(token => token.handle.toLocaleLowerCase()),
  );
  const byId = new Map(known.map(binding => [binding.agentId, binding]));
  const authoredOwners = new Map<string, Set<string>>();
  for (const binding of known) {
    for (const handle of [binding.handle, binding.currentHandle]) {
      const normalized = handle.toLocaleLowerCase();
      const owners = authoredOwners.get(normalized) ?? new Set<string>();
      owners.add(binding.agentId);
      authoredOwners.set(normalized, owners);
    }
  }
  for (const binding of current) {
    const existing = byId.get(binding.agentId);
    const matchingHandle = [binding.handle, binding.currentHandle]
      .map(handle => handle.toLocaleLowerCase())
      .find(handle => handles.has(handle));
    const knownOwners = matchingHandle
      ? authoredOwners.get(matchingHandle)
      : undefined;
    if (
      matchingHandle &&
      (!knownOwners ||
        (knownOwners.size === 1 && knownOwners.has(binding.agentId)))
    ) {
      byId.set(
        binding.agentId,
        existing ? { ...binding, handle: existing.handle } : binding,
      );
    } else if (existing) {
      byId.set(binding.agentId, {
        ...existing,
        currentHandle: binding.currentHandle,
        currentTitle: binding.currentTitle,
      });
    }
  }
  return [...byId.values()].filter(binding =>
    handles.has(binding.handle.toLocaleLowerCase()) ||
    handles.has(binding.currentHandle.toLocaleLowerCase()));
}

/** Resolve an authored handle through its saved identity, then refresh from live data. */
export function resolvedMentionBinding(
  handle: string,
  known: readonly AgentMentionBindingDto[],
  current: readonly AgentMentionBindingDto[],
): AgentMentionBindingDto | undefined {
  const normalized = handle.toLocaleLowerCase();
  const savedAgentIds = new Set(known.flatMap(binding =>
    binding.handle.toLocaleLowerCase() === normalized ||
      binding.currentHandle.toLocaleLowerCase() === normalized
      ? [binding.agentId]
      : []));
  if (savedAgentIds.size > 1) return undefined;
  const savedAgentId = [...savedAgentIds][0];
  if (savedAgentId) return current.find(binding => binding.agentId === savedAgentId);
  const matches = current.filter(binding =>
    binding.handle.toLocaleLowerCase() === normalized ||
    binding.currentHandle.toLocaleLowerCase() === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}
