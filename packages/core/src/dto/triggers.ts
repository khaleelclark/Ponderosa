// ─── Triggers (Communication V3.2) ─────────────────────────────────────────

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
  /** The Chat whose context receives work created by this Project Automation. */
  conversationId: string;
  /** The existing Agent that executes each occurrence. The Automation remains Project-owned. */
  targetAgentId?: string;
  /** Exclusive alternative to the existing Agent destination. */
  branchId?: string;
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
  targetAgentId?: string;
  /** Exclusive alternative to the existing Agent destination. */
  branchId?: string;
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
  targetAgentId?: string;
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
  agentId?: string;
  branchId?: string;
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
