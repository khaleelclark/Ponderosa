import type { AgentLifecycleReason, AgentLifecycleStatus } from "@ponderosa/core";
import type { LogEvent } from "./log-event.js";

function healthObservation(event: LogEvent, timestamp: string): {
  status: AgentLifecycleStatus;
  statusTimestamp: string;
  reason: AgentLifecycleReason;
  executionId?: string;
} | undefined {
  const executionId = "executionId" in event && typeof event.executionId === "string" ? event.executionId : undefined;
  if (event.type === "error") return { status: "failed", statusTimestamp: timestamp, reason: "runtime_error", ...(executionId ? { executionId } : {}) };
  if (event.type === "agent_lifecycle") return {
    status: event.status === "completed" ? "idle" : event.status,
    statusTimestamp: timestamp,
    reason: event.reason,
    executionId: event.executionId,
  };
  if (event.type === "work_item_update" && event.status === "waiting_approval") {
    return { status: "waiting", statusTimestamp: timestamp, reason: "work_item_waiting_approval", ...(executionId ? { executionId } : {}) };
  }
  if (event.type === "turn_done") return { status: "idle", statusTimestamp: timestamp, reason: "turn_completed", ...(executionId ? { executionId } : {}) };
  if (event.type === "work_item_update" && event.status === "done") {
    return { status: "idle", statusTimestamp: timestamp, reason: "work_item_completed", ...(executionId ? { executionId } : {}) };
  }
  return undefined;
}

function utf8Prefix(text: string, maximumBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maximumBytes) return text;
  let end = maximumBytes;
  while (end > 0) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); }
    catch { end -= 1; }
  }
  return "";
}

export { healthObservation, utf8Prefix };
