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
  conversationId: string;
  agentId: string;
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
  name: string;
  instructions: string;
  sourceKind: TriggerSourceKind;
  sourceConfig: TriggerSourceConfig;
  enabled?: boolean;
  runBudget?: TriggerRunBudgetDto;
}

export interface UpdateTriggerRequest {
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

export interface TriggerOccurrenceDto {
  id: string;
  artifactId: string;
  triggerId: string;
  projectId: string;
  agentId: string;
  state: TriggerOccurrenceState;
  payload: unknown;
  provenance: Record<string, unknown>;
  payloadMediaType: string;
  inputHash: string;
  /** Immutable definition snapshot captured when the occurrence was accepted. */
  triggerSnapshot?: Pick<TriggerDefinitionDto, "id" | "name" | "instructions" | "sourceKind" | "sourceConfig" | "fullAccess">;
  activationId?: string;
  lastError?: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}
