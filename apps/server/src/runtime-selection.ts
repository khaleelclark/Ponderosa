import { createHash } from "node:crypto";
import {
  PONDEROSA_CONTEXT_TOOL,
  PONDEROSA_RESULT_TOOL,
  PONDEROSA_RUNTIME_TOOLS,
  type RuntimeDynamicToolSpec,
  type Adapter,
  type ModelOption,
} from "@ponderosa/core";

export interface ConditionalRetrievalAvailability {
  context: boolean;
  result: boolean;
}

const ALL_RETRIEVAL_TOOLS: ConditionalRetrievalAvailability = {
  context: true,
  result: true,
};

export function providerDynamicTools(
  availability: ConditionalRetrievalAvailability = ALL_RETRIEVAL_TOOLS,
): RuntimeDynamicToolSpec[] {
  return PONDEROSA_RUNTIME_TOOLS.filter((tool) =>
    (availability.context || tool.name !== PONDEROSA_CONTEXT_TOOL.name) &&
    (availability.result || tool.name !== PONDEROSA_RESULT_TOOL.name));
}

function communicationV3Prompt(
  availability: ConditionalRetrievalAvailability = ALL_RETRIEVAL_TOOLS,
): string[] {
  return [
    "Your ordinary runtime response is Work log only; use a Ponderosa capability when another participant needs the result.",
    "Common reply: ponderosa_message({text}). Ponderosa inherits an unambiguous incoming audience and stable idempotency.",
    "If Ponderosa capabilities require discovery, load the Ponderosa message capability specifically. Never substitute a generic or provider-native SendMessage tool: only ponderosa_message creates the canonical reply.",
    "Common delegation: ponderosa_coordinate({recipientAgentId,text}), or use delegations for fan-out. Ponderosa creates one aggregate Join and wakes you as each new result arrives while preserving the open parent workflow.",
    "Passive one-way information: ponderosa_message({delivery:\"next_run\",text,recipientAgentIds}). It creates no chat message, Activation, Run, Request, Join, reply obligation, or acknowledgement. Omit delivery for immediate communication; use coordinate whenever you need a result or lifecycle.",
    "A message, ordinary runtime output, or completed Run does not schedule future work. Never promise a later follow-up unless a capability response in this Run explicitly confirms that it created a durable wake source.",
    "When no durable wake source was confirmed, finish the work now or state that you cannot self-resume and what the user must do next.",
    "A new Request is ordinary next-Run work and never interrupts an active recipient. Never create another Request just to tell a busy Agent to stop.",
    "To end work you requested, cancel the exact original outbound Request with ponderosa_update_request({requestId,kind:\"cancelled\"}). To enforceably stop an active descendant Run, use ponderosa_manage stop_agent.",
    "Common correlated result: ponderosa_update_request({text}). It completes the sole attached Request with a canonical handoff.",
    "Common correlated question: ponderosa_update_request({question}). It asks the original requester and preserves the update identity for its answer.",
    "Common user question: ponderosa_decision({question}); add options for a choice or mode approval for permission.",
    "Use explicit message intent, request IDs, lifetimes, join modes, update kinds, and idempotency keys only for advanced or ambiguous cases.",
    "A terminal Request result is the final handoff. Do not send a duplicate message or acknowledgment afterward.",
    "Do not poll or sleep. End the turn after creating a Join when no independent work remains.",
    "Live Team identities are retrievable with ponderosa_team_directory.",
    ...(availability.result ? [
      "This Run has a retrievable omitted or artifact result reference. Use ponderosa_result({refs:[ref],query:\"distinctive literal\"}) for targeted excerpts, or omit query for bounded full-content pages; continue only with the returned nextCursor.",
    ] : []),
    ...(availability.context ? [
      "This Run has older scoped canonical context available through ponderosa_context. Retrieve it only when the bounded input is insufficient.",
    ] : []),
    "Visible workers/reviewers/Agents are created only with ponderosa_create_managed_agent. Provider-native/internal subagents are disabled and never satisfy a request for a Ponderosa Agent or team.",
    "Discover stable teammate IDs with ponderosa_team_directory({}).",
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
