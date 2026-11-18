/** Original-source reconciliation reads host receipts; it never replays work. */
export interface SourceEffectBoundary {
  agentId: string;
  sourceRunId: string;
  sourceFence: number;
}
export interface SourceEffectEvidence {
  id: string;
  kind: "communication" | "coordination" | "request_update" | "artifact_import" | "queued_delivery" | "tool_call" | "tool_result" | "command" | "file_change";
  outcome: "host_committed" | "unknown";
  /** Hash of the original durable record, never a hash supplied by the caller. */
  receiptHash: string;
  receiptId: string;
  toolCallId?: string;
  requestId?: string;
  resultingState?: string;
  resultingVersion?: number;
  /** A host commit proves only this effect, not downstream execution/delivery. */
  detail: string;
}
export interface SourceEffectInventory extends SourceEffectBoundary {
  projectId: string;
  scopeKey: string;
  providerSessionId: string | null;
  sourceStatus: "outcome_unknown" | "completed";
  /** Exact unconfirmed steering submissions on a completed Run, if any. */
  unknownSteeringInjectionIds?: string[];
  inventoryHash: string;
  effects: SourceEffectEvidence[];
  /** The provider can have acted without leaving host telemetry. */
  nativeTail: "unknown";
  sourceWork: "held_unknown";
  replayAuthorized: false;
}
export interface SourceEffectReconcileInput {
  sourceFence: number;
  expectedInventoryHash: string;
  idempotencyKey: string;
}
export interface SourceEffectReconcileReceipt {
  inventory: SourceEffectInventory;
  reconciledAt: string;
  disposition: "host_receipts_reconciled_external_unknown";
  replayAuthorized: false;
}
