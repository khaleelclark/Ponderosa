import type Database from "better-sqlite3";
import type { AgentActivityDto, ChangedFileDto, ChangedFileDetailDto, HistoryPageDto } from "@ponderosa/core";
import type { ActivityProjectionReadRow } from "./store-types.js";

type HistoryCursor = { orderKey: string; rowKey: string };
type EncodeHistoryCursor = (input: { stream: string; scope: string; orderKey: string; rowKey: string }) => string;
type DecodeHistoryCursor = (cursor: string, stream: string, scope: string) => HistoryCursor;

export class AgentTelemetryReadModel {
  constructor(
    private readonly client: Database.Database,
    private readonly encodeHistoryCursor: EncodeHistoryCursor,
    private readonly decodeHistoryCursor: DecodeHistoryCursor,
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

  /** Execution activity is rebuilt from canonical log events, never from live-only UI state. */
  getActivity(agentId: string): AgentActivityDto[] {
    const rows = this.client.prepare(`
      SELECT seq, execution_id, event_json, created_at, output_preview_utf8_bytes,
        output_total_utf8_bytes, output_sha256
      FROM activity_projection WHERE agent_id = ? ORDER BY seq
    `).all(agentId) as ActivityProjectionReadRow[];
    return rows.map((row) => this.activityDtoFromProjectionRow(agentId, row));
  }

  activityDtoFromProjectionRow(agentId: string, row: ActivityProjectionReadRow): AgentActivityDto {
    const event = JSON.parse(row.event_json) as AgentActivityDto["event"];
    const base: AgentActivityDto = {
      id: `${agentId}:activity:${row.seq}`,
      agentId,
      ...(row.execution_id ? { executionId: row.execution_id } : {}),
      seq: row.seq,
      createdAt: row.created_at,
      event,
    };
    if (event.type !== "tool_result" || row.output_total_utf8_bytes === null ||
        row.output_preview_utf8_bytes === null || !row.output_sha256 ||
        row.output_preview_utf8_bytes >= row.output_total_utf8_bytes) return base;
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
    const items = selected.map((row) => this.activityDtoFromProjectionRow(agentId, row)).reverse();
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
