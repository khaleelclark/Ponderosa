import type { RuntimeDynamicToolSpec } from "./adapter.js";

export type CapabilityScopeKind = "global" | "product" | "branch" | "chat" | "agent" | "run";

export interface CapabilityPolicyRecord {
  scopeKind: CapabilityScopeKind;
  scopeId: string;
  revision: number;
  restrictedCapabilityIds: string[];
  updatedAt: string;
}

export interface CapabilityPolicyLayer {
  scopeKind: CapabilityScopeKind;
  scopeId: string;
  label: string;
  restrictedCapabilityIds: string[];
}

export interface CapabilityRestrictionSource {
  scopeKind: CapabilityScopeKind;
  scopeId: string;
  label: string;
}

export interface EffectiveCapabilityPolicy {
  restrictedCapabilityIds: string[];
  restrictionSources: Record<string, CapabilityRestrictionSource>;
  layers: CapabilityPolicyLayer[];
}

export type CapabilityCategoryId = "browser" | "agents" | "files" | "provider" | "workflow";

export interface CapabilityDescriptor {
  id: string;
  categoryId: CapabilityCategoryId;
  categoryLabel: string;
  label: string;
  description: string;
  /** Only tools transported by Ponderosa. Provider-native restrictions are
   * translated by the adapter from the stable capability ID. */
  runtimeToolNames?: string[];
}

/** Metadata from the same tool inventory used to prepare provider sessions. */
export interface CapabilityTool { name: string; description?: string }
export interface CapabilityCatalogEntry extends CapabilityDescriptor {
  available: boolean;
  unavailableReason?: string;
  includedTools?: CapabilityTool[];
  toolDetailsReason?: string;
}
export interface CapabilityPolicyResponse {
  policy: CapabilityPolicyRecord;
  effective: EffectiveCapabilityPolicy;
  catalog: CapabilityCatalogEntry[];
  catalogNotice?: string;
}

export interface RuntimeCapabilityRestrictions {
  restrictedCapabilityIds: string[];
  restrictedConnectorNames: string[];
  filesystemWriteRestricted: boolean;
}

export const CAPABILITY_IDS = {
  memoryRead:"memory.read",
  memoryWrite:"memory.write",
  browserRead: "browser.read",
  browserInteract: "browser.interact",
  managedAgentCreate: "agents.create_managed",
  hostFileImport: "files.import_host",
  filesystemWrite: "provider.filesystem_write",
  branchCalls: "workflow.branch_calls",
  scripts: "workflow.scripts",
  notifications: "workflow.notifications",
} as const;

export const BUILT_IN_CAPABILITIES: CapabilityDescriptor[] = [
  {id:CAPABILITY_IDS.memoryRead,categoryId:"files",categoryLabel:"Files",label:"Read memory",description:"Read explicitly published Chat memory and granted installation-global memory.",runtimeToolNames:["ponderosa_local_memory_get","ponderosa_local_memory_search","ponderosa_local_memory_history"]},
  {id:CAPABILITY_IDS.memoryWrite,categoryId:"files",categoryLabel:"Files",label:"Write Chat memory",description:"Explicitly publish supplied facts to the current Chat; no Agent global writes.",runtimeToolNames:["ponderosa_local_memory_save","ponderosa_local_memory_update","ponderosa_local_memory_forget"]},
  {
    id: CAPABILITY_IDS.browserRead,
    categoryId: "browser",
    categoryLabel: "Browser",
    label: "Read pages",
    description: "Open, inspect, and capture pages with the Ponderosa browser.",
    runtimeToolNames: ["ponderosa_browser_open", "ponderosa_browser_inspect", "ponderosa_browser_screenshot"],
  },
  {
    id: CAPABILITY_IDS.browserInteract,
    categoryId: "browser",
    categoryLabel: "Browser",
    label: "Interact with pages",
    description: "Navigate, fill, click, upload, switch pages, and control the Ponderosa browser.",
    runtimeToolNames: [
      "ponderosa_browser_navigate",
      "ponderosa_browser_switch_page",
      "ponderosa_browser_close_page",
      "ponderosa_browser_upload",
      "ponderosa_browser_act",
      "ponderosa_browser_take_control",
      "ponderosa_browser_close",
    ],
  },
  {
    id: CAPABILITY_IDS.managedAgentCreate,
    categoryId: "agents",
    categoryLabel: "Agent actions",
    label: "Create managed Agents",
    description: "Create tracked child Agents inside the current Chat.",
    runtimeToolNames: ["ponderosa_create_managed_agent"],
  },
  {
    id: CAPABILITY_IDS.hostFileImport,
    categoryId: "files",
    categoryLabel: "Files",
    label: "Import host files",
    description: "Copy an authorized host file into Ponderosa managed storage.",
    runtimeToolNames: ["ponderosa_import_file"],
  },
  {
    id: CAPABILITY_IDS.filesystemWrite,
    categoryId: "provider",
    categoryLabel: "Provider runtime",
    label: "Write to the filesystem",
    description: "Allow provider-native file creation and editing in the Agent working folder.",
  },
  {
    id: CAPABILITY_IDS.branchCalls,
    categoryId: "workflow",
    categoryLabel: "Workflow operations",
    label: "Call another Branch",
    description: "Start a child Branch execution from a Branch Call Step.",
  },
  {
    id: CAPABILITY_IDS.scripts,
    categoryId: "workflow",
    categoryLabel: "Workflow operations",
    label: "Run Script Steps",
    description: "Execute deterministic Branch scripts on the host.",
  },
  {
    id: CAPABILITY_IDS.notifications,
    categoryId: "workflow",
    categoryLabel: "Workflow operations",
    label: "Send Branch notifications",
    description: "Publish notifications from Notify Steps.",
  },
];

export function connectorCapabilityId(engineId: string, connectorName: string): string {
  return `connector:${encodeURIComponent(engineId)}:${encodeURIComponent(connectorName)}`;
}

export function parseConnectorCapabilityId(id: string): { engineId: string; connectorName: string } | undefined {
  if (!id.startsWith("connector:")) return undefined;
  const [engineId, connectorName, ...rest] = id.slice("connector:".length).split(":");
  if (!engineId || !connectorName || rest.length) return undefined;
  try {
    return { engineId: decodeURIComponent(engineId), connectorName: decodeURIComponent(connectorName) };
  } catch {
    return undefined;
  }
}

export function connectorCapability(engineId: string, connectorName: string): CapabilityDescriptor {
  return {
    id: connectorCapabilityId(engineId, connectorName),
    categoryId: "provider",
    categoryLabel: "Connectors",
    label: connectorName,
    description: `Use the ${connectorName} connector through ${engineId}.`,
  };
}

export function normalizeRestrictedCapabilityIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))].sort();
}

export function resolveCapabilityPolicy(layers: readonly CapabilityPolicyLayer[]): EffectiveCapabilityPolicy {
  const restrictionSources: Record<string, CapabilityRestrictionSource> = {};
  for (const layer of layers) {
    for (const capabilityId of normalizeRestrictedCapabilityIds(layer.restrictedCapabilityIds)) {
      restrictionSources[capabilityId] ??= {
        scopeKind: layer.scopeKind,
        scopeId: layer.scopeId,
        label: layer.label,
      };
    }
  }
  return {
    restrictedCapabilityIds: Object.keys(restrictionSources).sort(),
    restrictionSources,
    layers: layers.map(layer => ({ ...layer, restrictedCapabilityIds: normalizeRestrictedCapabilityIds(layer.restrictedCapabilityIds) })),
  };
}

export function runtimeRestrictions(policy: EffectiveCapabilityPolicy, engineId: string): RuntimeCapabilityRestrictions {
  return {
    restrictedCapabilityIds: policy.restrictedCapabilityIds,
    restrictedConnectorNames: policy.restrictedCapabilityIds
      .map(parseConnectorCapabilityId)
      .filter((entry): entry is { engineId: string; connectorName: string } => Boolean(entry && entry.engineId === engineId))
      .map(entry => entry.connectorName)
      .sort(),
    filesystemWriteRestricted: policy.restrictedCapabilityIds.includes(CAPABILITY_IDS.filesystemWrite),
  };
}

export function filterRuntimeToolsForCapabilities(
  tools: readonly RuntimeDynamicToolSpec[],
  policy: EffectiveCapabilityPolicy,
): RuntimeDynamicToolSpec[] {
  const blockedTools = new Set<string>();
  for (const descriptor of BUILT_IN_CAPABILITIES) {
    if (!policy.restrictedCapabilityIds.includes(descriptor.id)) continue;
    for (const toolName of descriptor.runtimeToolNames ?? []) blockedTools.add(toolName);
  }
  return tools
    .filter(tool => !blockedTools.has(tool.name))
    .map(tool => {
      if (tool.name !== "ponderosa_manage" ||
          !policy.restrictedCapabilityIds.includes(CAPABILITY_IDS.managedAgentCreate)) return tool;
      const inputSchema = structuredClone(tool.inputSchema);
      const properties = inputSchema.properties;
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) return tool;
      const operations = (properties as Record<string, unknown>).operations;
      if (!operations || typeof operations !== "object" || Array.isArray(operations)) return tool;
      const items = (operations as Record<string, unknown>).items;
      if (!items || typeof items !== "object" || Array.isArray(items)) return tool;
      const itemProperties = (items as Record<string, unknown>).properties;
      if (!itemProperties || typeof itemProperties !== "object" || Array.isArray(itemProperties)) return tool;
      const kind = (itemProperties as Record<string, unknown>).kind;
      if (!kind || typeof kind !== "object" || Array.isArray(kind)) return tool;
      const values = (kind as Record<string, unknown>).enum;
      if (!Array.isArray(values)) return tool;
      (kind as Record<string, unknown>).enum = values.filter(value => value !== "create_agent");
      return {
        ...tool,
        description: `${tool.description} Creating Agents is unavailable for this Run.`,
        inputSchema,
      };
    });
}
