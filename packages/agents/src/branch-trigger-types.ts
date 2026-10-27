import type { TriggerSourceKind, TriggerSourceConfig, TriggerOccurrenceState, TriggerOccurrenceDto } from "@ponderosa/core";
export interface TriggerFilesystemBurst {
  triggerId: string;
  occurrenceKey: string;
  projectId: string;
  agentId?: never;
  branchId: string;
  startedAt: string;
  lastAt: string;
  eventCount: number;
  changes: Array<{ path: string; types: string[] }>;
  droppedPathEventCount: number;
}

export interface CreateTriggerDefinitionInput {
  id?: string;
  projectId: string;
  conversationId: string;
  targetAgentId?: never;
  branchId: string;
  name: string;
  instructions: string;
  sourceKind: TriggerSourceKind;
  sourceConfig: TriggerSourceConfig;
  enabled?: boolean;
  runBudget?: never;
  nextFireAt?: string;
  secretCiphertext?: string;
  secretFingerprint?: string;
  now?: string;
}

export interface UpdateTriggerDefinitionInput {
  branchId?: string;
  conversationId?: string;
  targetAgentId?: never;
  name?: string;
  instructions?: string;
  sourceConfig?: TriggerSourceConfig;
  enabled?: boolean;
  runBudget?: never;
  nextFireAt?: string | null;
  secretCiphertext?: string;
  secretFingerprint?: string;
  now?: string;
}

export interface RecordTriggerOccurrenceInput {
  /** Scheduler-owned hold, never accepted from external event data. */
  heldSchedule?: NonNullable<TriggerOccurrenceDto['schedule']>;
  /** Trusted server intake flag, never copied from payload or provenance. Branch-only. */
  branchOperatorManual?: boolean;
  triggerId: string;
  occurrenceKey: string;
  payload: unknown;
  provenance: { source: string; [key: string]: unknown };
  retryDelayMs?: number;
  payloadMediaType?: string;
  now?: string;
  /** Operator-confirmed manual runs may execute a disabled definition once. */
  allowDisabled?: boolean;
}

export interface TriggerOccurrenceResult {
  occurrenceId: string;
  state: TriggerOccurrenceState;
  activationId?: string;
  replayed: boolean;
}


export interface BranchTriggerIntake {
  admissionSource: "manual" | "automatic";
  triggerId: string;
  branchId: string; occurrenceId: string; inputHash: string; payload: unknown;
  provenance: Record<string, unknown>; payloadMediaType: string; now: string;
}
