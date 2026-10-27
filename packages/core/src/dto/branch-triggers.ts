// Branch workflow trigger contracts. Main-product Agent Automations remain retired.

export type TriggerSourceKind = "schedule" | "webhook" | "filesystem";
export type TriggerOccurrenceState = "pending" | "activated" | "cancelled" | "dead_lettered";

export type TriggerScheduleConfig =
  | { scheduleKind: "once"; at: string }
  | { scheduleKind: "interval"; everyMs: number; startsAt: string }
  | { scheduleKind: "cron"; expression: string; timezone: string };

export interface TriggerWebhookConfig {
  replayWindowSeconds: number;
}

export interface TriggerFilesystemConfig {
  include: string[];
  exclude: string[];
  quietMs: number;
  maxWindowMs: number;
}

export type TriggerSourceConfig = TriggerScheduleConfig | TriggerWebhookConfig | TriggerFilesystemConfig;

export interface TriggerDefinitionDto {
  id: string;
  projectId: string;
  /** The optional legacy Chat binding of this Branch workflow. */
  conversationId: string;
  /** Direct Agent destinations are not supported. */
  targetAgentId?: never;
  /** The Branch that owns the workflow trigger. */
  branchId: string;
  name: string;
  /** Operator-authored trusted instructions, kept separate from occurrence payloads. */
  instructions: string;
  sourceKind: TriggerSourceKind;
  sourceConfig: TriggerSourceConfig;
  enabled: boolean;
  /** V3.2 runs with the Agent's full local authority. */
  fullAccess: true;
  /** Optional limit on automatic root Runs for the current period. Undefined is unlimited. */
  runBudget?: TriggerRunBudgetDto;
  budgetState?: TriggerRunBudgetStateDto;
  nextFireAt?: string;
  lastFiredAt?: string;
  webhookPath?: string;
  secretFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTriggerRequest {
  conversationId: string;
  targetAgentId?: never;
  /** The Branch that owns the workflow trigger. */
  branchId: string;
  name: string;
  instructions: string;
  sourceKind: TriggerSourceKind;
  sourceConfig: TriggerSourceConfig;
  enabled?: boolean;
  runBudget?: TriggerRunBudgetDto;
}

/** Operator-reviewed authority, excluding fire times and budget consumption telemetry.
 * Null explicitly represents an absent destination alternative or configured budget. */
export interface ReviewedTriggerDefinition {
  id: string;
  projectId: string;
  conversationId: string;
  targetAgentId: string | null;
  branchId: string | null;
  name: string;
  instructions: string;
  sourceKind: TriggerSourceKind;
  sourceConfig: TriggerSourceConfig;
  enabled: boolean;
  fullAccess: true;
  runBudget: TriggerRunBudgetDto | null;
}

export interface RunTriggerRequest {
  confirmDisabled?: boolean;
  reviewedDefinition?: ReviewedTriggerDefinition;
}

export interface UpdateTriggerRequest {
  reviewedDefinition?: ReviewedTriggerDefinition;
  conversationId?: string;
  targetAgentId?: never;
  name?: string;
  instructions?: string;
  sourceConfig?: TriggerSourceConfig;
  enabled?: boolean;
  runBudget?: TriggerRunBudgetDto | null;
}

export type TriggerBudgetPeriod = "day" | "week" | "month" | "lifetime";
export interface TriggerRunBudgetDto { limit: number; period: TriggerBudgetPeriod }
export interface TriggerRunBudgetStateDto {
  used: number;
  allowance: number;
  periodStartedAt: string;
  periodEndsAt?: string;
  held: boolean;
}

export interface CreateTriggerResponse {
  trigger: TriggerDefinitionDto;
  /** Returned once for webhook Triggers. It is never exposed by subsequent reads. */
  webhookSecret?: string;
}

export interface RunTriggerResponse {
  occurrenceId: string;
  activationId?: string;
  state: TriggerOccurrenceState;
  replayed: boolean;
}

export interface TriggerOccurrenceDto {
  id: string;
  artifactId: string;
  triggerId: string;
  projectId: string;
  agentId?: never;
  branchId: string;
  branchExecutionId?: string;
  state: TriggerOccurrenceState;
  payload: unknown;
  provenance: Record<string, unknown>;
  payloadMediaType: string;
  inputHash: string;
  /** Immutable definition snapshot captured when the occurrence was accepted. */
  triggerSnapshot?: Pick<TriggerDefinitionDto, "id" | "conversationId" | "branchId" | "targetAgentId" | "name" | "instructions" | "sourceKind" | "sourceConfig" | "fullAccess"> & { productScope?: "dev" | "branches" };
  activationId?: string;
  lastError?: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}
