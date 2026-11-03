import {localMemoryTools} from "./local-memory-catalog.js";
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

export function providerDynamicTools(localMemoryEnabled=false): RuntimeDynamicToolSpec[] {
  return [...PONDEROSA_RUNTIME_TOOLS,...(localMemoryEnabled?localMemoryTools:[])];
}

function communicationV3Prompt(defaultReply?: import("@ponderosa/core").CoordinationReplyAuthority): string[] {
  return [
    defaultReply
      ? `This Run has one authorized default reply route (data): ${JSON.stringify(defaultReply)}. ponderosa_message({text}) uses it with stable idempotency. This convenience route does not create a reply obligation.`
      : 'This Run has no authorized default reply route. Do not call ponderosa_message({text}) alone. Explicit private user example: ponderosa_message({intent:"direct_to_user",text:"..."}). For an authorized peer use ponderosa_message({intent:"collaboration",recipientAgentIds:["<stable Agent ID>"],text:"..."}).',
  ];
}

function communicationV3Instructions(): string[] {
  return [
    "Peer communication is concise: send the actionable ask or owned result, changed facts, exact decisions/blockers, and evidence references. Include only context the recipient needs; do not repeat shared instructions, forward whole reports, or add boilerplate acknowledgements. Keep full evidence in referenced artifacts and preserve essential objective, acceptance criteria and handoff state.",
    "After work, ponderosa_reply_stream can authorize one final item on the default route, an explicitly selected mixed Communication route/document, or an exact attached Request result. Finish other required routes with their ordinary explicit tools first. For correlated streaming select publication.kind=request_update; final commit uses update_request authority. On rejection use the ordinary explicit publication API. Never duplicate.",
    "For an explicitly marked voice Direct Message, you may first call ponderosa_voice_reply({acknowledgement:your short scoped acknowledgement}) then continue the actual workflow. Only its matched native receipt authorizes provisional early speech; it does not satisfy final delivery. After work call ponderosa_voice_reply without acknowledgement before writing the final answer. Successful final authorization publishes one canonical reply. If unavailable, use ordinary ponderosa_message.",
    "Immediate recipientAgentIds always requires explicit intent collaboration. Correlated results belong on ponderosa_update_request, not a convenience message.",
    "If Ponderosa capabilities require discovery, load the Ponderosa message capability specifically. Never substitute a generic or provider-native SendMessage tool: only ponderosa_message creates the canonical reply.",
    "Common delegation: ponderosa_coordinate({recipientAgentId,text}), or use delegations for fan-out. Ponderosa creates one aggregate Join and wakes you as each new result arrives while preserving the open parent workflow.",
    "Passive one-way information: ponderosa_message({delivery:\"next_run\",text,recipientAgentIds}). It creates no chat message, Activation, Run, Request, Join, reply obligation, or acknowledgement. Omit delivery for immediate communication; use coordinate whenever you need a result or lifecycle.",
    "Finish the whole human objective, preserving later steering and its requested work/verification order. A completed batch is progress. Wait only on a real dependency with a durable wake; create an actionable blocking Decision when a human answer is required. Never promise later work without a confirmed durable wake.",
    "Common correlated result: ponderosa_update_request({text}). It completes the sole attached Request with a canonical handoff.",
    `Request kind values: ${REQUEST_UPDATE_TOOL_KINDS.join(", ")}. Use waiting_dependency, not waiting.`,
    "Common correlated question: ponderosa_update_request({question}). It asks the original requester and preserves the update identity for its answer.",
    "Common user question: ponderosa_decision({question}); add options for a choice or mode approval for permission. Supported provider-native AskUserQuestion/request_user_input callbacks also reach the human through the native question form; do not ask the same question twice. Questions never grant permissions.",
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

/** A reply route belongs to an exact Run, not the immutable provider session.
 * The scheduler submits communicationV3Prompt(defaultReply) on every injection. */
export function communicationV3SessionPrompt(): string[] {
  return [
    "Use only the current Run's host-provided reply route and active capability. Prior turns do not confer a reply route or delivery authority.",
    ...communicationV3Instructions(),
  ];
}

export const PROVIDER_TOOL_CONTRACT_HASH = providerToolContractHash(
  PROVIDER_DYNAMIC_TOOLS,
  communicationV3SessionPrompt(),
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

/** Preserve a retained pre-selector-removal digest only when its entire contract
 * still matches, including observed native auth. New sessions omit the selector. */
export function providerRuntimeSessionContractHash(
  input: {
    runtimeSessionContractHash: string;
    speed?: string;
    billingMode?: "subscription" | "api";
    systemPromptHash: string;
    scopeKey?: string;
  },
  retainedHash?: string,
): string {
  const hash = (expectedBillingMode?: "subscription" | "api") =>
    createHash("sha256").update(JSON.stringify({
      runtimeSessionContractHash: input.runtimeSessionContractHash,
      speed: input.speed,
      ...(expectedBillingMode ? { expectedBillingMode } : {}),
      ...(input.billingMode ? { billingMode: input.billingMode } : {}),
      systemPromptHash: input.systemPromptHash,
      scopeKey: input.scopeKey,
    })).digest("hex");
  const current = hash();
  if (!input.billingMode || !retainedHash) return current;
  const previous = hash(input.billingMode);
  return retainedHash === previous ? previous : current;
}

function runtimeModelOptions(adapter: Adapter, additionalModels?: ModelOption[]): ModelOption[] {
  return projectProviderModelOptions(additionalModels ?? adapter.listModels());
}

function runtimeSelectionError(
  adapter: Adapter,
  model?: string,
  effort?: string,
  additionalModels?: ModelOption[],
): string | undefined {
  const selectedModel = model?.trim() || undefined;
  const selectedEffort = effort?.trim() || undefined;
  const models = runtimeModelOptions(adapter, additionalModels);
  const concreteModels = models.filter((option) => option.id);
  const matchedModel = selectedModel ? concreteModels.find((option) => option.id === selectedModel) : undefined;
  // A missing/unreadable provider cache is unknown availability, not evidence
  // that an already-configured model disappeared.
  if (selectedModel && (additionalModels !== undefined || concreteModels.length > 0) && !matchedModel) return "model is not available for engine";
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
  additionalModels?: ModelOption[],
): string | undefined {
  const selectedSpeed = speed?.trim() || undefined;
  if (!selectedSpeed || selectedSpeed === "standard") return;
  const selectedModel = model?.trim() || undefined;
  const models = runtimeModelOptions(adapter, additionalModels);
  const matchedModel = selectedModel
    ? models.find(option => option.id === selectedModel)
    : undefined;
  if (!matchedModel?.serviceTiers?.some(tier => tier.id === selectedSpeed)) {
    return selectedModel
      ? "speed is not available for model"
      : "speed is not available for engine";
  }
}

/** Creation validates explicit effort against the inherited concrete model,
 * before any working-folder or canonical state is created. */
export function chatCreationRuntimeSelection(
  adapter: Adapter,
  requested: { model?: string; effort?: string; speed?: string },
  defaults: { model?: string; effort?: string } | undefined,
  additionalModels?: ModelOption[],
): { model?: string; effort?: string; speed: string; error?: string } {
  const modelError = runtimeSelectionError(adapter, requested.model, undefined, additionalModels);
  const selected = concreteRuntimeSelection(adapter, [
    { model: requested.model }, defaults,
  ], additionalModels);
  const models = runtimeModelOptions(adapter, additionalModels);
  const model = models.find(option => option.id && option.id === selected.model);
  const speed = requested.speed?.trim() || model?.defaultServiceTier || "standard";
  if (modelError) return { speed, error: modelError };
  if (!model || model.availability === "unavailable") return { speed, error: "an advertised model is required for Chat creation" };
  const selectionError = runtimeSelectionError(adapter, selected.model, requested.effort, additionalModels);
  if (selectionError) return { speed, error: selectionError };
  const efforts = model.efforts ?? (adapter.modelSpecificEfforts ? [] : projectProviderEffortOptions(adapter.listEfforts(selected.model)));
  if (requested.effort?.trim() && !efforts.some(option => option.id === requested.effort!.trim())) {
    return { speed, error: "effort is not advertised for model" };
  }
  const resolved = concreteRuntimeSelection(adapter, [
    { model: selected.model, effort: requested.effort }, defaults,
  ], additionalModels);
  const speedError = runtimeSpeedSelectionError(adapter, resolved.model, speed, additionalModels);
  return { ...resolved, speed, ...(speedError ? { error: speedError } : {}) };
}

function normalizedRuntimeSelection(
  adapter: Adapter,
  model?: string,
  effort?: string,
  additionalModels?: ModelOption[],
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
  additionalModels?: ModelOption[],
): { model?: string; effort?: string } {
  const models = runtimeModelOptions(adapter, additionalModels);
  const model = layers.map((layer) => layer?.model?.trim()).find((candidate) => candidate && !runtimeSelectionError(adapter, candidate, undefined, additionalModels))
    ?? models.find(option => option.isDefault)?.id
    ?? [projectProviderModelIdentifier(adapter.defaultModel?.())].find(candidate => candidate &&
      !runtimeSelectionError(adapter, candidate, undefined, additionalModels))
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

export class RetainedNativeAuthenticationError extends Error {}

/** Retained packets without native-mode evidence stay immutable and held. */
export function assertRetainedNativeAuthentication(
  contract: import("@ponderosa/core").RetainedNormalRuntimeContract,
  observed: { state: "known" | "unknown"; authenticated?: boolean; billingMode?: "subscription" | "api"; diagnosticFailure?: unknown },
): void {
  if (!contract.observedBillingMode || observed.state !== "known" || !observed.authenticated ||
      observed.diagnosticFailure || observed.billingMode !== contract.observedBillingMode) {
    throw new RetainedNativeAuthenticationError("Retained native authentication is missing, stale, unknown or incompatible. Session and unfinished work remain held; recheck native sign-in. Historical packets without observed-mode evidence cannot authorize this operation.");
  }
}
