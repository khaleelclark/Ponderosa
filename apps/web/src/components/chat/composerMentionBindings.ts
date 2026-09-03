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
  const authoredOwners = new Map(
    known.map(binding => [binding.handle.toLocaleLowerCase(), binding.agentId]),
  );
  for (const binding of current) {
    const existing = byId.get(binding.agentId);
    const matchingHandle = [binding.handle, binding.currentHandle]
      .map(handle => handle.toLocaleLowerCase())
      .find(handle => handles.has(handle));
    if (
      matchingHandle &&
      (!authoredOwners.has(matchingHandle) ||
        authoredOwners.get(matchingHandle) === binding.agentId)
    ) {
      byId.set(binding.agentId, binding);
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
  const saved = known.find(binding =>
    binding.handle.toLocaleLowerCase() === normalized);
  if (saved) return current.find(binding => binding.agentId === saved.agentId);
  const matches = current.filter(binding =>
    binding.handle.toLocaleLowerCase() === normalized ||
    binding.currentHandle.toLocaleLowerCase() === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}
