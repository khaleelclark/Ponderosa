import { createHash } from "node:crypto";
import {
  PONDEROSA_RUNTIME_TOOLS,
  REQUEST_UPDATE_TOOL_KINDS,
  type RuntimeDynamicToolSpec,
  type Adapter,
  type ModelOption,
} from "@ponderosa/core";
import {
  projectProviderEffortOptions,
  projectProviderModelIdentifier,
  projectProviderModelOptions,
} from "./provider-success-projection.js";

export function providerDynamicTools(): RuntimeDynamicToolSpec[] {
  return [...PONDEROSA_RUNTIME_TOOLS];
}

function communicationV3Prompt(defaultReply?: import("@ponderosa/core").CoordinationReplyAuthority): string[] {
  return [
    defaultReply
      ? `This Run has one authorized default reply route (data): ${JSON.stringify(defaultReply)}. ponderosa_message({text}) uses it with stable idempotency. This convenience route does not create a reply obligation.`
      : 'This Run has no authorized default reply route. Do not call ponderosa_message({text}) alone. Explicit private user example: ponderosa_message({intent:"direct_to_user",text:"..."}). For an authorized peer use ponderosa_message({intent:"collaboration",recipientAgentIds:["<stable Agent ID>"],text:"..."}).',
    "Immediate recipientAgentIds always requires explicit intent collaboration. Correlated results belong on ponderosa_update_request, not a convenience message.",
    "If Ponderosa capabilities require discovery, load the Ponderosa message capability specifically. Never substitute a generic or provider-native SendMessage tool: only ponderosa_message creates the canonical reply.",
    "Common delegation: ponderosa_coordinate({recipientAgentId,text}), or use delegations for fan-out. Ponderosa creates one aggregate Join and wakes you as each new result arrives while preserving the open parent workflow.",
    "Passive one-way information: ponderosa_message({delivery:\"next_run\",text,recipientAgentIds}). It creates no chat message, Activation, Run, Request, Join, reply obligation, or acknowledgement. Omit delivery for immediate communication; use coordinate whenever you need a result or lifecycle.",
    "Never promise later work unless a capability response in this Run confirms a durable wake source; otherwise finish now or state what the user must do next.",
    "Common correlated result: ponderosa_update_request({text}). It completes the sole attached Request with a canonical handoff.",
    `Request kind values: ${REQUEST_UPDATE_TOOL_KINDS.join(", ")}. Use waiting_dependency, not waiting.`,
    "Common correlated question: ponderosa_update_request({question}). It asks the original requester and preserves the update identity for its answer.",
    "Common user question: ponderosa_decision({question}); add options for a choice or mode approval for permission. This is the only user-question path in Ponderosa: never call a provider-native AskUserQuestion/request_user_input tool, which cannot reach the user's Ponderosa Chat.",
    "Use explicit message intent, request IDs, lifetimes, join modes, update kinds, and idempotency keys only for advanced or ambiguous cases.",
    "A terminal Request result is the final handoff. Do not send a duplicate message or acknowledgment afterward.",
    "Do not poll or sleep while waiting for another Agent, Request, Join, or background state. A short, bounded delay explicitly requested by the operator is allowed when the delay is itself part of the task. End the turn after creating a Join when no independent work remains.",
    "Visible workers/reviewers/Agents are created only with ponderosa_create_managed_agent. Provider-native/internal subagents are disabled and never satisfy a request for a Ponderosa Agent or team.",
    "Discover live stable teammate IDs with ponderosa_team_directory({}).",
    "To expose a host-created file in Project files or attach it in the browser, call ponderosa_import_file({path}) first, then pass the returned artifact ID to ponderosa_browser_upload. Browser upload never accepts host paths.",
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
  workingCopyId: string,
  model?: string,
  effort?: string,
  toolContractHash = PROVIDER_TOOL_CONTRACT_HASH,
): string {
  return createHash("sha256").update(JSON.stringify({
    toolContractHash,
    engine,
    model: model?.trim() || null,
    effort: effort?.trim() || null,
    workingCopyId: workingCopyId.trim(),
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
  const models = projectProviderModelOptions(adapter.listModels());
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
    ? matchedModel?.efforts ?? (adapter.modelSpecificEfforts
      ? undefined
      : projectProviderEffortOptions(adapter.listEfforts(selectedModel)))
    : projectProviderEffortOptions(adapter.listEfforts());
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
  const models = projectProviderModelOptions(adapter.listModels());
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
  const models = projectProviderModelOptions(adapter.listModels());
  const knownModelIds = new Set(models.map((option) => option.id));
  for (const option of additionalModels) {
    if (!knownModelIds.has(option.id)) models.push(option);
  }
  const model = layers.map((layer) => layer?.model?.trim()).find((candidate) => candidate && !runtimeSelectionError(adapter, candidate, undefined, additionalModels))
    ?? projectProviderModelIdentifier(adapter.defaultModel?.())
    ?? models.find((option) => option.id)?.id;
  const modelDefaultEffort = models.find((option) => option.id === model)?.defaultEffort;
  const modelCatalogUnknown = models.length > 0 && !models.some((option) => Boolean(option.id));
  const effort = !model && (adapter.modelSpecificEfforts || modelCatalogUnknown) ? undefined : [
    ...layers.map((layer) => layer?.effort?.trim()),
    modelDefaultEffort,
    projectProviderModelIdentifier(adapter.defaultEffort?.(model)),
    projectProviderEffortOptions(adapter.listEfforts(model))[0]?.id,
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
