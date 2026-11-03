import type { ConversationDto } from "./dto/conversations.js";
import type { AgentPortablePackageDto } from "./dto/agents.js";
import type { TriggerBudgetPeriod, TriggerSourceConfig, TriggerSourceKind, TriggerScheduleConfig } from "./dto/branch-triggers.js";
import type { DecisionDto, WorkspaceNotificationDto } from "./dto/workspace.js";
/** Branch definitions are desired structure. Runtime records never live in a package. */
/** Local operational policy; never part of portable definitions or execution snapshots. */
export interface BranchExecutionBudgetPolicy { limit: number; period: TriggerBudgetPeriod }
export interface BranchExecutionBudgetDto {
  branchId: string; revision: number; policy: BranchExecutionBudgetPolicy | null;
  used: number; allowance: number; periodId: string | null; periodStartedAt: string | null;
  resetsAt?: string; heldCount: number; observedAt: string;
}
export interface BranchExecutionBudgetUpdate {
  commandKey: string; expectedRevision: number; expectedPeriodId: string | null;
  policy: BranchExecutionBudgetPolicy | null; acknowledgeNewPeriod?: boolean;
}
export interface BranchExecutionBudgetGrant {
  commandKey: string; expectedRevision: number; expectedPeriodId: string; additional: number;
}
export type BranchStateValue = null | boolean | number | string | BranchStateValue[] | {[key:string]:BranchStateValue};
export interface BranchStateChannel {initial:BranchStateValue;reducer:'replace'|'append'|'sum'}
export interface BranchSharedStateDto {revision:number;values:Record<string,BranchStateValue>;evidenceHash:string}
export interface BranchResult { failed: boolean; output?: string; stateUpdate?:{revision:number;updates:Record<string,BranchStateValue>} }
/** Failure output can reach recovery Agents; raw Script streams stay in evidence. */
export function branchScriptFailureSummary(code: number | null | undefined, error?: string): string | undefined {
  return error || (code === undefined || code === 0 ? undefined : code === null
    ? "Script terminated without an exit code. Inspect Step evidence for error output."
    : `Script exited with code ${code}. Inspect Step evidence for error output.`);
}
export interface BranchSealedResultDto {
  id: string; executionId: string; pathId: string; stepExecutionId: string;
  terminalAttemptId: string; result: BranchResult; contentHash: string; createdAt: string;
}
export interface BranchMapItemDto {
  id: string; mapInvocationId: string; mapId: string; index: number; pathId: string;
  input: string; inputHash: string; state: string; result?: BranchResult;
  stepExecutionId?: string; sealedResultId?: string;
  /** Stable per-item attempt summary, independent of paged execution history. */
  attemptCount?: number; firstAttemptAt?: string; lastAttemptAt?: string;
}
export interface BranchMapInvocationDto {
  id: string; mapId: string; parentPathId: string; joinId: string;
  sourceResultId?: string; itemCount: number; itemsHash: string; state: string;
}
/** Navigation hints from the canonical publication validator, never client authority. */
export interface BranchValidationIssue {
  message: string; nodeId?: string; edgeId?: string; templateMemberRef?: string;
  section?: "task" | "agent_setup" | "connections" | "failure" | "advanced" | "workflow" | "settings";
  field?: string;
}
export class BranchValidationError extends Error {
  readonly issue: BranchValidationIssue;
  constructor(message: string, context: Omit<BranchValidationIssue, "message"> = {}) {
    super(message); this.name = "BranchValidationError"; this.issue = { ...context, message };
  }
}
export type BranchFailurePolicy =
  | { action: "stop" }
  | { action: "retry"; maxAttempts: number; delayMs: number; freshContext?: boolean }
  | { action: "ask_human" }
  | { action: "recover"; agentRef: string; maxAttempts: number };
export type BranchTarget =
  | { kind: "persistent_agent" | "persistent_organization"; ref: string }
  | { kind: "ephemeral_agent" | "ephemeral_organization"; templateRef: string };
export interface BranchParameter { type: "text" | "number" | "boolean" | "path" | "secret"; label?: string; help?: string; required?: boolean; default?: string | number | boolean }
export interface BranchLimits { maxCallDepth: number; maxLoopIterations: number; maxTraversals: number }
export type BranchCheckpointMode = 'async' | 'sync' | 'exit';
export interface BranchConfiguration { checkpointMode?: BranchCheckpointMode; parameters: Record<string, string | number | boolean>; limits: BranchLimits; secretBindings?: Record<string, string> }
export interface BranchRuntimeOutcome { kind: "child_canceled" | "limit_exhausted"; limit?: keyof BranchLimits; configured?: number; observed?: number }
interface StepBase { id: string; label?: string; failure?: BranchFailurePolicy; stateWrites?:string[] }
export type BranchStep =
  | (StepBase & { kind: "agent"; target: BranchTarget; instructions: string; requireUserCommunication?: boolean })
  | (StepBase & { kind: "branch_call"; branchRef: string; canceled?: "retry" | "ask_human" | "terminate" })
  | (StepBase & { kind: "script"; runtime: "node"; source: string; cwdRef: string; timeoutMs: number })
  | (StepBase & { kind: "human_gate"; prompt: string; editable: boolean; choices?: string[] })
  | (StepBase & { kind: "action"; action: string; configRefs: string[] });
export type BranchControl =
  | { id: string; label?: string; kind: "condition"; predicate: { source: string; equals: string }; otherwise: string }
  | { id: string; label?: string; kind: "route"; otherwise: string }
  | { id: string; label?: string; kind: "fork"; joinId: string }
  | { id: string; label?: string; kind: "map"; joinId: string; workerId: string; source: "interpret" | "list" | "lines"; maxItems: number; maxConcurrentItems: number }
  | { id: string; label?: string; kind: "join"; forkId: string; mode: "all" | "any" | "quorum"; quorum?: number; remainder: "finish" | "cancel"; inputOrder: string[]; onUnmet?: "fail" | "continue" };
export interface BranchDefinition {
  schema: "ponderosa.branch.v1";
  name: string;
  trigger: { kind: "manual" } | { kind: "schedule" | "webhook" | "filesystem"; configRef: string };
  parameters?: Record<string, BranchParameter>;
  state?:Record<string,BranchStateChannel>;
  templates?: Record<string, AgentPortablePackageDto>;
  entry: string;
  steps: BranchStep[];
  controls: BranchControl[];
  edges: Array<{ id: string; from: string; to: string; on: "success" | "failure" | "approved" | "rejected" | "selected" | "canceled"; choice?: string; loop?: boolean; input?: { kind: "literal"; text: string } | { kind: "output" } }>;
  policy: { maxConcurrentExecutions: number; maxPathInstances?: number; maxStepInvocations?: number; maxEphemeralAgents?: number; failure: BranchFailurePolicy };
}
/** Local-only bindings. Portable definitions contain refs, never host paths/Agent IDs. */
export interface BranchBindings {
  branches?: Record<string, string>;
  agents: Record<string, string>;
  directories: Record<string, string>;
  engines?: Record<string, string>;
  triggers?: Record<string, { sourceConfig: TriggerSourceConfig; enabled: boolean }>;
}
export type BranchExecutionState = "queued" | "running" | "waiting" | "completed" | "failed" | "canceled" | "skipped" | "merged";
export type BranchAttemptState = "prepared" | "leased" | "running" | "waiting" | "completed" | "failed" | "canceled" | "outcome_unknown";
export interface BranchVersionDto { id: string; branchId: string; hash: string; definition: BranchDefinition; createdAt: string }
export type BranchVersionSummaryDto = Omit<BranchVersionDto, "definition">;
/** Mutually exclusive current activity of all nonterminal workflow Runs. */
export interface BranchRunCountsDto {running:number;waiting:number;queued:number}
export interface BranchDto {
  /** Canonical last use, supplied by directory reads. Creation is the fallback. */
  lastUsedAt?: string;
 id: string; chatId: string; enabled?: boolean; name: string; versionId: string; bindingRevisionId: string;
 triggerId?: string; triggerEnabled?: boolean; activeExecutions?: number; runCounts?:BranchRunCountsDto; createdAt: string;
}
export interface BranchCheckpointInvocationDto {
  id:string; mode:BranchCheckpointMode; state:'active'|'interrupting'|'interrupted'|'terminal';
  interruptionId?:string; primaryOutcome?:string; durability:'pending'|'coalesced'|'saved'|'failed'|'coverage_unknown'|'suppressed';
  requiredWatermark?:number; savedSnapshotId?:number; savedContentHash?:string; lastSavedSnapshotId?:number;
}
export interface BranchExecutionDto {
  runtimeData?:{planId:string;sourceExecutionId:string;manifestSha256:string;held:true;currentAuthority:false};
  checkpointInvocation?:BranchCheckpointInvocationDto;
  id: string; branchId: string; versionId: string; bindingRevisionId: string;
  parentExecutionId?: string; parentAttemptId?: string; callDepth?: number; configuration?: BranchConfiguration;
  occurrenceKey: string; input: string; inputHash: string; state: BranchExecutionState;
  /** Canonical Engine budget flag; never inferred from Step output text. */
  budgetExhausted?: boolean;
  admissionSource?: 'manual' | 'automatic' | 'call';
  admittedAt?: string;
  budgetWait?: {kind:'execution_budget'; branchId:string};
  waitReason?: string; output?: string; mergedInto?: string; revision: number;
  createdAt: string; updatedAt: string;
}
export interface BranchStepExecutionDto {
  id: string; executionId: string; stepId: string; pathId: string; invocation: number;
  state: BranchAttemptState; input: string; result?: BranchResult; sealedResultId?: string;
}
export interface BranchAttemptDto {
  id: string; stepExecutionId: string; number: number; state: BranchAttemptState;
  requestId?: string; fence: number; leaseOwner?: string; leaseUntil?: string;
  outcome?: BranchRuntimeOutcome; childExecutionId?: string;
  createdAt?: string; updatedAt?: string;
  calledBranch?: {id:string;name:string;enabled:boolean};
  childExecution?: {id:string;state:BranchExecutionState;versionId?:string};
  scriptEvidence?: {stderr?:string;stdout?:string;code?:number|null;error?:string;outputHash?:string;cwd?:string;runtime?:string;finishedAt?:string};
  error?: string; retryBlockedReason?: string; requestOutcomeUnknown?: boolean; availableAt?: string; purpose?: "step" | "recovery"; result?: BranchResult;
}
/** Exact current Attempt → started scheduler Run association, not execution authority. */
export interface BranchLiveOutputDto {
  attemptId:string; stepId:string; agentId:string; projectId:string; runId:string;
}
export interface BranchExecutionDetailDto {
  /** Live telemetry targets for this bounded history page. */
  liveOutputs?:BranchLiveOutputDto[];
  execution: BranchExecutionDto; steps: BranchStepExecutionDto[]; attempts: BranchAttemptDto[];
  paths: BranchPathDto[]; gates: BranchGateDto[]; resources: BranchResourceDto[];
  sealedResults?: BranchSealedResultDto[]; maps?: BranchMapInvocationDto[]; mapItems?: BranchMapItemDto[];
  waits?: BranchWaitDto[];
  decisions?: BranchDecisionDto[];
  /** Large evidence is previewed here; inspect one Step to load its complete text. */
  largeEvidenceOmitted?: boolean;
  executionOutputTruncated?: boolean; executionInputTruncated?: boolean;
  /** Opaque cursor for older audit rows. Each collection is independently bounded. */
  nextCursor?: string;
}
export interface BranchStepEvidenceDto {
  stepExecutionId: string;
  input: string;
  result?: BranchResult;
  attempts: BranchAttemptDto[];
  sealedResult?: BranchSealedResultDto;
}
/** Focused current decisions and failed/uncertain attempts, independent of audit-history pages. */
export type BranchExecutionActionDto =
  | { kind: 'schedule_update'; occurrenceId: string; injectionId: string; eventCount: number; lastScheduledAt: string }
  | { kind: 'decision'; decision: DecisionDto }
  | { kind: 'gate'; gate: BranchGateDto; step: BranchStepExecutionDto }
  | { kind: 'attempt'; attempt: BranchAttemptDto; step: BranchStepExecutionDto; current: boolean };
export interface BranchExecutionActionsDto {
  executionId: string;
  revision: number;
  /** Canonical checkpoint/Request observation; decisions can change without a Run-state revision. */
  generation: string;
  items: BranchExecutionActionDto[];
  /** Attempt/Step text uses the ordinary bounded preview; full evidence remains explicit. */
  largeEvidenceOmitted?: boolean;
  /** Execution/revision-bound continuation; older failure evidence remains explicitly paged. */
  nextCursor?: string;
}
/** Read-only explanations projected from canonical workflow records. */
export interface BranchWaitDto {
  kind:'execution_budget'|'child'|'disabled_branch'|'approval'|'retry'|'join'|'agent'|'capacity'|'cleanup'|'reconciliation'|'operation';
  message:string; stepId?:string; requestId?:string; branchId?:string; executionId?:string; availableAt?:string;
}
export interface BranchOperationalSummaryDto {
  executionId: string;
  state: "queued" | "running" | "waiting_agent" | "waiting_human" | "retrying" | "provider_unavailable" | "provider_attention" | "needs_reconciliation" | "blocked" | "completed" | "failed" | "canceled" | "skipped" | "merged";
  label: string; observedAt: string;
  counts: { completed:number; running:number; retrying:number; failed:number; waitingAgent:number; waitingHuman:number; needsReconciliation:number; mapItems:number; mapSettled:number };
  agentWaits: Array<{requestId:string;agentId:string;agentName:string;engineId?:string;state:"waiting_agent"|"agent_busy"|"agent_running"|"waiting_dependency"|"waiting_human"|"provider_retry"|"retry_pending"|"provider_unavailable"|"provider_attention";label:string;since:string;reason?:string;nextRetryAt?:string}>;
  additionalAgentWaits: number;
}
/** Bounded Home metadata; full inputs, outputs and audit history stay in execution inspection. */
export interface BranchHomeExecutionDto {
  id: string; branchId: string; branchName: string; parentExecutionId?: string;
  state: BranchExecutionState; createdAt: string; updatedAt: string;
  operational: Pick<BranchOperationalSummaryDto, "state" | "label">;
}
export interface BranchHomeDto {
  observedAt: string; workflowCount: number; activeExecutionCount: number; openActionCount: number;
  activeExecutions: { items: BranchHomeExecutionDto[]; nextCursor?: string };
  recentOutcomes: { items: BranchHomeExecutionDto[]; nextCursor?: string };
  attention: { items: WorkspaceNotificationDto[]; nextCursor?: string };
  /** Names for this bounded attention page, resolved by canonical Branch ID. */
  branchNames: Record<string, string>;
}
export interface BranchDecisionDto { id:string; kind:string; nodeId?:string; failed?:boolean; message:string; at:string }
export interface DeployBranchRequest {
  chatId: string; branchId?: string; expectedVersionId?: string;
  idempotencyKey: string; definition: BranchDefinition; bindings: BranchBindings;
}

export interface BranchPathDto {
  id: string; parentPathId?: string; forkInvocationId?: string; edgeId?: string;
  nodeId?: string; stepExecutionId?: string; state: string; input: string; result?: BranchResult; lastResultId?: string;
}
export interface BranchGateDto {
  id: string; stepExecutionId: string; attemptId: string; state: "waiting" | "resolved" | "canceled";
  purpose: "approval" | "recovery"; revision: number; proposal: string; choices?: string[]; openedAt?: string;
  prompt: string; editable: boolean; resolution?:BranchGateResolution;
}
export interface BranchGateResolution {
  commandKey: string; expectedRevision: number;
  decision: "approve" | "reject" | "retry"; output?: string; choice?: string;
}
export interface BranchIntervention {
  commandKey: string; expectedRevision: number; action: "retry" | "resolve_script" | "resolve_schedule_update" | "skip" | "merge";
  attemptId?: string; result?: BranchResult; mergedInto?: string; occurrenceId?: string; updateApplied?: boolean;
  externalEffectsReconciled?: boolean; reason: string;
}

export type DeployBranchResponse = BranchDto;

export interface BranchRequirementsDto { agents: string[]; directories: string[]; engines: string[]; triggers: string[] }
export interface BranchPackageDto { schema: "ponderosa.branch-package.v1"; exportedAt: string; definition: BranchDefinition }
export interface BranchDeploymentPreviewDto {
  definitionHash: string; requirements: BranchRequirementsDto;
  operations: Array<{ kind: "create" | "update" | "detach" | "unchanged"; resource: string; ref: string; before?: string; after?: string }>;
  notes: string[];
}
export interface BranchResourceDto { stepExecutionId: string; templateRef: string; state: string; rootAgentId?: string; agentIds: string[]; error?: string }

export interface BranchContextDto extends ConversationDto { workingDirectory:string; defaultEngine:string }

export type BranchPackageChat={executionRef?:string;ref:string;title:string;instructions?:string;agents:Array<{ref:string;managerRef?:string;definition:AgentPortablePackageDto}>};
/** Closed selected filesystem data; owners refer to logical Agents, never new carrier Agents. */
export interface BranchPortableWorkingData {
 schema:'ponderosa.branch-working-data.v1';package:AgentPortablePackageDto;
 owners:Record<string,{chatRef:string;agentRef:string}>;sha256:string;
}
export interface InstalledBranchPackage {
 schema:'ponderosa.branch-installation.v1';packageId:string;mode:'template'|'full';exportedAt:string;
 workingData?:BranchPortableWorkingData;
 definition:BranchDefinition;chats:BranchPackageChat[];agentBindings:Record<string,{chatRef:string;agentRef:string}>;
 limits:BranchLimits;parameters?:Record<string,string|number|boolean>;
 triggers?:BranchBindings['triggers'];engines?:BranchBindings['engines'];
 outputRoles?:Array<{chatRef:string;agentRef:string;output:boolean;speaker:boolean}>;
 runtimeData?:BranchPortableRuntimeData;
 definitionTree?:BranchPortableDefinitionTree;
 executionTree?:BranchPortableExecutionTree;
}

/** Full dependency closure, optionally paired with held execution data. Chat refs are globally unique. */
export interface BranchPortableDefinitionNode {
 sourceBranchId:string;sourceVersionId:string;sourceBindingRevisionId:string;packageId:string;
 definition:BranchDefinition;agentBindings:InstalledBranchPackage['agentBindings'];chatRefs:string[];
 limits:BranchLimits;parameters?:Record<string,string|number|boolean>;triggers?:BranchBindings['triggers'];engines?:BranchBindings['engines'];
 configuration:BranchConfiguration;dependencies:Record<string,string>;
}
export interface BranchPortableDefinitionTree {rootSourceBranchId:string;packageSha256:string;nodes:BranchPortableDefinitionNode[];sha256:string}
export interface BranchDefinitionTreeReceipt {
 manifestSha256:string;branchMap:Record<string,string>;chatMap:Record<string,string>;agentMap:Record<string,string>;
 nodes:Record<string,{sourceVersionId:string;sourceBindingRevisionId:string;branchId:string;versionId:string;bindingRevisionId:string;definition:BranchDefinition;bindings:BranchBindings;configuration:BranchConfiguration;packageId:string;chatRefs:string[]}>;
 executionOwners:number;currentAuthority:false;dispatched:false;workflowEnabled:false;
}

/** Private evidence bytes never carry dispatch, grants, leases or provider ownership. */
export interface BranchPortableRuntimeFact {kind:'frontier'|'definition'|'bindings'|'configuration'|'provenance'|'host'|'initial'|'checkpoint'|'transition'|'command'|'custody'|'import'|'trigger'|'tree-import'|'continuation'|'tree-continuation'|'acceptance';key:string;json:string;sha256:string}
export interface BranchPortableRuntimeOwner {sourceExecutionId:string;sourceBranchId:string;chatRefs:string[];facts:BranchPortableRuntimeFact[];sha256:string}
export interface BranchPortableRuntimeData {schema:'ponderosa.branch-runtime-data.v1';sourceBranchId:string;identities:{chats:Record<string,string>;agents:Record<string,{chatRef:string;agentRef:string}>};owners:BranchPortableRuntimeOwner[];sha256:string}
export interface BranchPortableExecutionTree {schema:'ponderosa.branch-runtime-tree.v1';rootSourceBranchId:string;branches:Record<string,BranchPortableRuntimeData>;sha256:string}
export interface BranchRuntimeTreePlan {reservedFrontiers:Record<string,Record<string,string>>;executionMap:Record<string,string>;frontiers:Record<string,BranchRuntimeFrontierReceipt>}
export interface BranchRuntimeTreeReceipt extends BranchRuntimeTreePlan {schema:'ponderosa.branch-runtime-tree-import.v1';ownerPins:Record<string,{versionId:string;bindingRevisionId:string}>;planId:string;rootBranchId:string;manifestSha256:string;branchMap:Record<string,string>;chatMap:Record<string,string>;agentMap:Record<string,string>;held:true;currentAuthority:false;dispatched:false}
export interface BranchRuntimeTreeReadback {receipt:BranchRuntimeTreeReceipt;data:BranchPortableExecutionTree}
export interface BranchRuntimeFrontierReceipt {disposition:'recreated_held'|'evidence_only';idMap:Record<string,string>;reason?:string}
export interface BranchRuntimeDataReceipt {schema:'ponderosa.branch-runtime-import.v1';planId:string;branchId:string;manifestSha256:string;frontiers:Record<string,BranchRuntimeFrontierReceipt>;executionMap:Record<string,string>;chatMap:Record<string,string>;agentMap:Record<string,string>;disposition:'held';currentAuthority:false;dispatched:false;workflowEnabled:false;credentials:'reenter';nativeState:'not_adopted';createdAt:string}
export interface BranchRuntimeDataReadback {receipt:BranchRuntimeDataReceipt;data:BranchPortableRuntimeData}

export interface BranchLifecycleDto {
 sourceDiagnostics?:Array<{id:string;title:string;body:string;createdAt:string}>;
 deleting:boolean;
 chats:number;
 activeExecutions:number;
 runCounts?:BranchRunCountsDto;
 callers:Array<{id:string;name:string}>;
 pendingRemoval:Array<{id:string;kind:'Chat'|'Agent';error?:string}>;
 updates:Array<{id:string;error?:string}>;
}

export interface BranchInstallationOperationDto {kind:string;resource:string;label:string;before?:unknown;after?:unknown}
export interface BranchFullImportAgentReviewDto {
 chat:string;agent:string;mode:'template'|'full';initialInstructions:{bytes:number;preview?:string;truncated:boolean};
 history:{messages:number;bytes:number;roles:{user:number;assistant:number;system:number}};
 artifacts:{count:number;bytes:number;items:Array<{name:string;kind:string;mediaType:string;bytes:number}>};
}
export interface BranchMemoryUpdateSelectionDto {newAgents:Array<{chatRef:string;agentRef:string}>;teamChats:string[]}
export interface BranchMemoryUpdateReviewDto {selection:BranchMemoryUpdateSelectionDto;incoming:Array<{chatRef:string;agentRef:string;snapshot:import('./dto/agents.js').PortableChatMemorySnapshotDto}>;destination:import('./dto/agents.js').PortableChatMemorySnapshotDto[];excludedRows:number}
export interface BranchInstallationPreviewDto {id:string;definitionTreeReview?:{manifestSha256:string;reviewSha256:string;branches:number;bindings:Record<string,BranchBindings>};memoryUpdateReview?:BranchMemoryUpdateReviewDto;outputRoleReview?:import('./dto/agents.js').OutputRoleImportReviewDto;operations:BranchInstallationOperationDto[];runtimeDataReview?:{manifestSha256:string;owners:number;facts:number;disposition:'held';currentAuthority:false};fullImportReview?:{mode:'full';warning:string;agents:BranchFullImportAgentReviewDto[]}}

/** Scoped picker context comes from canonical membership, independent of search pagination. */
export type BranchAgentChoiceDto = import('./dto/agents.js').AgentDto & { hasTeam:boolean; chatTitle:string; managerTitle?:string };

/** A stable output URL projects the existing Agent and workflow, without a second chat log. */
export interface OutputAgentAppDto {
  agentId: string; branchId: string; projectId: string; chatId: string; title: string;
  url: string; speaker: boolean; versionId: string; bindingRevisionId:string; settingsRevision:string; model?: string; engine: string;
  runtimeSettings: import('./dto/agents.js').AgentRuntimeSettingsSnapshot;
  automatic: boolean; triggerKind: 'manual' | TriggerSourceKind; schedule?: TriggerScheduleConfig; everyMs?: number;
}
export interface AssistantStatusDto { enabled: boolean; initialized: boolean; app?: OutputAgentAppDto; setupError?:{message:string;at:string} }

/** Before-entry checkpoint; saved historical frontiers use the separate continuation contract. */
export interface BranchInitialCheckpointDto {
  id:number; executionId:string; branchId:string; contentHash:string; createdAt:string;
  frontier:'before_entry'; restoreSupported:boolean;
  eligibility:'canceled_before_start_with_unchanged_pins';
}

/** Saved historical frontier; unsupported dependencies stay explicit. */
export interface BranchHistoricalCheckpointDto {
  id:number; executionId:string; branchId:string; contentHash:string; restoreSupported:boolean;
  eligibility:'script_control_frontier'|'unsupported_dependency';
}

/** Operator-only historical evidence; never a runnable provider checkpoint. */
export interface BranchHostRequestSelection {
  checkpointId:number; expectedHash:string; requestId:string;
}
export interface BranchHostRequestReviewDto {
  source:BranchHostRequestSelection & {branchId:string;executionId:string};
  reviewHash:string;
  request:{projectId:string;conversationId:string;recipientAgentId:string;requesterAgentId?:string;state:string;version:number;payload:unknown};
  updates:{id:string;kind:string;inReplyToUpdateId?:string;version:number;state:string;payload:unknown}[];
  artifacts:{id:string;sha256:string;byteLength:number}[];
  current:{requestState:string;requestVersion:number;versionId:string;versionChanged:boolean;bindingRevisionId:string;bindingSha256:string;bindingsChanged:boolean;configurationChanged:boolean;configuration:Omit<BranchConfiguration,'secretBindings'>;recipientRestrictions:string[];requiredSecretRefs:string[]};
}
export interface BranchHostRequestAdoption extends BranchHostRequestSelection {
  reviewHash:string;commandKey:string;instruction:string;mode:'reconcile'|'independent';
  acknowledgeChangedBindings?:boolean;acknowledgeSecretBindings?:boolean;
}
/** Whole retained graph. Review remains operator-only and checks every original audience. */
export interface BranchHostGraphReviewDto {
 checkpointId:number;checkpointHash:string;reviewHash:string;
 requests:BranchHostRequestReviewDto[];
 joins:{id:string;ownerAgentId:string;state:string;mode:string;quorum:number;memberRequestIds:string[];continuationRequestIds:string[]}[];
}
export interface BranchHostGraphRestoreInput {
 checkpointId:number;expectedHash:string;reviewHash:string;commandKey:string;reconcileEffects:true;
}
export interface BranchHistoricalRewindInput {
 checkpointId:number;expectedHash:string;commandKey:string;
 /** Required together for an issued-Request prefix, after host-graph-review. */
 graphReview?:{reviewHash:string;reconcileEffects:true};
}
export interface BranchHostGraphRestoreDto {
 restorationId:string;checkpointId:number;checkpointHash:string;
 requestMap:Record<string,string>;updateMap:Record<string,string>;joinMap:Record<string,string>;replayed:boolean;
}
export interface BranchHostRequestAdoptionDto {
  requestId:string;sourceRequestId:string;checkpointId:number;checkpointHash:string;reviewHash:string;replayed:boolean;
}

/** Explicit reviewed recovery destinations and optional live activation per JSON.stringify([chatRef,agentRef]). */
export interface BranchImportFileSelection {workingFilesDestination?:string;workingRootDestinations?:Record<string,string>;workingFilesActivation?:{sharedRoot?:string};reviewedUserDataActivation?:import('./portable-reviewed-user-data.js').ReviewedUserDataActivation;reviewedMetadataActivation?:import('./portable-reviewed-user-data.js').ReviewedMetadataActivation;newManagedChatFolderName?:string}
export type BranchImportFileSelections=Record<string,BranchImportFileSelection>;
export type BranchExportFileSelections=Record<string,{selectedWorkingFiles?:string[];wholeWorkingFolder?:boolean;reviewedUserData?:import('./portable-reviewed-user-data.js').ReviewedUserDataSelection;gitStorageBindings?:import('./portable-reviewed-user-data.js').GitStorageSelection[]}>;

/** Partial group capture cannot release any custody or cleanup pin. */
export interface BranchIssuedGroupCaptureStatus {
 state:'capturing'|'retained';cleanupHeld:boolean;abandonment:'unsupported';disposition?:'abandoned';
 sources:{checkpointId:string;resourceStepId:string;sourceChatId:string;sealed:boolean}[];
 checkpointId?:number;checkpointHash?:string;
}
export interface CheckpointPackageSource {
  checkpointId:string;
  sourceChatId:string;
  agentIds:string[];
  intent:{executionId:string;resourceStepId:string;resourceGeneration:number;frontierSha256:string;bindingSha256:string;configurationSha256:string;hostCutSha256?:string};
}
export interface CheckpointPackageReceipt extends CheckpointPackageSource {
  version:1;
  custodyId:string;
  boundaryId:string;
  sha256:string;
  byteLength:number;
}
export type CheckpointPackageStatus=
  | {state:'missing'}
  | {state:'retained';receipt:CheckpointPackageReceipt}
  | {state:'capturing';source:CheckpointPackageSource;boundaryId:string}
  | {state:'failed';source:CheckpointPackageSource;boundaryId:string;reason:string}
  | {state:'released';receipt:CheckpointPackageReceipt};

/** Operator-only resource identity; receiptSha256 hashes the complete canonical receipt. */
export interface BranchResourceInspectionDto {
 branchId:string;executionId:string;stepExecutionId:string;generation:number;state:string;destinationChatId:string|null;destinationChatAvailable:boolean;importState:string|null;
 custody:null|{kind:'capture'|'restoration_source';state:'capturing'|'retained'|'releasing'|'released'|'restoration_source';custodyId:string|null;receiptSha256:string|null;checkpointId:string;packageSha256:string|null};
 currentPolicyReview:import('./dto/agents.js').AgentAccessImportReviewDto|null;
 accessChoiceCurrent:boolean;reviewError?:string;
}
export interface BranchResourceCustodyReleaseInput {
 commandKey:string;expectedGeneration:number;expectedCustodyId:string;expectedReceiptSha256:string;
}
export interface BranchResourceCustodyReleaseDto {
 commandKey:string;stepExecutionId:string;generation:number;custodyId:string;receiptSha256:string;state:'releasing'|'released';error?:string;
}
export type BranchResourceCustodyReleaseStatus=BranchResourceCustodyReleaseDto|{commandKey:string;state:'not_found'};

/** Operator-only issued private-byte capture; this is not restoration admission. */
export interface BranchIssuedResourceCaptureInput {commandKey:string;expectedGeneration:number;expectedReviewHash?:string}
export type BranchCaptureRetryBudget = {state:'unavailable';reason:'missing_saved_retry_proof'} | {state:'verified';consumedAttempts:number;maxAttempts:number;evidenceHash:string};
export interface BranchIssuedResourceCaptureDto {historyKind?:'serial'|'local_parallel';retryBudget?:BranchCaptureRetryBudget;consumedAttempts?:number;maxAttempts?:number;commandKey:string;generation?:number;reviewHash?:string;state:'not_found'|'capturing'|'retained';checkpointId?:number;checkpointHash?:string;receipt?:CheckpointPackageReceipt;historicalPartition?:import('./coordination-destination.js').CoordinationHistoricalGenerationSelection[];historicalReviewHash?:string;restoreSupported:false}

/** Operator-only audit discovery. Legacy capture keys cannot be recovered from hashes. */
export interface BranchGroupDiscoveryItem {
 kind:'captures'|'admissions';branchId:string;executionId:string;commandKey?:string;
 auditSelection?:import('./lifecycle-reconciliation.js').GroupJournalAuditSelection;
 discovery:'exact'|'unsupported_legacy_key';state:string;ownerPresent:boolean;
 admissionId?:string;checkpointId?:number;checkpointHash?:string;reviewHash?:string;versionId?:string;resourceCount:number;
}
export interface BranchGroupDiscoveryPage {items:BranchGroupDiscoveryItem[];nextCursor?:string}
export interface BranchGroupCapturePreview {
 reviewHash:string;versionId:string;bindingRevisionId:string;frontierHash:string;hostCutHash:string;
 resources:{resourceStepId:string;sourceChatId:string;generation:number;agentIds:string[]}[];
}
export interface BranchGroupCaptureInput {commandKey:string;reviewHash:string;versionId:string}
export interface BranchGroupCaptureResult {state:'retained';checkpointId:number;checkpointHash:string;receipts:CheckpointPackageReceipt[]}

/** Evidence-only parent/child producer; the dedicated reviewed group consumer owns admission. */
export interface BranchTreeGroupCapturePreview {
 reviewHash:string;versionId:string;currentAuthority:false;actionEligible:false;
 owners:{executionId:string;branchId:string;resourceStepId:string;sourceChatId:string;agentIds:string[]}[];
}
export interface BranchTreeGroupCaptureStatus {
 state:'capturing'|'retained';reviewHash:string;versionId:string;currentAuthority:false;actionEligible:false;
 checkpointId?:number;checkpointHash?:string;
 sources:{executionId:string;resourceStepId:string;sourceChatId:string;sealed:boolean}[];
}

export interface BranchGenerationOnePreview {
 historyKind?:'serial'|'local_parallel';
 reviewHash:string;historicalReviewHash:string;generation:1;
 historicalPartition:import('./coordination-destination.js').CoordinationHistoricalGenerationSelection[];
}

/** Exact server-selected complete prior-generation chain; no caller-authored selectors. */
export interface BranchGenerationHistoryPreview {
 historyKind:'serial'|'local_parallel';
 reviewHash:string;historicalReviewHash:string;generation:number;consumedAttempts:number;maxAttempts:number;
 historicalPartition:import('./coordination-destination.js').CoordinationHistoricalGenerationSelection[];
}

/** Human-only continuation of a private imported Script cut; never import authority. */
export interface BranchForeignContinuationSelection {planId:string;sourceExecutionId:string;checkpointKey:string;checkpointSha256:string}
export interface BranchForeignTreeBranchReview {
 branchId:string;versionId:string;bindingRevisionId:string;configurationRevision:number;definition:BranchDefinition;bindings:BranchBindings;configuration:BranchConfiguration;
 directoryChoices:BranchForeignContinuationReview['directoryChoices'];capabilityPolicy:unknown;budget:BranchExecutionBudgetDto;
}
export interface BranchForeignContinuationReview {
 schema:'ponderosa.branch-foreign-review.v1';selection:BranchForeignContinuationSelection;branchId:string;importedExecutionId:string;
 generationChain?:Array<{manifestSha256:string;ownerSha256:string;executionId:string}>;
 gates?:{selected:BranchGateDto[];latest:BranchGateDto[]};
 tree?:{branches:BranchForeignTreeBranchReview[];owners:Array<{sourceExecutionId:string;branchId:string;selectedState:string;gates?:BranchForeignContinuationReview['gates'];sharedState?:BranchForeignContinuationReview['sharedState']}>};
 sharedState?:{channels:NonNullable<BranchDefinition['state']>;selected:BranchSharedStateDto;latest:BranchSharedStateDto};controls?:BranchDefinition['controls'];
 manifestSha256:string;ownerSha256:string;checkpoint:unknown;nativeMaps:BranchRuntimeDataReceipt|BranchRuntimeTreeReceipt;
 versionId:string;bindingRevisionId:string;configurationRevision:number;definitionSha256:string;bindings:BranchBindings;configuration:BranchConfiguration;
 directoryChoices:Record<string,{path:string;realpath:string;device:number;inode:number}>;capabilityPolicy:unknown;budget:BranchExecutionBudgetDto;custody:'not_applicable';engine:'node';secretChoice:'none';accessChoice:'current_destination';reviewSha256:string;
}
export interface BranchForeignContinuationInput extends BranchForeignContinuationSelection {commandKey:string;reviewSha256:string;acceptCurrentAuthority:true}
export interface BranchForeignContinuationReceipt {
 schema:'ponderosa.branch-foreign-continuation.v1';branchId:string;importedExecutionId:string;executionId:string;
 commandKey:string;inputSha256:string;review:BranchForeignContinuationReview;idMap:Record<string,string>;admission:unknown;treeOwners?:Record<string,{executionId:string;admission:unknown}>;createdAt:string;
}
