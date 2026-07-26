import { createHash } from "node:crypto";
import {
  PONDEROSA_RUNTIME_TOOLS,
  type Adapter,
  type ModelOption,
} from "@ponderosa/core";

function communicationV3Prompt(): string[] {
  return [
    "Your ordinary runtime response is Work log only; use a Ponderosa capability when another participant needs the result.",
    "Common reply: ponderosa_message({text}). Ponderosa inherits an unambiguous incoming audience and stable idempotency.",
    "Common delegation: ponderosa_coordinate({recipientAgentId,text}), or use delegations for fan-out. Ponderosa creates one aggregate Join and wakes you as each new result arrives while preserving the open parent workflow.",
    "A new Request is ordinary next-Run work and never interrupts an active recipient. Never create another Request just to tell a busy Agent to stop.",
    "To end work you requested, cancel the exact original outbound Request with ponderosa_update_request({requestId,kind:\"cancelled\"}). To enforceably stop an active descendant Run, use ponderosa_manage stop_agent.",
    "Common correlated result: ponderosa_update_request({text}). It completes the sole attached Request with a canonical handoff.",
    "Common correlated question: ponderosa_update_request({question}). It asks the original requester and preserves the update identity for its answer.",
    "Common user question: ponderosa_decision({question}); add options for a choice or mode approval for permission.",
    "Use explicit message intent, request IDs, lifetimes, join modes, update kinds, and idempotency keys only for advanced or ambiguous cases.",
    "A terminal Request result is the final handoff. Do not send a duplicate message or acknowledgment afterward.",
    "Do not poll or sleep. End the turn after creating a Join when no independent work remains.",
    "Live Team identities are retrievable with ponderosa_team_directory. Retrieve overflow Activation or artifact references with ponderosa_result({refs:[ref]}); continue only with the returned nextCursor.",
    "Version-controlled product documentation is advertised as stable references and retrieved only when needed with ponderosa_docs({refs:[ref]}).",
    "When bounded context omits older scoped material, the current Run receives a separate on-demand reference for it.",
    "When this provider session should be replaced, call ponderosa_rollover({handoff}) once with bounded working state; the next fresh session receives it as non-authoritative continuation context.",
    "Visible workers/reviewers/Agents are created only with ponderosa_create_managed_agent. Provider-native/internal subagents are disabled and never satisfy a request for a Ponderosa Agent or team.",
    "Discover stable teammate IDs with ponderosa_team_directory({}).",
  ];
}

const PROVIDER_DYNAMIC_TOOLS = PONDEROSA_RUNTIME_TOOLS;

export const PROVIDER_TOOL_CONTRACT_HASH = createHash("sha256").update(JSON.stringify({
  tools: PROVIDER_DYNAMIC_TOOLS,
  providerDefinitions: {
    codexAppServer: PROVIDER_DYNAMIC_TOOLS.map((tool) => ({
      type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    })),
    claudeMcp: PROVIDER_DYNAMIC_TOOLS.map((tool) => ({
      name: tool.name.replace(/^ponderosa_/, ""), description: tool.description, inputSchema: tool.inputSchema,
    })),
  },
  promptContract: communicationV3Prompt(),
})).digest("hex");

export function providerSessionContractHash(
  engine: string,
  model?: string,
  effort?: string,
): string {
  return createHash("sha256").update(JSON.stringify({
    toolContractHash: PROVIDER_TOOL_CONTRACT_HASH,
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
  normalizedRuntimeSelection,
  concreteRuntimeSelection,
};
