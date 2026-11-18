import { BUILT_IN_CAPABILITIES, CAPABILITY_IDS, parseConnectorCapabilityId } from "@ponderosa/core";

// Only restrictions that can change this Codex runtime can interrupt it.
const runtimeCapabilities = new Set(BUILT_IN_CAPABILITIES
  .filter(capability => capability.runtimeToolNames?.length || capability.id === CAPABILITY_IDS.filesystemWrite)
  .map(capability => capability.id));

export function newlyRestrictedCodexAccess(before: readonly string[], after: readonly string[]): boolean {
  const previous = new Set(before);
  return after.some(id => !previous.has(id) &&
    (runtimeCapabilities.has(id) || parseConnectorCapabilityId(id)?.engineId === "codex"));
}
