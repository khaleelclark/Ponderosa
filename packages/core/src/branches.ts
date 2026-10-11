import type { ConversationDto } from "./dto/conversations.js";
import type { AgentPortablePackageDto } from "./dto/agents.js";
import type { TriggerBudgetPeriod, TriggerSourceConfig } from "./dto/triggers.js";
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
export interface BranchResult { failed: boolean; output?: string }
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
export interface BranchConfiguration { parameters: Record<string, string | number | boolean>; limits: BranchLimits; secretBindings?: Record<string, string> }
export interface BranchRuntimeOutcome { kind: "child_canceled" | "limit_exhausted"; limit?: keyof BranchLimits; configured?: number; observed?: number }
interface StepBase { id: string; label?: string; failure?: BranchFailurePolicy }
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
export interface BranchDto {
 id: string; chatId: string; enabled?: boolean; name: string; versionId: string; bindingRevisionId: string;
 triggerId?: string; triggerEnabled?: boolean; activeExecutions?: number; createdAt: string;
}
export interface BranchExecutionDto {
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
export interface BranchExecutionDetailDto {
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
  commandKey: string; expectedRevision: number; action: "retry" | "resolve_script" | "skip" | "merge";
  attemptId?: string; result?: BranchResult; mergedInto?: string;
  externalEffectsReconciled?: boolean; reason: string;
}

export interface DeployBranchResponse extends BranchDto { /** One-time webhook secret; never included in a replay or package. */ webhookSecret?: string }

export interface BranchRequirementsDto { agents: string[]; directories: string[]; engines: string[]; triggers: string[] }
export interface BranchPackageDto { schema: "ponderosa.branch-package.v1"; exportedAt: string; definition: BranchDefinition }
export interface BranchDeploymentPreviewDto {
  definitionHash: string; requirements: BranchRequirementsDto;
  operations: Array<{ kind: "create" | "update" | "detach" | "unchanged"; resource: string; ref: string; before?: string; after?: string }>;
  notes: string[];
}
export interface BranchResourceDto { stepExecutionId: string; templateRef: string; state: string; rootAgentId?: string; agentIds: string[]; error?: string }

export interface BranchContextDto extends ConversationDto { workingDirectory:string; defaultEngine:string }

export type BranchPackageChat={ref:string;title:string;instructions?:string;agents:Array<{ref:string;managerRef?:string;definition:AgentPortablePackageDto}>};
export interface InstalledBranchPackage {
 schema:'ponderosa.branch-installation.v1';packageId:string;mode:'template'|'full';exportedAt:string;
 definition:BranchDefinition;chats:BranchPackageChat[];agentBindings:Record<string,{chatRef:string;agentRef:string}>;
 limits:BranchLimits;parameters?:Record<string,string|number|boolean>;
 triggers?:BranchBindings['triggers'];engines?:BranchBindings['engines'];
}

export interface BranchLifecycleDto {
 deleting:boolean;
 chats:number;
 activeExecutions:number;
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
export interface BranchInstallationPreviewDto {id:string;operations:BranchInstallationOperationDto[];fullImportReview?:{mode:'full';warning:string;agents:BranchFullImportAgentReviewDto[]}}
