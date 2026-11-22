import { BUILT_IN_CAPABILITIES, CAPABILITY_IDS, parseConnectorCapabilityId } from "@ponderosa/core";

// Only restrictions that can change provider runtime access can interrupt it.
const runtimeCapabilities = new Set(BUILT_IN_CAPABILITIES
  .filter(capability => capability.runtimeToolNames?.length || capability.id === CAPABILITY_IDS.filesystemWrite)
  .map(capability => capability.id));

export function newlyRestrictedRuntimeAccess(before: readonly string[], after: readonly string[], engineId: string | undefined): boolean {
  const previous = new Set(before);
  return after.some(id => !previous.has(id) &&
    (runtimeCapabilities.has(id) || engineId !== undefined && parseConnectorCapabilityId(id)?.engineId === engineId));
}
