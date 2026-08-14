import { createHash } from "node:crypto";
import {
  PONDEROSA_RUNTIME_TOOLS,
  type RuntimeDynamicToolSpec,
  type Adapter,
  type ModelOption,
} from "@ponderosa/core";

export function providerDynamicTools(): RuntimeDynamicToolSpec[] {
  return [...PONDEROSA_RUNTIME_TOOLS];
}

function communicationV3Prompt(): string[] {
  return [
    "Common reply: ponderosa_message({text}). Ponderosa inherits an unambiguous incoming audience and stable idempotency.",
    "If Ponderosa capabilities require discovery, load the Ponderosa message capability specifically. Never substitute a generic or provider-native SendMessage tool: only ponderosa_message creates the canonical reply.",
    "Common delegation: ponderosa_coordinate({recipientAgentId,text}), or use delegations for fan-out. Ponderosa creates one aggregate Join and wakes you as each new result arrives while preserving the open parent workflow.",
    "Passive one-way information: ponderosa_message({delivery:\"next_run\",text,recipientAgentIds}). It creates no chat message, Activation, Run, Request, Join, reply obligation, or acknowledgement. Omit delivery for immediate communication; use coordinate whenever you need a result or lifecycle.",
    "Never promise later work unless a capability response in this Run confirms a durable wake source; otherwise finish now or state what the user must do next.",
    "Common correlated result: ponderosa_update_request({text}). It completes the sole attached Request with a canonical handoff.",
    "Common correlated question: ponderosa_update_request({question}). It asks the original requester and preserves the update identity for its answer.",
    "Common user question: ponderosa_decision({question}); add options for a choice or mode approval for permission.",
    "Use explicit message intent, request IDs, lifetimes, join modes, update kinds, and idempotency keys only for advanced or ambiguous cases.",
    "A terminal Request result is the final handoff. Do not send a duplicate message or acknowledgment afterward.",
    "Do not poll or sleep. End the turn after creating a Join when no independent work remains.",
    "Visible workers/reviewers/Agents are created only with ponderosa_create_managed_agent. Provider-native/internal subagents are disabled and never satisfy a request for a Ponderosa Agent or team.",
    "Discover live stable teammate IDs with ponderosa_team_directory({}).",
  ];
}

const PROVIDER_DYNAMIC_TOOLS = providerDynamicTools();

export function providerToolContractHash(
  tools: readonly RuntimeDynamicToolSpec[],
  promptContract: readonly string[],
): string {
  return createHash("sha256").update(JSON.stringify({
  tools,
  providerDefinitions: {
    codexAppServer: tools.map((tool) => ({
      type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    })),
    claudeMcp: tools.map((tool) => ({
      name: tool.name.replace(/^ponderosa_/, ""), description: tool.description, inputSchema: tool.inputSchema,
    })),
  },
  promptContract,
  })).digest("hex");
}

export const PROVIDER_TOOL_CONTRACT_HASH = providerToolContractHash(
  PROVIDER_DYNAMIC_TOOLS,
  communicationV3Prompt(),
);

export function providerSessionContractHash(
  engine: string,
  model?: string,
  effort?: string,
  toolContractHash = PROVIDER_TOOL_CONTRACT_HASH,
): string {
  return createHash("sha256").update(JSON.stringify({
    toolContractHash,
    engine,
    model: model?.trim() || null,
    effort: effort?.trim() || null,
  })).digest("hex");
}

function runtimeSelectionError(
  adapter: Adapter,
  model?: string,
  effort?: string,
  additionalModels: ModelOption[] = [],
): string | undefined {
  const selectedModel = model?.trim() || undefined;
  const selectedEffort = effort?.trim() || undefined;
  const models = [...adapter.listModels()];
  const knownModelIds = new Set(models.map((option) => option.id));
  for (const option of additionalModels) {
    if (!knownModelIds.has(option.id)) models.push(option);
  }
  const concreteModels = models.filter((option) => option.id);
  const matchedModel = selectedModel ? concreteModels.find((option) => option.id === selectedModel) : undefined;
  // A missing/unreadable provider cache is unknown availability, not evidence
  // that an already-configured model disappeared.
  if (selectedModel && concreteModels.length > 0 && !matchedModel) return "model is not available for engine";
  const knownEfforts = selectedModel
    ? matchedModel?.efforts ?? (adapter.modelSpecificEfforts ? undefined : adapter.listEfforts(selectedModel))
    : adapter.listEfforts();
  if (selectedEffort && knownEfforts && !knownEfforts.some((option) => option.id === selectedEffort)) {
    return selectedModel ? "effort is not available for model" : "effort is not available for engine";
  }
}

function runtimeSpeedSelectionError(
  adapter: Adapter,
  model?: string,
  speed?: string,
  additionalModels: ModelOption[] = [],
): string | undefined {
  const selectedSpeed = speed?.trim() || undefined;
  if (!selectedSpeed || selectedSpeed === "standard") return;
  const selectedModel = model?.trim() || undefined;
  const models = [...adapter.listModels()];
  const knownModelIds = new Set(models.map(option => option.id));
  for (const option of additionalModels) {
    if (!knownModelIds.has(option.id)) models.push(option);
  }
  const matchedModel = selectedModel
    ? models.find(option => option.id === selectedModel)
    : undefined;
  if (!matchedModel?.serviceTiers?.some(tier => tier.id === selectedSpeed)) {
    return selectedModel
      ? "speed is not available for model"
      : "speed is not available for engine";
  }
}

function normalizedRuntimeSelection(
  adapter: Adapter,
  model?: string,
  effort?: string,
  additionalModels: ModelOption[] = [],
): { model?: string; effort?: string } {
  const selectedModel = model?.trim() || undefined;
  const selectedEffort = effort?.trim() || undefined;
  const modelIsStale = selectedModel && runtimeSelectionError(adapter, selectedModel, undefined, additionalModels)?.startsWith("model ");
  const normalizedModel = modelIsStale ? undefined : selectedModel;
  const effortIsStale = selectedEffort && runtimeSelectionError(adapter, normalizedModel, selectedEffort, additionalModels)?.startsWith("effort ");
  return {
    ...(normalizedModel ? { model: normalizedModel } : {}),
    ...(selectedEffort && !effortIsStale ? { effort: selectedEffort } : {}),
  };
}

function concreteRuntimeSelection(
  adapter: Adapter,
  layers: Array<{ model?: string; effort?: string } | undefined>,
  additionalModels: ModelOption[] = [],
): { model?: string; effort?: string } {
  const models = [...adapter.listModels()];
  const knownModelIds = new Set(models.map((option) => option.id));
  for (const option of additionalModels) {
    if (!knownModelIds.has(option.id)) models.push(option);
  }
  const model = layers.map((layer) => layer?.model?.trim()).find((candidate) => candidate && !runtimeSelectionError(adapter, candidate, undefined, additionalModels))
    ?? adapter.defaultModel?.()
    ?? models.find((option) => option.id)?.id;
  const modelDefaultEffort = models.find((option) => option.id === model)?.defaultEffort;
  const modelCatalogUnknown = models.length > 0 && !models.some((option) => Boolean(option.id));
  const effort = !model && (adapter.modelSpecificEfforts || modelCatalogUnknown) ? undefined : [
    ...layers.map((layer) => layer?.effort?.trim()),
    modelDefaultEffort,
    adapter.defaultEffort?.(model),
    adapter.listEfforts(model)[0]?.id,
  ].find((candidate) => candidate && !runtimeSelectionError(adapter, model, candidate, additionalModels));
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export {
  communicationV3Prompt,
  PROVIDER_DYNAMIC_TOOLS,
  runtimeSelectionError,
  runtimeSpeedSelectionError,
  normalizedRuntimeSelection,
  concreteRuntimeSelection,
};
