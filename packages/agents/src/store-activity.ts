import type {
  AgentActivityDto,
  AgentLifecycleReason,
  AgentLifecycleStatus,
} from "@ponderosa/core";
import type { LogEvent } from "./log-event.js";
import type { ActivityProjectionReadRow } from "./store-types.js";

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

function activityDtoFromProjectionRow(
  agentId: string,
  row: ActivityProjectionReadRow,
): AgentActivityDto {
  const event = JSON.parse(row.event_json) as AgentActivityDto["event"];
  const base: AgentActivityDto = {
    id: `${agentId}:activity:${row.seq}`,
    agentId,
    ...(row.execution_id ? { executionId: row.execution_id } : {}),
    seq: row.seq,
    createdAt: row.created_at,
    event,
  };
  if (
    event.type !== "tool_result" ||
    row.output_total_utf8_bytes === null ||
    row.output_preview_utf8_bytes === null ||
    !row.output_sha256 ||
    row.output_preview_utf8_bytes >= row.output_total_utf8_bytes
  ) {
    return base;
  }
  return {
    ...base,
    outputPreview: {
      truncated: true,
      previewUtf8Bytes: row.output_preview_utf8_bytes,
      totalUtf8Bytes: row.output_total_utf8_bytes,
      sha256: row.output_sha256,
      retrievalUrl: `/api/agents/${encodeURIComponent(agentId)}/activity/${row.seq}/output`,
    },
  };
}

export { activityDtoFromProjectionRow, healthObservation, utf8Prefix };
