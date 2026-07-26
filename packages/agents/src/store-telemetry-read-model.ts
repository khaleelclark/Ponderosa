import type Database from "better-sqlite3";
import type {
  AgentActivityDto,
  ChangedFileDto,
  ChangedFileDetailDto,
  HistoryPageDto,
  ResponseFileActivityDto,
  RunOutputDto,
} from "@ponderosa/core";
import { activityDtoFromProjectionRow, utf8Prefix } from "./store-activity.js";
import type {
  ActivityProjectionReadRow,
  RunOutputEventRow,
  RunOutputSegmentRow,
} from "./store-types.js";
import type { LogEvent } from "./log-event.js";

type HistoryCursor = { orderKey: string; rowKey: string };
type EncodeHistoryCursor = (input: { stream: string; scope: string; orderKey: string; rowKey: string }) => string;
type DecodeHistoryCursor = (cursor: string, stream: string, scope: string) => HistoryCursor;
type ResponseFileActivityByExecution = (
  agentId: string,
  status: ResponseFileActivityDto["status"],
  executionFilter?: ReadonlySet<string>,
) => Map<string, ResponseFileActivityDto[]>;

const RUN_OUTPUT_TEXT_PREVIEW_BYTES = 32 * 1_024;
const RUN_OUTPUT_TEXT_MAX_BYTES = 8 * 1_024 * 1_024;
const RUN_OUTPUT_BREAKING_TYPES = [
  "command", "tool_call", "tool_result", "file_change", "test_result", "error",
  "browser_session", "browser_action", "browser_console", "browser_screenshot",
  "context_rollover_triggered",
] as const;

export class AgentTelemetryReadModel {
  constructor(
    private readonly client: Database.Database,
    private readonly encodeHistoryCursor: EncodeHistoryCursor,
    private readonly decodeHistoryCursor: DecodeHistoryCursor,
    private readonly responseFileActivityByExecution: ResponseFileActivityByExecution,
  ) {}

  getFinalizedWorkDurationMs(agentId: string): number {
    const row = this.client.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN completed_at IS NOT NULL AND completed_at >= started_at
            THEN CAST(ROUND((julianday(completed_at) - julianday(started_at)) * 86400000) AS INTEGER)
          ELSE 0
        END
      ), 0) AS durationMs
      FROM runs
      WHERE agent_id = ?
    `).get(agentId) as { durationMs: number };
    return Math.max(0, Number(row.durationMs) || 0);
  }

  eventSeqBoundary(cursor: string | undefined, stream: string, agentId: string): number | undefined {
    if (!cursor) return undefined;
    const decoded = this.decodeHistoryCursor(cursor, stream, agentId);
    const seq = Number(decoded.orderKey);
    if (!Number.isSafeInteger(seq) || seq < 1 || decoded.rowKey !== String(seq)) throw new Error("invalid history cursor");
    return seq;
  }

  eventSeqFocus(focusId: string | undefined, stream: "runOutput" | "activity", agentId: string): number | undefined {
    if (!focusId) return undefined;
    const prefix = `${agentId}:${stream}:`;
    if (!focusId.startsWith(prefix)) throw new Error("invalid history focus");
    const seq = Number(focusId.slice(prefix.length));
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("invalid history focus");
    return seq;
  }

  private runOutputSegmentRows(
    agentId: string,
    input?: { beforeSeq?: number; endingAtSeq?: number; limit?: number },
  ): RunOutputSegmentRow[] {
    const breakingTypes = RUN_OUTPUT_BREAKING_TYPES.map((type) => `'${type}'`).join(", ");
    const limit = input?.limit === undefined ? "" : "LIMIT ?";
    const rows = this.client.prepare(`
      WITH visible AS (
        SELECT seq, type, payload_json,
          json_extract(payload_json, '$.executionId') AS execution_id
        FROM events
        WHERE agent_id = ?
          AND type IN ('text', 'reasoning', ${breakingTypes})
      ),
      annotated AS (
        SELECT *,
          lag(type) OVER (ORDER BY seq) AS previous_type,
          lag(execution_id) OVER (ORDER BY seq) AS previous_execution_id
        FROM visible
      ),
      marked AS (
        SELECT *,
          CASE
            WHEN type IN ('text', 'reasoning')
              AND type = previous_type
              AND execution_id IS previous_execution_id
            THEN 0
            WHEN type IN ('text', 'reasoning') THEN 1
            ELSE 0
          END AS starts_segment
        FROM annotated
      ),
      grouped AS (
        SELECT *,
          sum(starts_segment) OVER (ORDER BY seq) AS segment_number
        FROM marked
      ),
      segments AS (
        SELECT
          min(seq) AS first_seq,
          max(seq) AS last_seq,
          min(type) AS event_type,
          min(execution_id) AS execution_id
        FROM grouped
        WHERE type IN ('text', 'reasoning') AND execution_id IS NOT NULL
        GROUP BY segment_number
      )
      SELECT first_seq, last_seq, event_type, execution_id
      FROM segments
      WHERE 1 = 1
        ${input?.beforeSeq === undefined ? "" : "AND first_seq < ?"}
        ${input?.endingAtSeq === undefined ? "" : "AND first_seq <= ?"}
      ORDER BY first_seq DESC
      ${limit}
    `);
    const parameters: Array<string | number> = [agentId];
    if (input?.beforeSeq !== undefined) parameters.push(input.beforeSeq);
    if (input?.endingAtSeq !== undefined) parameters.push(input.endingAtSeq);
    if (input?.limit !== undefined) parameters.push(input.limit);
    return rows.all(...parameters) as RunOutputSegmentRow[];
  }

  private materializeRunOutputSegments(
    agentId: string,
    segmentRows: RunOutputSegmentRow[],
  ): RunOutputDto[] {
    if (segmentRows.length === 0) return [];
    const orderedSegments = [...segmentRows].sort((a, b) => a.first_seq - b.first_seq);
    const eventRows = this.client.prepare(`
      SELECT seq, payload_json, created_at
      FROM events
      WHERE agent_id = ? AND type IN ('text', 'reasoning')
        AND seq BETWEEN ? AND ?
      ORDER BY seq
    `);
    const byStart = new Map<number, RunOutputDto>();
    for (const segment of orderedSegments) {
      const previewParts: string[] = [];
      let previewUtf8Bytes = 0;
      let rawUtf8Bytes = 0;
      let canonicalUtf8Bytes = 0;
      let createdAt = "";
      for (const row of eventRows.iterate(
        agentId,
        segment.first_seq,
        segment.last_seq,
      ) as IterableIterator<RunOutputEventRow>) {
        const event = JSON.parse(row.payload_json) as LogEvent;
        if (
          (event.type === "text" || event.type === "reasoning") &&
          event.executionId === segment.execution_id
        ) {
          createdAt ||= row.created_at;
          const deltaUtf8Bytes = Buffer.byteLength(event.delta, "utf8");
          const trimmedDelta = event.delta.trimEnd();
          if (trimmedDelta) {
            canonicalUtf8Bytes =
              rawUtf8Bytes + Buffer.byteLength(trimmedDelta, "utf8");
          }
          rawUtf8Bytes += deltaUtf8Bytes;
          if (previewUtf8Bytes < RUN_OUTPUT_TEXT_PREVIEW_BYTES) {
            const part = utf8Prefix(
              event.delta,
              RUN_OUTPUT_TEXT_PREVIEW_BYTES - previewUtf8Bytes,
            );
            previewParts.push(part);
            previewUtf8Bytes += Buffer.byteLength(part, "utf8");
          }
        }
      }
      if (canonicalUtf8Bytes === 0) continue;
      const preview = previewParts.join("");
      const text =
        canonicalUtf8Bytes <= previewUtf8Bytes
          ? utf8Prefix(preview, canonicalUtf8Bytes).trimEnd()
          : preview;
      previewUtf8Bytes = Buffer.byteLength(text, "utf8");
      byStart.set(segment.first_seq, {
        id: `${agentId}:runOutput:${segment.first_seq}`,
        agentId,
        executionId: segment.execution_id,
        kind: segment.event_type === "reasoning" ? "reasoning" : "response",
        text,
        completed: true,
        seq: segment.first_seq,
        sourceSeqStart: segment.first_seq,
        sourceSeqEnd: segment.last_seq,
        createdAt,
        ...(previewUtf8Bytes < canonicalUtf8Bytes
          ? {
              textPreview: {
                truncated: true,
                previewUtf8Bytes,
                totalUtf8Bytes: canonicalUtf8Bytes,
                retrievalUrl: `/api/agents/${encodeURIComponent(agentId)}/run-output/${segment.first_seq}/text`,
              },
            }
          : {}),
      });
    }
    const items = [...byStart.values()];
    const executionIds = new Set(items.map((item) => item.executionId));
    const fileActivityByExecution = this.responseFileActivityByExecution(
      agentId,
      "completed",
      executionIds,
    );
    const lastResponseByExecution = new Map<string, number>();
    for (const segment of this.runOutputSegmentRows(agentId)) {
      if (
        segment.event_type !== "text" ||
        lastResponseByExecution.has(segment.execution_id)
      ) {
        continue;
      }
      lastResponseByExecution.set(segment.execution_id, segment.first_seq);
    }
    return items.map((item) => {
      if (
        item.kind !== "response" ||
        lastResponseByExecution.get(item.executionId) !== item.seq
      ) {
        return item;
      }
      const fileActivity = fileActivityByExecution.get(item.executionId) ?? [];
      return fileActivity.length ? { ...item, fileActivity } : item;
    });
  }

  /** Durable response/reasoning segments interleaved by canonical event sequence. */
  getRunOutputs(agentId: string): RunOutputDto[] {
    return this.materializeRunOutputSegments(
      agentId,
      this.runOutputSegmentRows(agentId),
    );
  }

  getRunOutputPage(
    agentId: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): HistoryPageDto<RunOutputDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    if (input.cursor && input.focusId) {
      throw new Error("history cursor and focus cannot be combined");
    }
    const focusSeq = this.eventSeqFocus(input.focusId, "runOutput", agentId);
    const boundary = this.eventSeqBoundary(
      input.cursor,
      "agent:runOutput",
      agentId,
    );
    let endingAtSeq: number | undefined;
    if (focusSeq !== undefined) {
      const allSegments = this.runOutputSegmentRows(agentId);
      let containing = allSegments.find(
        (segment) =>
          segment.first_seq <= focusSeq && segment.last_seq >= focusSeq,
      );
      if (!containing) {
        const legacy = this.client
          .prepare(`
            SELECT payload_json FROM events
            WHERE agent_id = ? AND seq = ? AND type = 'agent_output'
          `)
          .get(agentId, focusSeq) as { payload_json: string } | undefined;
        if (legacy) {
          const event = JSON.parse(legacy.payload_json) as LogEvent;
          if (event.type === "agent_output") {
            containing = allSegments.find(
              (segment) =>
                segment.first_seq <= event.sourceSeqEnd &&
                segment.last_seq >= event.sourceSeqEnd,
            );
          }
        }
      }
      if (!containing) {
        return { items: [], history: { limit, hasMore: false } };
      }
      endingAtSeq = containing.first_seq;
    }
    const rows = this.runOutputSegmentRows(agentId, {
      ...(boundary !== undefined ? { beforeSeq: boundary } : {}),
      ...(endingAtSeq !== undefined ? { endingAtSeq } : {}),
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = this.materializeRunOutputSegments(agentId, selected);
    const oldest = selected.at(-1);
    return {
      items,
      history: {
        limit,
        hasMore,
        ...(hasMore && oldest
          ? {
              cursor: this.encodeHistoryCursor({
                stream: "agent:runOutput",
                scope: agentId,
                orderKey: String(oldest.first_seq),
                rowKey: String(oldest.first_seq),
              }),
            }
          : {}),
      },
    };
  }

  getRunOutputText(
    agentId: string,
    seq: number,
  ):
    | {
        agentId: string;
        runOutputId: string;
        seq: number;
        text: string;
        totalUtf8Bytes: number;
      }
    | undefined {
    const segment = this.runOutputSegmentRows(agentId).find(
      (row) => row.first_seq === seq,
    );
    if (!segment) return undefined;
    const item = this.materializeRunOutputSegments(agentId, [segment])[0];
    if (!item) return undefined;
    const boundedTotal =
      item.textPreview?.totalUtf8Bytes ?? Buffer.byteLength(item.text, "utf8");
    if (boundedTotal > RUN_OUTPUT_TEXT_MAX_BYTES) {
      throw new RangeError(
        "run output segment exceeds the 8 MiB retrieval limit",
      );
    }
    const rows = this.client
      .prepare(`
        SELECT payload_json
        FROM events
        WHERE agent_id = ? AND type IN ('text', 'reasoning')
          AND seq BETWEEN ? AND ?
        ORDER BY seq
      `)
      .all(agentId, segment.first_seq, segment.last_seq) as Array<{
      payload_json: string;
    }>;
    const text = rows
      .flatMap((row) => {
        const event = JSON.parse(row.payload_json) as LogEvent;
        return (event.type === "text" || event.type === "reasoning") &&
          event.executionId === segment.execution_id
          ? [event.delta]
          : [];
      })
      .join("")
      .trimEnd();
    const totalUtf8Bytes = Buffer.byteLength(text, "utf8");
    return {
      agentId,
      runOutputId: `${agentId}:runOutput:${seq}`,
      seq,
      text,
      totalUtf8Bytes,
    };
  }

  /** Execution activity is rebuilt from canonical log events, never from live-only UI state. */
  getActivity(agentId: string): AgentActivityDto[] {
    const rows = this.client.prepare(`
      SELECT seq, execution_id, event_json, created_at, output_preview_utf8_bytes,
        output_total_utf8_bytes, output_sha256
      FROM activity_projection WHERE agent_id = ? ORDER BY seq
    `).all(agentId) as ActivityProjectionReadRow[];
    return rows.map((row) => activityDtoFromProjectionRow(agentId, row));
  }

  activityDtoFromProjectionRow(agentId: string, row: ActivityProjectionReadRow): AgentActivityDto {
    return activityDtoFromProjectionRow(agentId, row);
  }

  getActivityPage(
    agentId: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): HistoryPageDto<AgentActivityDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    if (input.cursor && input.focusId) throw new Error("history cursor and focus cannot be combined");
    const focusSeq = this.eventSeqFocus(input.focusId, "activity", agentId);
    const boundary = focusSeq ?? this.eventSeqBoundary(input.cursor, "agent:activity", agentId);
    const rows = this.client.prepare(`
      SELECT seq, execution_id, event_json, created_at, output_preview_utf8_bytes,
        output_total_utf8_bytes, output_sha256
      FROM activity_projection
      WHERE agent_id = ?
        ${boundary === undefined ? "" : `AND seq ${focusSeq === undefined ? "<" : "<="} ?`}
      ORDER BY seq DESC LIMIT ?
    `).all(...(boundary === undefined ? [agentId, limit + 1] : [agentId, boundary, limit + 1])) as ActivityProjectionReadRow[];
    if (focusSeq !== undefined && rows[0]?.seq !== focusSeq) {
      return { items: [], history: { limit, hasMore: false } };
    }
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.map((row) => activityDtoFromProjectionRow(agentId, row)).reverse();
    const oldest = selected.at(-1);
    return {
      items,
      history: {
        limit,
        hasMore,
        ...(hasMore && oldest ? {
          cursor: this.encodeHistoryCursor({
            stream: "agent:activity", scope: agentId,
            orderKey: String(oldest.seq), rowKey: String(oldest.seq),
          }),
        } : {}),
      },
    };
  }

  getActivityOutput(agentId: string, seq: number): {
    agentId: string;
    activityId: string;
    seq: number;
    output: string;
    totalUtf8Bytes: number;
    sha256: string;
  } | undefined {
    const row = this.client.prepare(`
      SELECT output, total_utf8_bytes, sha256
      FROM tool_output_projection WHERE agent_id = ? AND seq = ?
    `).get(agentId, seq) as { output: Buffer; total_utf8_bytes: number; sha256: string } | undefined;
    if (!row) return undefined;
    return {
      agentId,
      activityId: `${agentId}:activity:${seq}`,
      seq,
      output: Buffer.isBuffer(row.output) ? row.output.toString("utf8") : String(row.output),
      totalUtf8Bytes: row.total_utf8_bytes,
      sha256: row.sha256,
    };
  }

  getActivityOutputPage(agentId: string, seq: number, startUtf8Byte: number, maxBytes: number): {
    agentId: string;
    activityId: string;
    seq: number;
    output: string;
    pageUtf8Bytes: number;
    totalUtf8Bytes: number;
    sha256: string;
  } | undefined {
    const row = this.client.prepare(`
      SELECT substr(output, ?, ?) AS page, total_utf8_bytes, sha256
      FROM tool_output_projection WHERE agent_id = ? AND seq = ?
    `).get(startUtf8Byte + 1, maxBytes + 3, agentId, seq) as {
      page: Buffer; total_utf8_bytes: number; sha256: string;
    } | undefined;
    if (!row) return undefined;
    if (!Number.isSafeInteger(startUtf8Byte) || startUtf8Byte < 0 || startUtf8Byte > row.total_utf8_bytes) {
      throw new Error("activity output cursor is outside the retained output");
    }
    const bytes = Buffer.isBuffer(row.page) ? row.page : Buffer.from(row.page);
    let pageBytes = Math.min(maxBytes, bytes.length);
    // The cursor is always emitted on a code-point boundary. Pulling three
    // lookahead bytes lets this page retreat from a split UTF-8 sequence while
    // still returning the largest valid prefix within maxBytes.
    while (pageBytes > 0) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, pageBytes));
        break;
      } catch {
        pageBytes -= 1;
      }
    }
    return {
      agentId,
      activityId: `${agentId}:activity:${seq}`,
      seq,
      output: bytes.subarray(0, pageBytes).toString("utf8"),
      pageUtf8Bytes: pageBytes,
      totalUtf8Bytes: row.total_utf8_bytes,
      sha256: row.sha256,
    };
  }

  /** Bounded newest-first keyset over one row per touched path. */
  getChangedFilePage(
    agentId: string,
    input: { limit: number; cursor?: string },
  ): HistoryPageDto<ChangedFileDto> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    const boundary = input.cursor
      ? this.decodeHistoryCursor(input.cursor, "agent:changedFiles", agentId)
      : undefined;
    const boundarySeq = boundary ? Number(boundary.orderKey) : undefined;
    if (boundary && (!Number.isSafeInteger(boundarySeq) || boundarySeq! < 1)) throw new Error("invalid history cursor");
    const rows = this.client.prepare(`
      SELECT path, kind, last_seq, last_changed_at, execution_count, diff IS NOT NULL AS diff_available
      FROM changed_file_projection
      WHERE agent_id = ?
        ${boundary ? "AND (last_seq < ? OR (last_seq = ? AND path < ?))" : ""}
      ORDER BY last_seq DESC, path DESC
      LIMIT ?
    `).all(...(boundary
      ? [agentId, boundarySeq, boundarySeq, boundary.rowKey, limit + 1]
      : [agentId, limit + 1])) as Array<{
      path: string; kind: ChangedFileDto["kind"]; last_seq: number; last_changed_at: string;
      execution_count: number; diff_available: number;
    }>;
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const oldest = selected.at(-1);
    return {
      items: selected.map((row) => ({
        path: row.path,
        kind: row.kind,
        lastSeq: row.last_seq,
        lastChangedAt: row.last_changed_at,
        executionCount: row.execution_count,
        diffAvailable: row.diff_available === 1,
      })),
      history: {
        limit,
        hasMore,
        ...(hasMore && oldest ? { cursor: this.encodeHistoryCursor({
          stream: "agent:changedFiles", scope: agentId,
          orderKey: String(oldest.last_seq), rowKey: oldest.path,
        }) } : {}),
      },
    };
  }

  getChangedFileDetail(agentId: string, path: string): ChangedFileDetailDto | undefined {
    const row = this.client.prepare(`
      SELECT path, kind, last_seq, last_changed_at, execution_ids_json, execution_count, diff
      FROM changed_file_projection WHERE agent_id = ? AND path = ?
    `).get(agentId, path) as {
      path: string; kind: ChangedFileDto["kind"]; last_seq: number; last_changed_at: string;
      execution_ids_json: string; execution_count: number; diff: string | null;
    } | undefined;
    if (!row) return undefined;
    const executionIds = JSON.parse(row.execution_ids_json) as string[];
    return {
      path: row.path,
      kind: row.kind,
      lastSeq: row.last_seq,
      lastChangedAt: row.last_changed_at,
      executionCount: row.execution_count,
      diffAvailable: row.diff !== null,
      executionIds,
      provenanceTruncated: executionIds.length < row.execution_count,
      ...(row.diff ? { diff: row.diff } : {}),
    };
  }
}
