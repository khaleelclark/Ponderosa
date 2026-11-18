import {localMemoryTools} from "./local-memory-catalog.js";
import { createHash } from "node:crypto";
import {
  PONDEROSA_RUNTIME_TOOLS,
  PONDEROSA_HISTORY_TOOL,
  type RuntimeDynamicToolSpec,
  type RetainedNormalRuntimeContract,
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

/** Historical definitions are evidence only; callers must verify the full saved digest. */
export function retainedRuntimeTools(contract: RetainedNormalRuntimeContract | undefined): RuntimeDynamicToolSpec[] | undefined {
  const tools=contract?.dynamicTools;
  if(!Array.isArray(tools)||tools.some(tool=>!tool||typeof tool.name!=="string"||!tool.name.trim()||
    typeof tool.description!=="string"||!tool.inputSchema||typeof tool.inputSchema!=="object"||Array.isArray(tool.inputSchema))||
    new Set(tools.map(tool=>tool.name)).size!==tools.length)return undefined;
  // Manifests use stableJson, while native contract hashes preserve JSON key order.
  // Reconstruct order only; the admission/preparation full digest remains the proof.
  const templates=new Map([...providerDynamicTools(true),PONDEROSA_HISTORY_TOOL].map(tool=>[tool.name,tool]));
  const order=(value:unknown,template:unknown):unknown=>{
    if(Array.isArray(value))return value.map((item,index)=>order(item,Array.isArray(template)?template[index]:undefined));
    if(!value||typeof value!=="object")return value;
    const record=value as Record<string,unknown>,shape=template&&typeof template==="object"&&!Array.isArray(template)?template as Record<string,unknown>:{};
    const keys=[...Object.keys(shape).filter(key=>Object.hasOwn(record,key)),...Object.keys(record).filter(key=>!Object.hasOwn(shape,key))];
    return Object.fromEntries(keys.map(key=>[key,order(record[key],shape[key])]));
  };
  return tools.map(tool=>order(tool,templates.get(tool.name)) as RuntimeDynamicToolSpec);
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
    "Ponderosa Chat/global facts live in Ponderosa's own memory store; other memory services are separate. For Ponderosa memory lookups, use ponderosa_local_memory_search (Claude: mcp__ponderosa__local_memory_search) when advertised; discover that exact tool if deferred. One search with source omitted covers the currently authorized Chat/global scopes together.",
    "Send concise actionable asks/owned results, changed facts, exact decisions/blockers and evidence references. Include needed context without repeating shared instructions, whole reports or boilerplate; keep full evidence in referenced artifacts. Preserve objective, acceptance criteria and handoff state.",
    "After work, ponderosa_reply_stream authorizes one final item on the default/selected Communication/document route or exact attached Request. Finish other routes first; publication.kind=request_update reports correlated results. On rejection publish ordinarily; never duplicate.",
    "For explicitly marked voice Direct Messages, ponderosa_voice_reply may authorize a short acknowledgement before continuing work; only its matched native receipt permits provisional speech, never final delivery. After work call without acknowledgement before the final answer. Use ponderosa_message if unavailable/rejected.",
    "Immediate recipientAgentIds requires intent collaboration; correlated results use ponderosa_update_request. For capability discovery load Ponderosa message specifically, never generic or provider-native SendMessage: only ponderosa_message creates the canonical reply.",
    "Delegate via ponderosa_coordinate({recipientAgentId,text}) or delegations fan-out: one aggregate Join, each_result wakes, parent workflow preserved.",
    "ponderosa_message({delivery:\"next_run\",text,recipientAgentIds}) sends passive one-way information: omit intent; no chat message, Activation, Run, Request, Join, reply obligation or acknowledgement. Omit delivery for immediate communication; coordinate for results/lifecycle.",
    "Finish the whole human objective, respecting later steering and work/verification order. Batch completion is progress. Wait only on real dependencies with a durable wake; create an actionable blocking Decision for a human answer. Never promise later work without a confirmed durable wake.",
    "ponderosa_update_request({text}) completes the sole attached Request with a canonical handoff; {question} asks its original requester, preserving update identity. Use schema kind values: waiting_dependency, never waiting.",
    "Ask the user via ponderosa_decision({question}); options add choices, mode:approval requests permission. Supported provider-native AskUserQuestion/request_user_input callbacks also reach the human; never ask twice. Questions grant no permissions.",
    "For advanced/ambiguous cases provide explicit message intent, request IDs, lifetimes, Join modes, update kinds and idempotency keys. Terminal Request results are final handoffs; no duplicate message/acknowledgment afterward.",
    "Never poll/sleep for another Agent, Request, Join or background state. A short bounded operator-requested delay is allowed as the task. End the turn after creating a Join if no independent work remains.",
    "Create visible workers/reviewers/Agents only via ponderosa_create_managed_agent; disabled provider-native/internal subagents never satisfy Ponderosa Agent/team requests. Discover stable teammate IDs via ponderosa_team_directory({}).",
    "Expose/attach a host-created file through ponderosa_import_file({path}) first; pass its returned artifact ID to ponderosa_browser_upload. Upload never accepts host paths.",
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
