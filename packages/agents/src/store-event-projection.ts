import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import type {
  ArtifactDto,
  ArtifactKind,
  AgentLifecycleReason,
  AgentLifecycleStatus,
} from "@ponderosa/core";
import type { Db } from "./db.js";
import { EventLog } from "./eventlog.js";
import type { LogEvent, StoredLogEvent } from "./log-event.js";
import { publishManagedArtifactContent } from "./managed-artifact-files.js";
import { artifactContentPath, eventsPath } from "./paths.js";
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
  "context_rollover_triggered",
]);

type ManagedArtifact = ArtifactDto & {
  projectId: string;
  originAgentId: string;
};

/**
 * Owns canonical per-Agent event logs, their reducer state, and the rebuildable
 * SQLite projections produced from those logs.
 */
export class AgentEventProjectionStore {
  private readonly logs = new Map<string, EventLog>();
  private readonly states = new Map<string, ProjectionState>();

  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
    private readonly client: Database.Database,
    private readonly activeEngineOf: (agentId: string) => string,
    private readonly recordProjectArtifact: (artifact: ManagedArtifact) => void,
  ) {}

  append(agentId: string, projectId: string, event: LogEvent): StoredLogEvent {
    const stored = this.logFor(agentId, projectId).append(event);
    const state = this.stateFor(agentId, projectId);
    const { state: nextState, ops } = projectEvent(agentId, state, stored);
    this.states.set(agentId, nextState);
    this.applyOps(agentId, projectId, ops);
    return stored;
  }

  readAll(agentId: string, projectId: string): StoredLogEvent[] {
    return this.logFor(agentId, projectId).readAll();
  }

  readSince(agentId: string, sinceSeq: number): StoredLogEvent[] {
    return (this.client.prepare(`
      SELECT seq, created_at, payload_json
      FROM events
      WHERE agent_id = ? AND seq > ?
      ORDER BY seq
    `).all(agentId, sinceSeq) as Array<{
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
    const row = this.client.prepare(`
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
    const row = this.client.prepare(`
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
    this.applyOps(agentId, projectId, projectAll(agentId, stored, activeEngine));
  }

  forgetAgent(agentId: string): void {
    this.logs.delete(agentId);
    this.states.delete(agentId);
  }

  clearCaches(): void {
    this.logs.clear();
    this.states.clear();
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
            this.client.prepare(`
              INSERT INTO agent_event_head_projection(agent_id, last_seq) VALUES (?, ?)
              ON CONFLICT(agent_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)
            `).run(agentId, op.row.seq);
            {
              const event = JSON.parse(op.row.payloadJson) as LogEvent;
              const observation = healthObservation(event, op.row.createdAt);
              if (observation) this.client.prepare(`
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
                this.client.prepare(`
                  INSERT OR IGNORE INTO tool_output_projection
                    (agent_id, seq, output, total_utf8_bytes, sha256)
                  VALUES (?, ?, ?, ?, ?)
                `).run(agentId, op.row.seq, output, output.length, outputSha256);
              }
              this.client.prepare(`
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
                if (op.executionId) this.client.prepare(`
                  INSERT INTO changed_file_execution_projection(agent_id, path, execution_id, last_seq)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(agent_id, path, execution_id) DO UPDATE SET last_seq = excluded.last_seq
                `).run(agentId, event.path, op.executionId, op.row.seq);
                const executionIds = (this.client.prepare(`
                  SELECT execution_id AS executionId
                  FROM changed_file_execution_projection
                  WHERE agent_id = ? AND path = ?
                  ORDER BY last_seq DESC, execution_id DESC LIMIT 100
                `).all(agentId, event.path) as Array<{ executionId: string }>)
                  .map((row) => row.executionId);
                const executionCount = (this.client.prepare(`
                  SELECT COUNT(*) AS count FROM changed_file_execution_projection
                  WHERE agent_id = ? AND path = ?
                `).get(agentId, event.path) as { count: number }).count;
                const boundedDiff = event.diff
                  ? utf8Prefix(event.diff, ACTIVITY_OUTPUT_PREVIEW_BYTES)
                  : null;
                this.client.prepare(`
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
                this.client.prepare(`
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
      const existing = new EventLog(eventsPath(this.dataDir, projectId, agentId)).readAll();
      for (const stored of existing) {
        state = projectEvent(agentId, state, stored).state;
      }
      this.states.set(agentId, state);
    }
    return state;
  }
}
