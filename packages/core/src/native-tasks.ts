/** Exact provider identities observed on the owned live session; never prose-derived. */
export interface NativeTask {
  taskKey: string;
  taskId: string;
  kind: string;
  taskRunId?: string;
  itemId?: string;
  processId?: string;
  cancellable: boolean;
}
export type NativeTaskStopOutcome = "acknowledged" | "terminated" | "not_found" | "unknown";
export interface NativeTaskBoundary {
  runId: string;
  sourceFence: number;
  sessionId: string;
}
export interface NativeTaskInventory extends NativeTaskBoundary {
  tasks: NativeTask[];
}
export interface NativeTaskStopRequest extends NativeTaskBoundary {
  taskKey: string;
  idempotencyKey: string;
}
export interface NativeTaskStopReceipt extends NativeTaskStopRequest {
  outcome: NativeTaskStopOutcome;
  /** A provider acknowledgement never proves process-group drain or settles source effects. */
  processDrainObserved: false;
}
