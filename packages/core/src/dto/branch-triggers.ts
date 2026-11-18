// Branch workflow trigger contracts. Main-product Agent Automations remain retired.

export type TriggerSourceKind = "schedule" | "webhook" | "filesystem";
export type TriggerOccurrenceState = "pending" | "activated" | "cancelled" | "dead_lettered";
export type TriggerScheduleWhenRunning = "update_current" | "run_latest" | "queue_all";

export const MIN_SCHEDULE_INTERVAL_MS = 60_000;

/** Shared scalar/date domain for schedule publication and its existing UI. */
export function nextIntervalTime(everyMs: number, startsAt: number, now: number): number {
  if (!Number.isSafeInteger(everyMs)) throw new Error("Interval must use finite, safe whole milliseconds.");
  if (everyMs < MIN_SCHEDULE_INTERVAL_MS) throw new Error("Interval must be at least 1 minute.");
  if (!Number.isFinite(startsAt)) throw new Error("Interval startsAt must be an ISO timestamp.");
  let next = startsAt;
  if (next <= now) next += (Math.floor((now - next) / everyMs) + 1) * everyMs;
  if (!Number.isSafeInteger(next) || !Number.isFinite(new Date(next).getTime()))
    throw new Error("Interval produces a date outside the supported range.");
  return next;
}

export type TriggerScheduleConfig =
  | { scheduleKind: "once"; at: string }
  | { scheduleKind: "interval"; everyMs: number; startsAt: string; whenRunning?: TriggerScheduleWhenRunning }
  | { scheduleKind: "cron"; expression: string; timezone: string; whenRunning?: TriggerScheduleWhenRunning };

export type TriggerWebhookConfig = Record<string, never>;

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
  schedule?: {
    policy: TriggerScheduleWhenRunning;
    firstScheduledAt: string;
    lastScheduledAt: string;
    eventCount: number;
    eventCountExact?: boolean;
    delivery: "held" | "steering" | "updated" | "run" | "unconfirmed" | "combined";
    combinedIntoOccurrenceId?: string;reconciled?: 'applied'|'not_applied';
  };
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
