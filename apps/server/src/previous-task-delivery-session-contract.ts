import type { RuntimeDynamicToolSpec } from '@ponderosa/core';

/** Exact pre-delivery-marker tool schema. No surrounding policy, descriptions,
 * permissions or other tools may be changed. The caller checks the complete
 * reconstructed contract against the accepted session hash before use, and
 * uses it only for that old session's non-tool-calling rollover handoff. */
export function previousTaskDeliveryTools(tools: readonly RuntimeDynamicToolSpec[]): RuntimeDynamicToolSpec[] {
  return tools.map(tool => {
    if (tool.name !== 'ponderosa_message') return tool;
    const schema = tool.inputSchema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    if (!properties?.taskDelivery) return tool;
    const oneOf = schema.oneOf as Array<Record<string, unknown>>;
    return { ...tool, inputSchema: { ...schema,
      oneOf: oneOf.map(branch => {
        const not = branch.not as { anyOf?: Array<{ required?: string[] }> } | undefined;
        return not?.anyOf?.some(item => item.required?.length === 1 && item.required[0] === 'taskDelivery')
          ? { ...branch, not: { ...not, anyOf: not.anyOf.filter(item => !(item.required?.length === 1 && item.required[0] === 'taskDelivery')) } } : branch;
      }),
      properties: Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'taskDelivery')),
    } };
  });
}
