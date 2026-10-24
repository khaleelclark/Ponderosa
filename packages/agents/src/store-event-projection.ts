import { appendFsyncedJsonl } from "./append-jsonl.js";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "@ponderosa/native-host/fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { and, eq, isNull, or } from "drizzle-orm";
import type {
  ArtifactDto,
  ArtifactKind,
  AgentLifecycleReason,
  AgentLifecycleStatus,
} from "@ponderosa/core";
import type { Db } from "./db.js";
import { readArtifactSequenceReservation, reservedArtifactSeq, type ArtifactSequenceReservation } from "./artifact-sequence.js";
import { EventLog } from "./eventlog.js";
import type { LogEvent, StoredLogEvent } from "./log-event.js";
import { publishManagedArtifactContent } from "./managed-artifact-files.js";
import { agentDir, artifactContentPath, eventsPath } from "./paths.js";
import {
  initProjectionState,
  projectAll,
  projectEvent,
  type ProjectionOp,
  type ProjectionState,
} from "./projectors.js";
import {
  agents,
  artifacts,
  continuationHandoffs,
  events,
  messages,
  runs,
  workItems,
} from "./schema.js";
import { healthObservation, utf8Prefix } from "./store-activity.js";

const ACTIVITY_OUTPUT_PREVIEW_BYTES = 4_096;
const ACTIVITY_EVENT_TYPES = new Set([
  "command", "file_change", "test_result", "tool_call", "tool_result", "error",
  "browser_session", "browser_action", "browser_console", "browser_screenshot",
  "context_rollover_triggered", "context_rollover_seed_overflow", "context_rollover_completed",
]);

const RUN_OUTPUT_BREAKING_EVENT_TYPES = new Set([
  "command", "tool_call", "tool_result", "file_change", "test_result", "error",
  "browser_session", "browser_action", "browser_console", "browser_screenshot",
  "context_rollover_triggered", "context_rollover_seed_overflow", "context_rollover_completed",
]);

type ManagedArtifact = ArtifactDto & {
  projectId: string;
  originAgentId: string;
};

/** Metadata only: safe to log even when the original exception includes private content. */
export class AgentEventPersistenceError extends Error {
  constructor(readonly diagnostic: {
    agentId: string; seq: number; eventType: string; executionId?: string;
    code: "managed_artifact_collision" | "event_projection_failed" | "canonical_append_uncertain";
  }, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Agent event persistence failed", { cause });
    this.name = "AgentEventPersistenceError";
  }
}

/**
 * Owns canonical per-Agent event logs, their reducer state, and the rebuildable
 * SQLite projections produced from those logs.
 */
export class AgentEventProjectionStore {
  // ponytail: fixed owner SQL only; dynamic or iterator queries must stay uncached.
  private readonly statements = new Map<string, Database.Statement>();
  private statement(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.client.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }

  private readonly reservations = new Map<string, ArtifactSequenceReservation | undefined>();
  private readonly logs = new Map<string, EventLog>();
  private readonly states = new Map<string, ProjectionState>();
  private readonly projectionFailures = new Map<string, AgentEventPersistenceError>();

  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
    private readonly client: Database.Database,
    private readonly activeEngineOf: (agentId: string) => string,
    private readonly recordProjectArtifact: (artifact: ManagedArtifact) => void,
  ) {}

  append(agentId: string, projectId: string, event: LogEvent, ts?: string): StoredLogEvent {
    const priorFailure = this.projectionFailures.get(agentId);
    if (priorFailure) {
      throw new AgentEventPersistenceError(priorFailure.diagnostic,
        new Error("Agent event projection failed; restart and replay canonical events before appending", { cause: priorFailure }));
    }
    // Seed the reducer from the prior log, not the log after this append.
    const state = this.stateFor(agentId, projectId);
    const log = this.logFor(agentId, projectId);
    let stored: StoredLogEvent | undefined;
    try {
      stored = log.append(event, ts);
      const { state: nextState, ops } = projectEvent(agentId, state, stored, this.reservationFor(agentId, projectId));
      this.applyOps(agentId, projectId, ops);
      this.states.set(agentId, nextState);
    } catch (error) {
      // The JSONL append is canonical. Do not accept another event against a
      // stale SQLite view; startup replay is the recovery boundary.
      this.states.delete(agentId);
      const failure = new AgentEventPersistenceError({
        agentId, seq: stored?.seq ?? log.peekNextSeq(), eventType: event.type,
        ...(("executionId" in event && event.executionId) || state.activeExecutionId
          ? { executionId: ("executionId" in event ? event.executionId : undefined) ?? state.activeExecutionId } : {}),
        code: !stored ? "canonical_append_uncertain"
          : error instanceof Error && error.message === "managed artifact identity collision or unsafe existing leaf"
            ? "managed_artifact_collision" : "event_projection_failed",
      }, error);
      this.projectionFailures.set(agentId, failure);
      try {
        appendFsyncedJsonl(join(agentDir(this.dataDir, projectId, agentId), "event-persistence-failures.jsonl"),
          [{ ...failure.diagnostic, recordedAt: new Date().toISOString() }]);
      } catch { /* diagnostics must not replace the original persistence failure */ }
      throw failure;
    }
    return stored;
  }

  readAll(agentId: string, projectId: string): StoredLogEvent[] {
    return this.logFor(agentId, projectId).readAll();
  }

  readSince(agentId: string, sinceSeq: number, limit?: number): StoredLogEvent[] {
    return (this.statement(`
      SELECT seq, created_at, payload_json
      FROM events
      WHERE agent_id = ? AND seq > ?
      ORDER BY seq
      ${limit === undefined ? "" : "LIMIT ?"}
    `).all(...(limit === undefined ? [agentId, sinceSeq] : [agentId, sinceSeq, limit])) as Array<{
      seq: number;
      created_at: string;
      payload_json: string;
    }>).map((row) => ({
      seq: row.seq,
      ts: row.created_at,
      event: JSON.parse(row.payload_json) as LogEvent,
    }));
  }

  lastSeq(agentId: string): number {
    const row = this.statement(`
      SELECT last_seq FROM agent_event_head_projection WHERE agent_id = ?
    `).get(agentId) as { last_seq: number } | undefined;
    return row?.last_seq ?? 0;
  }

  latestHealth(agentId: string): {
    status: AgentLifecycleStatus;
    statusTimestamp: string;
    reason: AgentLifecycleReason;
    executionId?: string;
  } | undefined {
    const row = this.statement(`
      SELECT status, status_timestamp, reason, execution_id
      FROM agent_health_projection WHERE agent_id = ?
    `).get(agentId) as {
      status: AgentLifecycleStatus;
      status_timestamp: string;
      reason: AgentLifecycleReason;
      execution_id: string | null;
    } | undefined;
    return row ? {
      status: row.status,
      statusTimestamp: row.status_timestamp,
      reason: row.reason,
      ...(row.execution_id ? { executionId: row.execution_id } : {}),
    } : undefined;
  }

  projectStored(
    agentId: string,
    projectId: string,
    stored: StoredLogEvent[],
    activeEngine: string,
  ): void {
    this.applyOps(agentId, projectId, projectAll(agentId, stored, activeEngine, this.reservationFor(agentId, projectId)));
  }

  forgetAgent(agentId: string): void {
    this.reservations.delete(agentId);
    this.logs.delete(agentId);
    this.states.delete(agentId);
    this.projectionFailures.delete(agentId);
  }

  clearCaches(): void {
    this.statements.clear();
    this.reservations.clear();
    this.logs.clear();
    this.states.clear();
    this.projectionFailures.clear();
  }

  private projectRunOutputEvent(
    agentId: string,
    row: { seq: number; type: string; payloadJson: string; createdAt: string },
  ): void {
    const outputEvent = row.type === "text" || row.type === "reasoning";
    if (!outputEvent && !RUN_OUTPUT_BREAKING_EVENT_TYPES.has(row.type)) return;
    const event = JSON.parse(row.payloadJson) as LogEvent;
    const executionId = "executionId" in event && typeof event.executionId === "string"
      ? event.executionId
      : null;
    const head = this.statement(`
      SELECT last_seq, event_type, execution_id, segment_first_seq
      FROM run_output_heads WHERE agent_id = ?
    `).get(agentId) as {
      last_seq: number;
      event_type: string;
      execution_id: string | null;
      segment_first_seq: number | null;
    } | undefined;
    if (head && row.seq <= head.last_seq) return;

    let segmentFirstSeq: number | null = null;
    if (outputEvent && executionId) {
      const delta = (event as Extract<LogEvent, { type: "text" | "reasoning" }>).delta;
      const deltaUtf8Bytes = Buffer.byteLength(delta, "utf8");
      const trimmedDelta = delta.trimEnd();
      const initialPreview = utf8Prefix(delta, 32 * 1_024);
      const continues = Boolean(
        head
        && head.segment_first_seq !== null
        && head.event_type === row.type
        && head.execution_id === executionId,
      );
      if (continues) {
        const segment = this.statement(`
          SELECT text_preview, preview_utf8_bytes, raw_utf8_bytes,
            canonical_utf8_bytes
          FROM run_output_segments
          WHERE agent_id = ? AND first_seq = ?
        `).get(agentId, head!.segment_first_seq) as {
          text_preview: string;
          preview_utf8_bytes: number;
          raw_utf8_bytes: number;
          canonical_utf8_bytes: number;
        } | undefined;
        if (!segment) {
          throw new Error("run output segment projection is inconsistent");
        }
        const previewPart = utf8Prefix(
          delta,
          Math.max(0, 32 * 1_024 - segment.preview_utf8_bytes),
        );
        const previewUtf8Bytes = segment.preview_utf8_bytes
          + Buffer.byteLength(previewPart, "utf8");
        const canonicalUtf8Bytes = trimmedDelta
          ? segment.raw_utf8_bytes + Buffer.byteLength(trimmedDelta, "utf8")
          : segment.canonical_utf8_bytes;
        const updated = this.statement(`
          UPDATE run_output_segments SET
            last_seq = ?,
            text_preview = ?,
            preview_utf8_bytes = ?,
            raw_utf8_bytes = ?,
            canonical_utf8_bytes = ?
          WHERE agent_id = ? AND first_seq = ? AND last_seq = ?
        `).run(
          row.seq,
          `${segment.text_preview}${previewPart}`,
          previewUtf8Bytes,
          segment.raw_utf8_bytes + deltaUtf8Bytes,
          canonicalUtf8Bytes,
          agentId,
          head!.segment_first_seq,
          head!.last_seq,
        );
        if (updated.changes !== 1) {
          throw new Error("run output segment projection is inconsistent");
        }
        segmentFirstSeq = head!.segment_first_seq;
      } else {
        this.statement(`
          INSERT INTO run_output_segments(
            agent_id, first_seq, last_seq, event_type, execution_id, created_at,
            text_preview, preview_utf8_bytes, raw_utf8_bytes,
            canonical_utf8_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          agentId,
          row.seq,
          row.seq,
          row.type,
          executionId,
          row.createdAt,
          initialPreview,
          Buffer.byteLength(initialPreview, "utf8"),
          deltaUtf8Bytes,
          trimmedDelta ? Buffer.byteLength(trimmedDelta, "utf8") : 0,
        );
        segmentFirstSeq = row.seq;
      }
    }

    this.statement(`
      INSERT INTO run_output_heads(
        agent_id, last_seq, event_type, execution_id, segment_first_seq
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        last_seq = excluded.last_seq,
        event_type = excluded.event_type,
        execution_id = excluded.execution_id,
        segment_first_seq = excluded.segment_first_seq
    `).run(agentId, row.seq, row.type, executionId, segmentFirstSeq);
  }

  private applyOps(agentId: string, projectId: string, ops: ProjectionOp[]): void {
    for (const op of ops) {
      if (op.kind === "insert_artifact") {
        let managed = op.managed;
        if (op.content !== undefined) {
          const target = artifactContentPath(this.dataDir, projectId, agentId, op.row.path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, op.content, "utf8");
          const published = publishManagedArtifactContent(
            this.dataDir,
            projectId,
            op.row.id,
            op.content,
          );
          managed = {
            size: published.size,
            sha256: published.sha256,
            mediaType: op.row.kind === "diff" ? "text/x-diff" : "text/markdown",
          };
        }
        if (managed) {
          this.recordProjectArtifact({
            id: op.row.id,
            projectId,
            agentId: op.row.agentId,
            originAgentId: op.row.agentId,
            ...(op.row.executionId ? { executionId: op.row.executionId } : {}),
            kind: op.row.kind as ArtifactKind,
            path: op.row.path,
            ...(op.row.sourcePath ? { sourcePath: op.row.sourcePath } : {}),
            summary: op.row.summary ?? op.row.path,
            createdAt: op.row.createdAt,
            mediaType: managed.mediaType,
            visibility: op.row.visibility === "published" ? "published" : "project",
            pinned: op.row.pinned === 1,
            size: managed.size,
            sha256: managed.sha256,
          });
        }
      }
    }

    // Drizzle runs the callback immediately against the same SQLite handle.
    this.db.transaction((tx) => {
      for (const op of ops) {
        switch (op.kind) {
          case "insert_message":
            tx.insert(messages).values(op.row).onConflictDoNothing().run();
            break;
          case "insert_event":
            tx.insert(events).values(op.row).onConflictDoNothing().run();
            this.statement(`
              INSERT INTO agent_event_head_projection(agent_id, last_seq) VALUES (?, ?)
              ON CONFLICT(agent_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)
            `).run(agentId, op.row.seq);
            this.projectRunOutputEvent(agentId, op.row);
            {
              const event = JSON.parse(op.row.payloadJson) as LogEvent;
              const observation = healthObservation(event, op.row.createdAt);
              if (observation) this.statement(`
                INSERT INTO agent_health_projection(
                  agent_id, source_seq, status, status_timestamp, reason, execution_id
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(agent_id) DO UPDATE SET
                  source_seq = excluded.source_seq,
                  status = excluded.status,
                  status_timestamp = excluded.status_timestamp,
                  reason = excluded.reason,
                  execution_id = excluded.execution_id
                WHERE excluded.source_seq > agent_health_projection.source_seq
              `).run(
                agentId,
                op.row.seq,
                observation.status,
                observation.statusTimestamp,
                observation.reason,
                observation.executionId ?? null,
              );
            }
            if (ACTIVITY_EVENT_TYPES.has(op.row.type)) {
              const event = JSON.parse(op.row.payloadJson) as LogEvent;
              let eventJson = op.row.payloadJson;
              let previewUtf8Bytes: number | null = null;
              let totalUtf8Bytes: number | null = null;
              let outputSha256: string | null = null;
              if (event.type === "tool_result") {
                const output = Buffer.from(event.output, "utf8");
                const preview = utf8Prefix(event.output, ACTIVITY_OUTPUT_PREVIEW_BYTES);
                previewUtf8Bytes = Buffer.byteLength(preview, "utf8");
                totalUtf8Bytes = output.length;
                outputSha256 = createHash("sha256").update(output).digest("hex");
                eventJson = JSON.stringify({ ...event, output: preview });
                this.statement(`
                  INSERT OR IGNORE INTO tool_output_projection
                    (agent_id, seq, output, total_utf8_bytes, sha256)
                  VALUES (?, ?, ?, ?, ?)
                `).run(agentId, op.row.seq, output, output.length, outputSha256);
              }
              this.statement(`
                INSERT OR IGNORE INTO activity_projection(
                  agent_id, seq, event_type, execution_id, event_json, created_at,
                  output_preview_utf8_bytes, output_total_utf8_bytes, output_sha256
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                agentId,
                op.row.seq,
                op.row.type,
                op.executionId ?? null,
                eventJson,
                op.row.createdAt,
                previewUtf8Bytes,
                totalUtf8Bytes,
                outputSha256,
              );
              if (event.type === "file_change") {
                if (op.executionId) this.statement(`
                  INSERT INTO changed_file_execution_projection(agent_id, path, execution_id, last_seq)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(agent_id, path, execution_id) DO UPDATE SET last_seq = excluded.last_seq
                `).run(agentId, event.path, op.executionId, op.row.seq);
                const executionIds = (this.statement(`
                  SELECT execution_id AS executionId
                  FROM changed_file_execution_projection
                  WHERE agent_id = ? AND path = ?
                  ORDER BY last_seq DESC, execution_id DESC LIMIT 100
                `).all(agentId, event.path) as Array<{ executionId: string }>)
                  .map((row) => row.executionId);
                const executionCount = (this.statement(`
                  SELECT COUNT(*) AS count FROM changed_file_execution_projection
                  WHERE agent_id = ? AND path = ?
                `).get(agentId, event.path) as { count: number }).count;
                const boundedDiff = event.diff
                  ? utf8Prefix(event.diff, ACTIVITY_OUTPUT_PREVIEW_BYTES)
                  : null;
                this.statement(`
                  INSERT INTO changed_file_projection(
                    agent_id, path, kind, last_seq, last_changed_at, execution_ids_json, execution_count, diff
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(agent_id, path) DO UPDATE SET
                    kind = excluded.kind,
                    last_seq = excluded.last_seq,
                    last_changed_at = excluded.last_changed_at,
                    execution_ids_json = excluded.execution_ids_json,
                    execution_count = excluded.execution_count,
                    diff = excluded.diff
                `).run(
                  agentId,
                  event.path,
                  event.kind,
                  op.row.seq,
                  op.row.createdAt,
                  JSON.stringify(executionIds),
                  executionCount,
                  boundedDiff,
                );
              }
            }
            if (op.row.type === "artifact_visibility") {
              const visibility = JSON.parse(op.row.payloadJson) as LogEvent;
              if (visibility.type === "artifact_visibility") {
                this.statement(`
                  UPDATE artifacts SET visibility = ?, pinned = ? WHERE agent_id = ? AND id = ?
                `).run(
                  visibility.visibility,
                  visibility.pinned ? 1 : 0,
                  agentId,
                  visibility.artifactId,
                );
              }
            }
            break;
          case "insert_artifact":
            tx.insert(artifacts).values(op.row).onConflictDoNothing().run();
            break;
          case "insert_run":
            tx.insert(runs)
              .values(op.row)
              .onConflictDoUpdate({
                target: [runs.agentId, runs.id],
                set: {
                  title: op.row.title,
                  status: op.row.status,
                  reason: op.row.reason,
                  engine: op.row.engine,
                  communicationEventId: op.row.communicationEventId,
                  wakeCause: op.row.wakeCause,
                  updatedAt: op.row.updatedAt,
                  completedAt: op.row.completedAt,
                },
              })
              .run();
            break;
          case "set_run_usage":
            tx.update(runs)
              .set({
                inputTokens: op.inputTokens ?? null,
                cachedInputTokens: op.cachedInputTokens ?? null,
                cacheWriteInputTokens: op.cacheWriteInputTokens ?? null,
                outputTokens: op.outputTokens ?? null,
                reasoningOutputTokens: op.reasoningOutputTokens ?? null,
                totalTokens: op.totalTokens ?? null,
                providerRequestUsageJson: op.providerRequestUsage
                  ? JSON.stringify(op.providerRequestUsage)
                  : null,
              })
              .where(and(eq(runs.agentId, agentId), eq(runs.id, op.id)))
              .run();
            break;
          case "update_run":
            tx.update(runs)
              .set({
                status: op.status,
                reason: op.reason,
                updatedAt: op.updatedAt,
                completedAt: op.completedAt,
              })
              .where(and(eq(runs.agentId, agentId), eq(runs.id, op.id)))
              .run();
            break;
          case "insert_work_item":
            tx.insert(workItems)
              .values(op.row)
              .onConflictDoUpdate({
                target: workItems.id,
                set: {
                  executionId: op.row.executionId,
                  title: op.row.title,
                  status: op.row.status,
                  updatedAt: op.row.updatedAt,
                },
              })
              .run();
            break;
          case "set_session":
            tx.update(agents)
              .set({
                activeSessionId: op.sessionId,
                activeSessionContractHash: op.toolContractHash,
                activeSessionArtifactIdsJson: JSON.stringify(op.artifactIds),
              })
              .where(eq(agents.id, agentId))
              .run();
            break;
          case "insert_continuation_handoff":
            tx.insert(continuationHandoffs)
              .values({
                id: op.id,
                agentId,
                sourceExecutionId: op.executionId,
                text: op.text,
                createdAt: op.createdAt,
              })
              .onConflictDoNothing()
              .run();
            break;
          case "consume_continuation_handoff":
            tx.update(continuationHandoffs)
              .set({
                consumedByExecutionId: op.executionId,
                consumedAt: op.consumedAt,
              })
              .where(and(
                eq(continuationHandoffs.id, op.id),
                eq(continuationHandoffs.agentId, agentId),
                or(
                  isNull(continuationHandoffs.consumedAt),
                  eq(continuationHandoffs.consumedByExecutionId, op.executionId),
                ),
              ))
              .run();
            break;
          case "set_state":
            tx.update(agents)
              .set({ stateBranch: op.branch ?? null, stateCommit: op.commit ?? null })
              .where(eq(agents.id, agentId))
              .run();
            break;
          case "touch_agent":
            tx.update(agents)
              .set({ updatedAt: op.updatedAt })
              .where(eq(agents.id, agentId))
              .run();
            break;
        }
      }
    });
  }

  artifactSeq(agentId: string, projectId: string, seq: number): number {
    return reservedArtifactSeq(seq, this.reservationFor(agentId, projectId));
  }

  private reservationFor(agentId: string, projectId: string): ArtifactSequenceReservation | undefined {
    if (!this.reservations.has(agentId)) {
      this.reservations.set(agentId, readArtifactSequenceReservation(this.dataDir, projectId, agentId));
    }
    return this.reservations.get(agentId);
  }

  private logFor(agentId: string, projectId: string): EventLog {
    let log = this.logs.get(agentId);
    if (!log) {
      log = new EventLog(eventsPath(this.dataDir, projectId, agentId));
      this.logs.set(agentId, log);
    }
    return log;
  }

  private stateFor(agentId: string, projectId: string): ProjectionState {
    let state = this.states.get(agentId);
    if (!state) {
      // Rebuild the in-memory reducer state by folding the existing log.
      state = initProjectionState(this.activeEngineOf(agentId));
      const existing = this.logFor(agentId, projectId).readAll();
      for (const stored of existing) {
        state = projectEvent(agentId, state, stored, this.reservationFor(agentId, projectId)).state;
      }
      this.states.set(agentId, state);
    }
    return state;
  }
}
