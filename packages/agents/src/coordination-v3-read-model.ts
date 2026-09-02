import type Database from "better-sqlite3";
import type {
  CoordinationJoinWakePolicy,
  CoordinationRequestLifecycleDto,
  CoordinationRequestState,
  CoordinationRequestUpdateKind,
} from "@ponderosa/core";
import { publicProviderFailureSummary } from "@ponderosa/core";
import { inspectorDetails, inspectorJson, inspectorWakePolicy } from "./coordination-v3-inspector.js";
import {
  providerSafeActivationPayload,
  publicActivationDeliveryError,
} from "./coordination-v3-provider-failure-projection.js";
import type {
  CoordinationAttentionCandidateCursor,
  CoordinationAttentionCandidateKind,
  CoordinationAttentionCandidateV3View,
  CoordinationWaitCycleV3,
} from "./coordination-v3-types.js";

const REQUEST_PREVIEW_CHARACTERS = 280;
const REQUEST_LIFECYCLE_UPDATE_LIMIT = 100;
const REQUEST_LIFECYCLE_TEXT_LIMIT = 32_000;
const ARTIFACT_REF = /ponderosa:\/\/artifact\/[A-Za-z0-9._:-]+/gu;

function parseStoredJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function payloadText(payload: unknown): string | undefined {
  if (typeof payload === "string") return payload.trim() || undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ["text", "question", "reason", "assignment", "task", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const decision = record.decision;
  if (decision && typeof decision === "object" && !Array.isArray(decision)) {
    const response = (decision as Record<string, unknown>).response;
    if (response && typeof response === "object" && !Array.isArray(response)) {
      const text = (response as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) return text.trim();
    }
  }
  return undefined;
}

function boundedLifecycleText(payload: unknown): { text?: string; truncated?: true } {
  const text = payloadText(payload);
  if (!text) return {};
  if (text.length <= REQUEST_LIFECYCLE_TEXT_LIMIT) return { text };
  return {
    text: `${text.slice(0, REQUEST_LIFECYCLE_TEXT_LIMIT - 1).trimEnd()}…`,
    truncated: true,
  };
}

function payloadRefs(payload: unknown): string[] {
  const refs = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (refs.size >= 20 || depth > 5) return;
    if (typeof value === "string") {
      for (const match of value.matchAll(ARTIFACT_REF)) {
        refs.add(match[0]);
        if (refs.size >= 20) break;
      }
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 50).forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;
    Object.values(value as Record<string, unknown>)
      .slice(0, 50)
      .forEach((item) => visit(item, depth + 1));
  };
  visit(payload, 0);
  return [...refs];
}

function boundedRequestPreview(payloadJson: string | null): string | undefined {
  if (!payloadJson) return undefined;
  const text = payloadText(parseStoredJson(payloadJson));
  if (!text) return undefined;
  return text.length > REQUEST_PREVIEW_CHARACTERS
    ? `${text.slice(0, REQUEST_PREVIEW_CHARACTERS).trimEnd()}…`
    : text;
}

export class CoordinationV3ReadModel {
  constructor(private readonly sqlite: Database.Database) {}

  /** Exact canonical records that can currently contribute a coordination
   * attention trace. Pages use a stable keyset so recurring reconciliation
   * never depends on an unbounded DISTINCT/ORDER BY history scan. */
  coordinationAttentionCandidates(
    limit = 200,
    cursor?: CoordinationAttentionCandidateCursor,
  ): CoordinationAttentionCandidateV3View[] {
    const ranks: Record<CoordinationAttentionCandidateKind, number> = {
      request: 0,
      join: 1,
      trigger: 2,
    };
    const cursorRank = cursor ? ranks[cursor.kind] : null;
    const pageLimit = Math.max(1, Math.min(limit, 500));
    const boundary = (kindRank: number): string => cursor ? `
      AND (
        updated_at < @cursorUpdatedAt
        OR (
          updated_at = @cursorUpdatedAt
          AND (
            ${kindRank} > @cursorKindRank
            OR (${kindRank} = @cursorKindRank AND id < @cursorRecordId)
          )
        )
      )
    ` : "";
    const rows = this.sqlite.prepare(`
      WITH request_candidates AS (
        SELECT 0 AS kind_rank, 'request' AS kind, id AS record_id,
          project_id, recipient_agent_id AS agent_id, updated_at
        FROM coordination_requests
        WHERE state IN ('blocked', 'failed', 'outcome_unknown', 'expired', 'recipient_unavailable')
          ${boundary(0)}
        ORDER BY updated_at DESC, id DESC
        LIMIT @branchLimit
      ), join_candidates AS (
        SELECT 1 AS kind_rank, 'join' AS kind, id AS record_id,
          project_id, owner_agent_id AS agent_id, updated_at
        FROM coordination_joins
        WHERE state IN ('impossible', 'expired')
          ${boundary(1)}
        ORDER BY updated_at DESC, id DESC
        LIMIT @branchLimit
      ), trigger_candidates AS (
        SELECT 2 AS kind_rank, 'trigger' AS kind, id AS record_id,
          project_id, agent_id, updated_at
        FROM trigger_occurrences
        WHERE state = 'dead_lettered'
          ${boundary(2)}
        ORDER BY updated_at DESC, id DESC
        LIMIT @branchLimit
      ), attention_candidates AS (
        SELECT * FROM request_candidates
        UNION ALL SELECT * FROM join_candidates
        UNION ALL SELECT * FROM trigger_candidates
      )
      SELECT kind, record_id, project_id, agent_id, updated_at
      FROM attention_candidates
      ORDER BY updated_at DESC, kind_rank, record_id DESC
      LIMIT @pageLimit
    `).all({
      branchLimit: pageLimit,
      pageLimit,
      ...(cursor ? {
        cursorUpdatedAt: cursor.updatedAt,
        cursorKindRank: cursorRank,
        cursorRecordId: cursor.recordId,
      } : {}),
    }) as Array<{
      kind: CoordinationAttentionCandidateKind;
      record_id: string;
      project_id: string;
      agent_id: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      kind: row.kind,
      recordId: row.record_id,
      projectId: row.project_id,
      agentId: row.agent_id,
      updatedAt: row.updated_at,
    }));
  }

  schedulerMetrics(): {
      pendingActivations: number;
      activeRuns: number;
      completedRuns: number;
      failedRuns: number;
      outcomeUnknownRuns: number;
      pendingActivationOutbox: number;
      deadLetteredActivationOutbox: number;
      pendingProviderOperations: number;
      deadLetteredProviderOperations: number;
      pendingTriggerOccurrences: number;
      deadLetteredTriggerOccurrences: number;
      recipientUnavailableActivations: number;
      permanentFailureActivations: number;
      retryExhaustedActivations: number;
    } {
      const count = (table: string, predicate: string): number => (this.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`,
      ).get() as { count: number }).count;
      return {
        pendingActivations: count("agent_activations", "state IN ('pending', 'retry_pending')"),
        activeRuns: count("scheduler_runs", "status IN ('leased', 'running')"),
        completedRuns: count("scheduler_runs", "status = 'completed'"),
        failedRuns: count("scheduler_runs", "status = 'failed'"),
        outcomeUnknownRuns: count("scheduler_runs", "status = 'outcome_unknown'"),
        pendingActivationOutbox: count("activation_outbox", "processed_at IS NULL AND dead_lettered_at IS NULL"),
        deadLetteredActivationOutbox: count("activation_outbox", "dead_lettered_at IS NOT NULL"),
        pendingProviderOperations: count("provider_operation_outbox", "state IN ('pending', 'claimed')"),
        deadLetteredProviderOperations: count("provider_operation_outbox", "state = 'failed'"),
        pendingTriggerOccurrences: count("trigger_occurrences", "state = 'pending'"),
        deadLetteredTriggerOccurrences: count("trigger_occurrences", "state = 'dead_lettered'"),
        recipientUnavailableActivations: count("agent_activations", "terminal_outcome = 'recipient_unavailable'"),
        permanentFailureActivations: count("agent_activations", "terminal_outcome = 'permanent_failure'"),
        retryExhaustedActivations: count("agent_activations", "terminal_outcome = 'retry_exhausted'"),
      };
    }

  /** Diagnose long-lived indefinite wait cycles without rejecting flexible
     * organization shapes. Consumers may surface these as operational warnings. */
    waitGraphCycles(
      now = new Date().toISOString(),
      minimumAgeMs = 5 * 60_000,
    ): CoordinationWaitCycleV3[] {
      const cutoff = new Date(Date.parse(now) - Math.max(0, minimumAgeMs)).toISOString();
      const edges = this.sqlite.prepare(`
        SELECT id, requester_agent_id, recipient_agent_id, created_at
        FROM coordination_requests
        WHERE requester_agent_id IS NOT NULL AND lifetime_kind = 'indefinite'
          AND state IN ('open', 'in_progress', 'waiting_dependency', 'awaiting_answer')
          AND created_at <= ?
        ORDER BY created_at, id
      `).all(cutoff) as Array<{
        id: string; requester_agent_id: string; recipient_agent_id: string; created_at: string;
      }>;
      const graph = new Map<string, Set<string>>();
      for (const edge of edges) {
        graph.set(edge.requester_agent_id, graph.get(edge.requester_agent_id) ?? new Set());
        graph.get(edge.requester_agent_id)!.add(edge.recipient_agent_id);
        if (!graph.has(edge.recipient_agent_id)) graph.set(edge.recipient_agent_id, new Set());
      }
      let index = 0;
      const indices = new Map<string, number>();
      const low = new Map<string, number>();
      const stack: string[] = [];
      const stacked = new Set<string>();
      const components: string[][] = [];
      const visit = (agentId: string): void => {
        indices.set(agentId, index);
        low.set(agentId, index);
        index += 1;
        stack.push(agentId);
        stacked.add(agentId);
        for (const target of graph.get(agentId) ?? []) {
          if (!indices.has(target)) {
            visit(target);
            low.set(agentId, Math.min(low.get(agentId)!, low.get(target)!));
          } else if (stacked.has(target)) {
            low.set(agentId, Math.min(low.get(agentId)!, indices.get(target)!));
          }
        }
        if (low.get(agentId) !== indices.get(agentId)) return;
        const component: string[] = [];
        while (stack.length) {
          const member = stack.pop()!;
          stacked.delete(member);
          component.push(member);
          if (member === agentId) break;
        }
        if (component.length > 1) components.push(component.sort());
      };
      for (const agentId of [...graph.keys()].sort()) if (!indices.has(agentId)) visit(agentId);
      return components.map((agentIds) => {
        const members = new Set(agentIds);
        const cycleEdges = edges.filter((edge) =>
          members.has(edge.requester_agent_id) && members.has(edge.recipient_agent_id));
        return {
          agentIds,
          requestIds: cycleEdges.map((edge) => edge.id).sort(),
          oldestRequestAt: cycleEdges.map((edge) => edge.created_at).sort()[0]!,
        };
      });
    }

  /** Read-only projection of the authoritative coordination graph. Relationships
     * come from foreign-key/link tables, never from prompt or chat text. */
    requestSummariesForCommunications(
      projectId: string,
      communicationEventIds: string[],
    ): Map<string, import("@ponderosa/core").CoordinationRequestSummaryDto[]> {
      const uniqueEventIds = [...new Set(communicationEventIds.filter(Boolean))];
      const result = new Map<string, import("@ponderosa/core").CoordinationRequestSummaryDto[]>();
      if (uniqueEventIds.length === 0) return result;
      const placeholders = uniqueEventIds.map(() => "?").join(", ");
      const rows = this.sqlite.prepare(`
        SELECT request.id, request.state, request.requester_agent_id,
          request.recipient_agent_id, request.conversation_id,
          request.communication_event_id, request.payload_json,
          request.updated_at,
          EXISTS (
            SELECT 1 FROM coordination_request_updates request_update
            WHERE request_update.request_id = request.id
          ) AS has_updates,
          (
            SELECT request_update.kind
            FROM coordination_request_updates request_update
            WHERE request_update.request_id = request.id
            ORDER BY request_update.created_at DESC, request_update.id DESC
            LIMIT 1
          ) AS latest_update_kind,
          (
            SELECT request_update.created_at
            FROM coordination_request_updates request_update
            WHERE request_update.request_id = request.id
            ORDER BY request_update.created_at DESC, request_update.id DESC
            LIMIT 1
          ) AS latest_update_at,
          EXISTS (
            SELECT 1 FROM coordination_request_updates request_update
            WHERE request_update.request_id = request.id
              AND request_update.kind IN ('completed', 'blocked', 'failed')
          ) AS has_result
        FROM coordination_requests request
        WHERE request.project_id = ?
          AND request.communication_event_id IN (${placeholders})
        ORDER BY request.created_at ASC, request.id ASC
      `).all(projectId, ...uniqueEventIds) as Array<{
        id: string;
        state: CoordinationRequestState;
        requester_agent_id: string | null;
        recipient_agent_id: string;
        conversation_id: string | null;
        communication_event_id: string;
        payload_json: string | null;
        updated_at: string;
        has_updates: number;
        latest_update_kind: CoordinationRequestUpdateKind | null;
        latest_update_at: string | null;
        has_result: number;
      }>;
      for (const row of rows) {
        const preview = boundedRequestPreview(row.payload_json);
        const summary: import("@ponderosa/core").CoordinationRequestSummaryDto = {
          recordId: row.id,
          state: row.state,
          ...(row.requester_agent_id ? { requesterAgentId: row.requester_agent_id } : {}),
          recipientAgentId: row.recipient_agent_id,
          ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
          communicationEventId: row.communication_event_id,
          ...(preview ? { preview } : {}),
          hasUpdates: row.has_updates === 1,
          ...(row.latest_update_kind ? { latestUpdateKind: row.latest_update_kind } : {}),
          ...(row.latest_update_at ? { latestUpdateAt: row.latest_update_at } : {}),
          hasResult: row.has_result === 1,
          updatedAt: row.updated_at,
        };
        const existing = result.get(row.communication_event_id);
        if (existing) existing.push(summary);
        else result.set(row.communication_event_id, [summary]);
      }
      return result;
    }

  /** Read-only projection of the authoritative coordination graph. Relationships
     * come from foreign-key/link tables, never from prompt or chat text. */
    teamOperationalRecords(input: {
      projectId: string;
      conversationId: string;
      limit: number;
      before?: { createdAt: string; id: string };
    }): Array<{
      id: string;
      kind: "run" | "activation" | "request" | "join" | "trigger";
      operationGroupId: string;
      state: string;
      primaryAgentId: string;
      secondaryAgentId?: string;
      subtype?: string;
      completed?: number;
      total?: number;
      requesterAgentId?: string;
      recipientAgentId?: string;
      communicationEventId?: string;
      requestPreview?: string;
      hasUpdates?: boolean;
      latestUpdateKind?: CoordinationRequestUpdateKind;
      latestUpdateAt?: string;
      hasResult?: boolean;
      createdAt: string;
      updatedAt: string;
    }> {
      // Public pages may contain 1,000 rows and ask this projection for one
      // additional sentinel. Clamping that internal read to 1,000 made an exact
      // 1,001-row history falsely claim there was no next page.
      const limit = Math.max(1, Math.min(input.limit, 1_001));
      const scopeKey = `conversation:${input.conversationId}`;
      const rows = this.sqlite.prepare(`
        WITH request_records AS (
          SELECT 'request:' || request.id AS id, 'request' AS kind,
            'request:' || request.id AS operation_group_id, request.state,
            COALESCE(request.requester_agent_id, request.recipient_agent_id) AS primary_agent_id,
            CASE WHEN request.requester_agent_id IS NOT NULL THEN request.recipient_agent_id END AS secondary_agent_id,
            NULL AS subtype, NULL AS completed, NULL AS total,
            request.requester_agent_id, request.recipient_agent_id,
            request.communication_event_id, request.payload_json AS request_payload_json,
            EXISTS (
              SELECT 1 FROM coordination_request_updates request_update
              WHERE request_update.request_id = request.id
            ) AS has_updates,
            (
              SELECT request_update.kind
              FROM coordination_request_updates request_update
              WHERE request_update.request_id = request.id
              ORDER BY request_update.created_at DESC, request_update.id DESC
              LIMIT 1
            ) AS latest_update_kind,
            (
              SELECT request_update.created_at
              FROM coordination_request_updates request_update
              WHERE request_update.request_id = request.id
              ORDER BY request_update.created_at DESC, request_update.id DESC
              LIMIT 1
            ) AS latest_update_at,
            EXISTS (
              SELECT 1 FROM coordination_request_updates request_update
              WHERE request_update.request_id = request.id
                AND (
                  request_update.kind IN (
                    'answer', 'completed', 'blocked', 'failed',
                    'recipient_unavailable', 'outcome_unknown'
                  )
                  OR EXISTS (
                    SELECT 1 FROM runtime_artifacts artifact
                    WHERE artifact.owner_kind = 'request_update'
                      AND artifact.owner_id = request_update.id
                  )
                )
            ) AS has_result,
            request.created_at, request.updated_at
          FROM coordination_requests request
          WHERE request.project_id = @projectId AND request.conversation_id = @conversationId
            AND (@beforeCreatedAt IS NULL OR request.created_at < @beforeCreatedAt
              OR (request.created_at = @beforeCreatedAt AND 'request:' || request.id < @beforeId))
          ORDER BY request.created_at DESC, 'request:' || request.id DESC LIMIT @limit
        ), join_records AS (
          SELECT 'join:' || join_record.id, 'join', 'join:' || join_record.id,
            join_record.state, join_record.owner_agent_id, NULL, NULL,
            SUM(CASE WHEN request.state = 'completed' THEN 1 ELSE 0 END), COUNT(member.request_id),
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            join_record.created_at, join_record.updated_at
          FROM coordination_joins join_record
          LEFT JOIN coordination_join_members member ON member.join_id = join_record.id
          LEFT JOIN coordination_requests request ON request.id = member.request_id
          WHERE join_record.project_id = @projectId AND join_record.conversation_id = @conversationId
            AND (@beforeCreatedAt IS NULL OR join_record.created_at < @beforeCreatedAt
              OR (join_record.created_at = @beforeCreatedAt AND 'join:' || join_record.id < @beforeId))
          GROUP BY join_record.id
          ORDER BY join_record.created_at DESC, 'join:' || join_record.id DESC LIMIT @limit
        ), activation_records AS (
          SELECT 'activation:' || activation.id, 'activation',
            COALESCE((
              SELECT CASE
                WHEN source.source_kind = 'request' THEN 'request:' || source.source_id
                WHEN source.source_kind = 'request_update' THEN 'request:' || request_update.request_id
                WHEN source.source_kind = 'join' THEN 'join:' || source.source_id
              END
              FROM activation_sources source
              LEFT JOIN coordination_request_updates request_update
                ON source.source_kind = 'request_update'
                AND request_update.id = source.source_id
              WHERE source.activation_id = activation.id
              ORDER BY CASE source.source_kind
                WHEN 'request' THEN 0 WHEN 'request_update' THEN 1 WHEN 'join' THEN 2 ELSE 3 END,
                source.source_id
              LIMIT 1
            ), 'activation:' || activation.id),
            activation.state, activation.agent_id, NULL,
            activation.kind, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            activation.created_at, activation.updated_at
          FROM agent_activations activation
          WHERE activation.project_id = @projectId AND activation.scope_key = @scopeKey
            AND (@beforeCreatedAt IS NULL OR activation.created_at < @beforeCreatedAt
              OR (activation.created_at = @beforeCreatedAt AND 'activation:' || activation.id < @beforeId))
          ORDER BY activation.created_at DESC, 'activation:' || activation.id DESC LIMIT @limit
        ), run_records AS (
          SELECT 'run:' || COALESCE(provider.execution_id, scheduler.id), 'run',
            COALESCE((
              SELECT CASE WHEN COUNT(DISTINCT CASE
                  WHEN source.source_kind = 'request' THEN 'request:' || source.source_id
                  WHEN source.source_kind = 'request_update' THEN 'request:' || request_update.request_id
                  WHEN source.source_kind = 'join' THEN 'join:' || source.source_id
                END) = 1 THEN MIN(CASE
                  WHEN source.source_kind = 'request' THEN 'request:' || source.source_id
                  WHEN source.source_kind = 'request_update' THEN 'request:' || request_update.request_id
                  WHEN source.source_kind = 'join' THEN 'join:' || source.source_id
                END) END
              FROM scheduler_run_activations attachment
              JOIN activation_sources source
                ON source.activation_id = attachment.activation_id
              LEFT JOIN coordination_request_updates request_update
                ON source.source_kind = 'request_update'
                AND request_update.id = source.source_id
              WHERE attachment.run_id = scheduler.id
            ), 'run:' || COALESCE(provider.execution_id, scheduler.id)),
            scheduler.status,
            scheduler.agent_id, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            scheduler.created_at, scheduler.updated_at
          FROM scheduler_runs scheduler
          LEFT JOIN provider_inputs provider ON provider.scheduler_run_id = scheduler.id
          WHERE scheduler.project_id = @projectId AND scheduler.scope_key = @scopeKey
            AND (@beforeCreatedAt IS NULL OR scheduler.created_at < @beforeCreatedAt
              OR (scheduler.created_at = @beforeCreatedAt
                AND 'run:' || COALESCE(provider.execution_id, scheduler.id) < @beforeId))
          ORDER BY scheduler.created_at DESC, 'run:' || COALESCE(provider.execution_id, scheduler.id) DESC LIMIT @limit
        ), trigger_records AS (
          SELECT 'trigger:' || occurrence.id, 'trigger', 'trigger:' || occurrence.id,
            occurrence.state, occurrence.agent_id, NULL,
            COALESCE(definition.name,
              CASE WHEN json_valid(occurrence.trigger_snapshot_json)
                THEN json_extract(occurrence.trigger_snapshot_json, '$.name') END),
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            occurrence.created_at, occurrence.updated_at
          FROM trigger_occurrences occurrence
          LEFT JOIN trigger_definitions definition ON definition.id = occurrence.trigger_id
          WHERE occurrence.project_id = @projectId AND occurrence.scope_key = @scopeKey
            AND (@beforeCreatedAt IS NULL OR occurrence.created_at < @beforeCreatedAt
              OR (occurrence.created_at = @beforeCreatedAt AND 'trigger:' || occurrence.id < @beforeId))
          ORDER BY occurrence.created_at DESC, 'trigger:' || occurrence.id DESC LIMIT @limit
        )
        SELECT * FROM (
          SELECT * FROM request_records
          UNION ALL SELECT * FROM join_records
          UNION ALL SELECT * FROM activation_records
          UNION ALL SELECT * FROM run_records
          UNION ALL SELECT * FROM trigger_records
        ) operation
        ORDER BY operation.created_at DESC, operation.id DESC LIMIT @limit
      `).all({
        projectId: input.projectId,
        conversationId: input.conversationId,
        scopeKey,
        beforeCreatedAt: input.before?.createdAt ?? null,
        beforeId: input.before?.id ?? null,
        limit,
      }) as Array<{
        id: string; kind: "run" | "activation" | "request" | "join" | "trigger";
        operation_group_id: string; state: string;
        primary_agent_id: string; secondary_agent_id: string | null; subtype: string | null;
        completed: number | null; total: number | null;
        requester_agent_id: string | null; recipient_agent_id: string | null;
        communication_event_id: string | null; request_payload_json: string | null;
        has_updates: number | null; latest_update_kind: CoordinationRequestUpdateKind | null;
        latest_update_at: string | null; has_result: number | null;
        created_at: string; updated_at: string;
      }>;
      return rows.map((row) => {
        const requestPreview = boundedRequestPreview(row.request_payload_json);
        return {
          id: row.id, kind: row.kind, operationGroupId: row.operation_group_id,
          state: row.state, primaryAgentId: row.primary_agent_id,
          ...(row.secondary_agent_id ? { secondaryAgentId: row.secondary_agent_id } : {}),
          ...(row.subtype ? { subtype: row.subtype } : {}),
          ...(row.completed !== null ? { completed: row.completed } : {}),
          ...(row.total !== null ? { total: row.total } : {}),
          ...(row.requester_agent_id ? { requesterAgentId: row.requester_agent_id } : {}),
          ...(row.recipient_agent_id ? { recipientAgentId: row.recipient_agent_id } : {}),
          ...(row.communication_event_id ? { communicationEventId: row.communication_event_id } : {}),
          ...(requestPreview ? { requestPreview } : {}),
          ...(row.has_updates !== null ? { hasUpdates: row.has_updates === 1 } : {}),
          ...(row.latest_update_kind ? { latestUpdateKind: row.latest_update_kind } : {}),
          ...(row.latest_update_at ? { latestUpdateAt: row.latest_update_at } : {}),
          ...(row.has_result !== null ? { hasResult: row.has_result === 1 } : {}),
          createdAt: row.created_at, updatedAt: row.updated_at,
        };
      });
    }

  /** Read-only projection of the authoritative coordination graph. Relationships
     * come from foreign-key/link tables, never from prompt or chat text. */
    agentWorkItems(input: {
      projectId: string;
      conversationId?: string;
      agentId?: string;
      focusId?: string;
      limit?: number;
    }): { items: import("@ponderosa/core").AgentWorkItemDto[]; truncated: boolean } {
      const limit = Math.max(1, Math.min(input.limit ?? 300, 1_000));
      const scopeKey = input.conversationId ? `conversation:${input.conversationId}` : undefined;
      const focusRecordId = input.focusId?.includes(":")
        ? input.focusId.slice(input.focusId.indexOf(":") + 1)
        : input.focusId;
      type GraphKind = "request" | "join" | "activation" | "run" | "trigger";
      const graphLimit = Math.min(Math.max(limit * 4, limit), 4_000);
      const selectedIds = new Map<GraphKind, string[]>();
      let truncated = false;
      if (input.agentId) {
        // Select only canonical IDs before reading payload-bearing rows. The
        // recursive UNION is cycle-safe and traverses structural links in both
        // directions. The extra row makes a bounded omission visible to callers.
        const graphRows = this.sqlite.prepare(`
          WITH RECURSIVE
          seed_requests(id, active_rank, updated_at) AS (
            SELECT id, CASE WHEN state IN ('open', 'in_progress', 'waiting_dependency', 'awaiting_answer') THEN 0 ELSE 1 END, updated_at
            FROM coordination_requests
            WHERE project_id = @projectId AND (@conversationId IS NULL OR conversation_id = @conversationId)
              AND (requester_agent_id = @agentId OR recipient_agent_id = @agentId)
            ORDER BY CASE WHEN state IN ('open', 'in_progress', 'waiting_dependency', 'awaiting_answer') THEN 0 ELSE 1 END,
              updated_at DESC, id DESC LIMIT @seedFetchLimit
          ),
          seed_joins(id, active_rank, updated_at) AS (
            SELECT id, CASE WHEN state = 'open' THEN 0 ELSE 1 END, updated_at FROM coordination_joins
            WHERE project_id = @projectId AND (@conversationId IS NULL OR conversation_id = @conversationId)
              AND owner_agent_id = @agentId
            ORDER BY CASE WHEN state = 'open' THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT @seedFetchLimit
          ),
          seed_activations(id, active_rank, updated_at) AS (
            SELECT id, CASE WHEN state IN ('pending', 'retry_pending', 'leased', 'attached') THEN 0 ELSE 1 END, updated_at
            FROM agent_activations
            WHERE project_id = @projectId AND (@scopeKey IS NULL OR scope_key = @scopeKey) AND agent_id = @agentId
            ORDER BY CASE WHEN state IN ('pending', 'retry_pending', 'leased', 'attached') THEN 0 ELSE 1 END,
              updated_at DESC, id DESC LIMIT @seedFetchLimit
          ),
          seed_runs(id, active_rank, updated_at) AS (
            SELECT id, CASE WHEN status IN ('leased', 'running') THEN 0 ELSE 1 END, updated_at FROM scheduler_runs
            WHERE project_id = @projectId AND (@scopeKey IS NULL OR scope_key = @scopeKey) AND agent_id = @agentId
            ORDER BY CASE WHEN status IN ('leased', 'running') THEN 0 ELSE 1 END,
              updated_at DESC, id DESC LIMIT @seedFetchLimit
          ),
          seed_triggers(id, active_rank, updated_at) AS (
            SELECT id, CASE WHEN state = 'pending' THEN 0 ELSE 1 END, updated_at FROM trigger_occurrences
            WHERE project_id = @projectId AND (@scopeKey IS NULL OR scope_key = @scopeKey) AND agent_id = @agentId
            ORDER BY CASE WHEN state = 'pending' THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT @seedFetchLimit
          ),
          seed_candidates(kind, id, active_rank, updated_at, kind_rank) AS (
            SELECT 'request', id, active_rank, updated_at, 0 FROM (SELECT * FROM seed_requests LIMIT @seedLimit)
            UNION ALL SELECT 'join', id, active_rank, updated_at, 1 FROM (SELECT * FROM seed_joins LIMIT @seedLimit)
            UNION ALL SELECT 'activation', id, active_rank, updated_at, 2 FROM (SELECT * FROM seed_activations LIMIT @seedLimit)
            UNION ALL SELECT 'run', id, active_rank, updated_at, 3 FROM (SELECT * FROM seed_runs LIMIT @seedLimit)
            UNION ALL SELECT 'trigger', id, active_rank, updated_at, 4 FROM (SELECT * FROM seed_triggers LIMIT @seedLimit)
          ),
          recent_seeds(kind, id) AS (
            SELECT kind, id FROM seed_candidates
            ORDER BY active_rank, updated_at DESC, kind_rank, id DESC
            LIMIT @graphLimit
          ),
          focus_seeds(kind, id) AS (
            SELECT 'request', id FROM coordination_requests
            WHERE @focusRecordId IS NOT NULL AND project_id = @projectId
              AND (@conversationId IS NULL OR conversation_id = @conversationId)
              AND (requester_agent_id = @agentId OR recipient_agent_id = @agentId)
              AND (id = @focusRecordId OR communication_event_id = @focusRecordId)
            UNION
            SELECT 'join', id FROM coordination_joins
            WHERE @focusRecordId IS NOT NULL AND project_id = @projectId
              AND (@conversationId IS NULL OR conversation_id = @conversationId)
              AND owner_agent_id = @agentId
              AND id = @focusRecordId
            UNION
            SELECT 'activation', id FROM agent_activations
            WHERE @focusRecordId IS NOT NULL AND project_id = @projectId
              AND (@scopeKey IS NULL OR scope_key = @scopeKey)
              AND agent_id = @agentId
              AND id = @focusRecordId
            UNION
            SELECT 'run', scheduler.id
            FROM scheduler_runs scheduler
            LEFT JOIN provider_inputs provider ON provider.scheduler_run_id = scheduler.id
            WHERE @focusRecordId IS NOT NULL AND scheduler.project_id = @projectId
              AND (@scopeKey IS NULL OR scheduler.scope_key = @scopeKey)
              AND scheduler.agent_id = @agentId
              AND (scheduler.id = @focusRecordId OR provider.execution_id = @focusRecordId)
            UNION
            SELECT 'trigger', id FROM trigger_occurrences
            WHERE @focusRecordId IS NOT NULL AND project_id = @projectId
              AND (@scopeKey IS NULL OR scope_key = @scopeKey)
              AND agent_id = @agentId
              AND (id = @focusRecordId OR trigger_id = @focusRecordId)
          ),
          seeds(kind, id) AS (
            SELECT kind, id FROM recent_seeds
            UNION
            SELECT kind, id FROM focus_seeds
          ),
          base_edges(from_kind, from_id, to_kind, to_id) AS (
            SELECT 'join', member.join_id, 'request', member.request_id
            FROM coordination_join_members member
            JOIN coordination_joins join_record ON join_record.id = member.join_id
            WHERE join_record.project_id = @projectId
              AND (@conversationId IS NULL OR join_record.conversation_id = @conversationId)
            UNION ALL
            SELECT 'join', join_record.id, 'request', continuation.value
            FROM coordination_joins join_record
            JOIN json_each(join_record.continuation_request_ids_json) continuation
            WHERE join_record.project_id = @projectId
              AND (@conversationId IS NULL OR join_record.conversation_id = @conversationId)
            UNION ALL
            SELECT 'request', retry.id, 'request', original.id
            FROM coordination_requests retry
            JOIN coordination_requests original
              ON original.superseded_by_request_id = retry.id
            WHERE retry.project_id = @projectId AND original.project_id = @projectId
              AND (@conversationId IS NULL OR retry.conversation_id = @conversationId)
            UNION ALL
            SELECT 'activation', source.activation_id,
              CASE source.source_kind
                WHEN 'request' THEN 'request'
                WHEN 'request_update' THEN 'request'
                WHEN 'late_result' THEN 'request'
                WHEN 'join' THEN 'join'
                WHEN 'trigger_occurrence' THEN 'trigger'
              END,
              CASE
                WHEN source.source_kind = 'request_update' THEN request_update.request_id
                WHEN source.source_kind = 'late_result' THEN late_result.request_id
                ELSE source.source_id
              END
            FROM activation_sources source
            JOIN agent_activations activation ON activation.id = source.activation_id
            LEFT JOIN coordination_request_updates request_update
              ON source.source_kind = 'request_update' AND request_update.id = source.source_id
            LEFT JOIN coordination_request_late_results late_result
              ON source.source_kind = 'late_result' AND late_result.id = source.source_id
            WHERE activation.project_id = @projectId AND (@scopeKey IS NULL OR activation.scope_key = @scopeKey)
              AND source.source_kind IN ('request', 'request_update', 'late_result', 'join', 'trigger_occurrence')
            UNION ALL
            SELECT 'activation', mapping.source_activation_id, 'activation', mapping.recovery_activation_id
            FROM scheduler_steering_recovery_activations mapping
            JOIN agent_activations recovery ON recovery.id = mapping.recovery_activation_id
            WHERE recovery.project_id = @projectId AND (@scopeKey IS NULL OR recovery.scope_key = @scopeKey)
            UNION ALL
            SELECT 'run', attachment.run_id, 'activation', attachment.activation_id
            FROM scheduler_run_activations attachment
            JOIN scheduler_runs run_record ON run_record.id = attachment.run_id
            WHERE run_record.project_id = @projectId AND (@scopeKey IS NULL OR run_record.scope_key = @scopeKey)
            UNION ALL
            SELECT 'trigger', occurrence.id, 'activation', occurrence.activation_id
            FROM trigger_occurrences occurrence
            WHERE occurrence.project_id = @projectId AND (@scopeKey IS NULL OR occurrence.scope_key = @scopeKey)
              AND occurrence.activation_id IS NOT NULL
          ),
          edges(from_kind, from_id, to_kind, to_id) AS (
            SELECT from_kind, from_id, to_kind, to_id FROM base_edges WHERE to_id IS NOT NULL
            UNION ALL
            SELECT to_kind, to_id, from_kind, from_id FROM base_edges WHERE to_id IS NOT NULL
          ),
          reachable(kind, id) AS (
            SELECT kind, id FROM seeds
            UNION
            SELECT edge.to_kind, edge.to_id
            FROM reachable current
            JOIN edges edge ON edge.from_kind = current.kind AND edge.from_id = current.id
          )
          SELECT kind, id,
            CASE WHEN
              (SELECT COUNT(*) FROM seed_requests) > @seedLimit OR
              (SELECT COUNT(*) FROM seed_joins) > @seedLimit OR
              (SELECT COUNT(*) FROM seed_activations) > @seedLimit OR
              (SELECT COUNT(*) FROM seed_runs) > @seedLimit OR
              (SELECT COUNT(*) FROM seed_triggers) > @seedLimit
            THEN 1 ELSE 0 END AS seed_overflow
          FROM reachable
          ORDER BY CASE WHEN EXISTS (
            SELECT 1 FROM focus_seeds focused
            WHERE focused.kind = reachable.kind AND focused.id = reachable.id
          ) THEN 0 ELSE 1 END
          LIMIT @graphFetchLimit
        `).all({
          projectId: input.projectId,
          conversationId: input.conversationId ?? null,
          scopeKey: scopeKey ?? null,
          agentId: input.agentId,
          focusRecordId: focusRecordId ?? null,
          seedLimit: limit,
          seedFetchLimit: limit + 1,
          graphFetchLimit: graphLimit + 1,
          graphLimit,
        }) as Array<{ kind: GraphKind; id: string; seed_overflow: 0 | 1 }>;
        truncated = graphRows.length > graphLimit || graphRows[0]?.seed_overflow === 1;
        for (const row of graphRows.slice(0, graphLimit)) {
          const ids = selectedIds.get(row.kind) ?? [];
          ids.push(row.id);
          selectedIds.set(row.kind, ids);
        }
      }
      const queryLimit = input.agentId ? graphLimit : limit + 1;
      const trimUnscopedOverflow = <T>(rows: T[]): T[] => {
        if (!input.agentId && rows.length > limit) {
          truncated = true;
          return rows.slice(0, limit);
        }
        return rows;
      };
      const selection = (kind: GraphKind, column: string): { sql: string; params: string[] } => {
        if (!input.agentId) return { sql: "", params: [] };
        const ids = selectedIds.get(kind) ?? [];
        return ids.length
          ? { sql: `AND ${column} IN (${ids.map(() => "?").join(", ")})`, params: ids }
          : { sql: "AND 0", params: [] };
      };
      const items = new Map<string, import("@ponderosa/core").AgentWorkItemDto>();
      const relationSets = new Map<string, Set<string>>();
      const add = (item: import("@ponderosa/core").AgentWorkItemDto): void => {
        items.set(item.id, item);
        relationSets.set(item.id, new Set(item.relatedItemIds));
      };
      const relate = (left: string, right: string): void => {
        if (left === right) return;
        relationSets.set(left, relationSets.get(left) ?? new Set());
        relationSets.set(right, relationSets.get(right) ?? new Set());
        relationSets.get(left)!.add(right);
        relationSets.get(right)!.add(left);
      };
      const requestSelection = selection("request", "id");
      const requestRows = trimUnscopedOverflow(this.sqlite.prepare(`
        SELECT id, requester_agent_id, recipient_agent_id, state, payload_json,
          superseded_by_request_id, communication_event_id, created_at, updated_at
        FROM coordination_requests
        WHERE project_id = ?
          AND (? IS NULL OR conversation_id = ?)
          ${requestSelection.sql}
        ORDER BY CASE WHEN state IN ('open', 'in_progress', 'waiting_dependency', 'awaiting_answer') THEN 0 ELSE 1 END,
          updated_at DESC, id DESC LIMIT ?
      `).all(
        input.projectId, input.conversationId ?? null, input.conversationId ?? null,
        ...requestSelection.params, queryLimit,
      ) as Array<{
        id: string; requester_agent_id: string | null; recipient_agent_id: string; state: string;
        payload_json: string; superseded_by_request_id: string | null;
        communication_event_id: string | null; created_at: string; updated_at: string;
      }>);
      for (const row of requestRows) {
        const id = `request:${row.id}`;
        add({
          id, recordId: row.id, referenceIds: [row.id, ...(row.communication_event_id ? [row.communication_event_id] : [])],
          kind: "request", state: row.state, title: "Assigned work",
          summary: boundedRequestPreview(row.payload_json) ??
            (row.state === "completed" ? "The assigned work was reported finished."
            : ["open", "in_progress", "waiting_dependency", "awaiting_answer"].includes(row.state)
              ? "The assigned work is still open." : `The assigned work ended ${row.state.replaceAll("_", " ")}.`),
          agentIds: [...new Set([row.requester_agent_id, row.recipient_agent_id].filter((value): value is string => Boolean(value)))],
          ...(row.requester_agent_id ? { requesterAgentId: row.requester_agent_id } : {}),
          recipientAgentId: row.recipient_agent_id,
          relatedItemIds: [],
          createdAt: row.created_at, updatedAt: row.updated_at,
        });
      }
      for (const row of requestRows) {
        if (row.superseded_by_request_id) {
          relate(`request:${row.superseded_by_request_id}`, `request:${row.id}`);
        }
      }

      const joinSelection = selection("join", "id");
      const joinRows = trimUnscopedOverflow(this.sqlite.prepare(`
        SELECT id, owner_agent_id, state, created_at, updated_at
        FROM coordination_joins
        WHERE project_id = ? AND (? IS NULL OR conversation_id = ?) ${joinSelection.sql}
        ORDER BY CASE WHEN state = 'open' THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT ?
      `).all(
        input.projectId, input.conversationId ?? null, input.conversationId ?? null,
        ...joinSelection.params, queryLimit,
      ) as Array<{
        id: string; owner_agent_id: string; state: string; created_at: string; updated_at: string;
      }>);
      for (const row of joinRows) add({
        id: `join:${row.id}`, recordId: row.id, referenceIds: [row.id], kind: "join", state: row.state,
        title: "Waiting for work", summary: row.state === "open" ? "The Agent is holding until enough assigned work returns."
          : row.state === "satisfied" ? "The required results arrived." : `The wait ended ${row.state}.`,
        agentIds: [row.owner_agent_id], relatedItemIds: [],
        createdAt: row.created_at, updatedAt: row.updated_at,
      });

      const activationSelection = selection("activation", "id");
      const activationRows = trimUnscopedOverflow(this.sqlite.prepare(`
        SELECT id, agent_id, kind, state, delivery_failures,
          provider_failure_category, available_at, created_at, updated_at
        FROM agent_activations
        WHERE project_id = ? AND (? IS NULL OR scope_key = ?) ${activationSelection.sql}
        ORDER BY CASE WHEN state IN ('pending', 'retry_pending', 'attached') THEN 0 ELSE 1 END,
          updated_at DESC, id DESC LIMIT ?
      `).all(
        input.projectId, scopeKey ?? null, scopeKey ?? null,
        ...activationSelection.params, queryLimit,
      ) as Array<{
        id: string; agent_id: string; kind: string; state: string;
        delivery_failures: number; available_at: string;
        provider_failure_category: string | null;
        created_at: string; updated_at: string;
      }>);
      for (const row of activationRows) {
        const providerFailure: "capacity" | "rate_limit" | undefined =
          row.provider_failure_category === "capacity" ||
          row.provider_failure_category === "rate_limit"
          ? row.provider_failure_category as "capacity" | "rate_limit"
          : undefined;
        const providerRecovery = row.state === "retry_pending" && providerFailure ? {
          classification: providerFailure,
          activationIds: [row.id],
          retryEligible: true,
          blockedAt: row.updated_at,
          nextRetryAt: row.available_at,
          deliveryFailures: row.delivery_failures,
        } : undefined;
        add({
          id: `activation:${row.id}`, recordId: row.id, referenceIds: [row.id], kind: "activation", state: row.state,
          title: row.kind === "coordination_late_result" ? "Late result needs audit" : "Queued wake-up",
          summary: providerRecovery
            ? `Provider ${providerRecovery.classification === "capacity" ? "capacity" : "quota"} is unavailable; this wake-up is retained for retry.`
            : row.kind === "coordination_late_result"
              ? "A recipient finished after the original outcome became uncertain. Audit current state; do not redo the work."
              : ["pending", "retry_pending", "attached"].includes(row.state)
                ? "Work is queued or being attached to a Run." : row.state === "consumed" ? "The wake-up was consumed by its Run."
                  : `The wake-up ended ${row.state.replaceAll("_", " ")}.`,
          agentIds: [row.agent_id], relatedItemIds: [],
          ...(providerRecovery ? { providerRecovery } : {}),
          createdAt: row.created_at, updatedAt: row.updated_at,
        });
      }

      const runSelection = selection("run", "scheduler.id");
      const runRows = trimUnscopedOverflow(this.sqlite.prepare(`
        SELECT scheduler.id, scheduler.agent_id, scheduler.status, scheduler.created_at, scheduler.updated_at,
          provider.execution_id, execution.title, execution.started_at
        FROM scheduler_runs scheduler
        LEFT JOIN provider_inputs provider ON provider.scheduler_run_id = scheduler.id
        LEFT JOIN runs execution ON execution.id = provider.execution_id AND execution.agent_id = scheduler.agent_id
        WHERE scheduler.project_id = ? AND (? IS NULL OR scheduler.scope_key = ?) ${runSelection.sql}
        ORDER BY CASE WHEN scheduler.status IN ('leased', 'running') THEN 0 ELSE 1 END,
          scheduler.updated_at DESC, scheduler.id DESC LIMIT ?
      `).all(
        input.projectId, scopeKey ?? null, scopeKey ?? null,
        ...runSelection.params, queryLimit,
      ) as Array<{
        id: string; agent_id: string; status: string; created_at: string; updated_at: string;
        execution_id: string | null; title: string | null; started_at: string | null;
      }>);
      for (const row of runRows) {
        const recordId = row.execution_id ?? row.id;
        add({
          id: `run:${recordId}`, recordId, referenceIds: [...new Set([recordId, row.id])], kind: "run",
          state: row.status, title: row.title ?? "Agent Run",
          summary: ["leased", "running"].includes(row.status) ? "The Agent is currently running."
            : row.status === "completed" ? "The Run finished." : `The Run ended ${row.status.replaceAll("_", " ")}.`,
          agentIds: [row.agent_id], relatedItemIds: [],
          createdAt: row.started_at ?? row.created_at, updatedAt: row.updated_at,
        });
      }

      const triggerSelection = selection("trigger", "occurrence.id");
      const occurrenceRows = trimUnscopedOverflow(this.sqlite.prepare(`
        SELECT occurrence.id, occurrence.trigger_id, occurrence.agent_id, occurrence.state, occurrence.activation_id,
          CASE WHEN json_valid(occurrence.trigger_snapshot_json)
            THEN json_extract(occurrence.trigger_snapshot_json, '$.name') END AS snapshot_name,
          occurrence.occurred_at, occurrence.created_at, occurrence.updated_at,
          definition.name
        FROM trigger_occurrences occurrence
        LEFT JOIN trigger_definitions definition ON definition.id = occurrence.trigger_id
        WHERE occurrence.project_id = ? AND (? IS NULL OR occurrence.scope_key = ?) ${triggerSelection.sql}
        ORDER BY CASE WHEN occurrence.state = 'pending' THEN 0 ELSE 1 END,
          occurrence.updated_at DESC, occurrence.id DESC LIMIT ?
      `).all(
        input.projectId, scopeKey ?? null, scopeKey ?? null,
        ...triggerSelection.params, queryLimit,
      ) as Array<{
        id: string; trigger_id: string; agent_id: string; state: string; activation_id: string | null; occurred_at: string;
        created_at: string; updated_at: string; name: string | null; snapshot_name: string | null;
      }>);
      for (const row of occurrenceRows) {
        add({
          id: `trigger:${row.id}`, recordId: row.id, referenceIds: [row.id, row.trigger_id], kind: "trigger", state: row.state,
          title: row.name ?? row.snapshot_name ?? "Automation occurrence",
          summary: row.state === "activated" ? "This outside event queued work for the Agent."
            : row.state === "pending" ? "This outside event is waiting to queue work."
              : `This outside event ended ${row.state.replaceAll("_", " ")}.`,
          agentIds: [row.agent_id], relatedItemIds: [],
          createdAt: row.occurred_at ?? row.created_at, updatedAt: row.updated_at,
        });
        if (row.activation_id) relate(`trigger:${row.id}`, `activation:${row.activation_id}`);
      }

      const loadedRequestIds = requestRows.map((row) => row.id);
      const loadedJoinIds = joinRows.map((row) => row.id);
      const loadedActivationIds = activationRows.map((row) => row.id);
      const loadedRunIds = runRows.map((row) => row.id);
      const linkedSelection = (
        leftColumn: string,
        leftIds: string[],
        rightColumn?: string,
        rightIds: string[] = [],
      ): { sql: string; params: string[] } => {
        const clauses: string[] = [];
        const params: string[] = [];
        if (leftIds.length) {
          clauses.push(`${leftColumn} IN (${leftIds.map(() => "?").join(", ")})`);
          params.push(...leftIds);
        }
        if (rightColumn && rightIds.length) {
          clauses.push(`${rightColumn} IN (${rightIds.map(() => "?").join(", ")})`);
          params.push(...rightIds);
        }
        return { sql: clauses.length ? `AND (${clauses.join(" OR ")})` : "AND 0", params };
      };

      const joinLinkSelection = linkedSelection("member.join_id", loadedJoinIds, "member.request_id", loadedRequestIds);
      const joinLinks = this.sqlite.prepare(`
        SELECT member.join_id, member.request_id
        FROM coordination_join_members member
        JOIN coordination_joins join_record ON join_record.id = member.join_id
        WHERE join_record.project_id = ? AND (? IS NULL OR join_record.conversation_id = ?)
          ${joinLinkSelection.sql}
        ORDER BY member.join_id, member.position
      `).all(input.projectId, input.conversationId ?? null, input.conversationId ?? null, ...joinLinkSelection.params) as Array<{ join_id: string; request_id: string }>;
      for (const row of joinLinks) {
        relate(`join:${row.join_id}`, `request:${row.request_id}`);
        const joinItem = items.get(`join:${row.join_id}`);
        if (joinItem) joinItem.joinMemberRequestIds = [
          ...(joinItem.joinMemberRequestIds ?? []),
          row.request_id,
        ];
      }

      const continuationSelection = linkedSelection("join_record.id", loadedJoinIds, "continuation.value", loadedRequestIds);
      const continuationLinks = this.sqlite.prepare(`
        SELECT join_record.id AS join_id, continuation.value AS request_id
        FROM coordination_joins join_record
        JOIN json_each(join_record.continuation_request_ids_json) continuation
        WHERE join_record.project_id = ? AND (? IS NULL OR join_record.conversation_id = ?)
          ${continuationSelection.sql}
      `).all(input.projectId, input.conversationId ?? null, input.conversationId ?? null, ...continuationSelection.params) as Array<{ join_id: string; request_id: string }>;
      for (const row of continuationLinks) relate(`join:${row.join_id}`, `request:${row.request_id}`);

      const activationLinkSelection = linkedSelection("source.activation_id", loadedActivationIds);
      const activationLinks = this.sqlite.prepare(`
        SELECT source.activation_id, source.source_kind, source.source_id,
          COALESCE(request_update.request_id, late_result.request_id) AS request_id
        FROM activation_sources source
        JOIN agent_activations activation ON activation.id = source.activation_id
        LEFT JOIN coordination_request_updates request_update
          ON source.source_kind = 'request_update' AND request_update.id = source.source_id
        LEFT JOIN coordination_request_late_results late_result
          ON source.source_kind = 'late_result' AND late_result.id = source.source_id
        WHERE activation.project_id = ? AND (? IS NULL OR activation.scope_key = ?)
          ${activationLinkSelection.sql}
      `).all(input.projectId, scopeKey ?? null, scopeKey ?? null, ...activationLinkSelection.params) as Array<{
        activation_id: string; source_kind: string; source_id: string; request_id: string | null;
      }>;
      for (const row of activationLinks) {
        const sourceKind = row.source_kind === "trigger_occurrence" ? "trigger" : row.source_kind;
        if (["request", "join", "trigger"].includes(sourceKind)) relate(`activation:${row.activation_id}`, `${sourceKind}:${row.source_id}`);
        if (row.source_kind === "request_update" && row.request_id) relate(`activation:${row.activation_id}`, `request:${row.request_id}`);
        if (row.source_kind === "late_result" && row.request_id) relate(`activation:${row.activation_id}`, `request:${row.request_id}`);
        const activationItem = items.get(`activation:${row.activation_id}`);
        if (activationItem && !activationItem.referenceIds.includes(row.source_id)) activationItem.referenceIds.push(row.source_id);
      }

      const recoverySelection = linkedSelection(
        "mapping.source_activation_id", loadedActivationIds,
        "mapping.recovery_activation_id", loadedActivationIds,
      );
      const recoveryLinks = this.sqlite.prepare(`
        SELECT mapping.source_activation_id, mapping.recovery_activation_id
        FROM scheduler_steering_recovery_activations mapping
        JOIN agent_activations recovery ON recovery.id = mapping.recovery_activation_id
        WHERE recovery.project_id = ? AND (? IS NULL OR recovery.scope_key = ?)
          ${recoverySelection.sql}
      `).all(input.projectId, scopeKey ?? null, scopeKey ?? null, ...recoverySelection.params) as Array<{ source_activation_id: string; recovery_activation_id: string }>;
      for (const row of recoveryLinks) relate(`activation:${row.source_activation_id}`, `activation:${row.recovery_activation_id}`);

      const runLinkSelection = linkedSelection("attachment.run_id", loadedRunIds, "attachment.activation_id", loadedActivationIds);
      const runLinks = this.sqlite.prepare(`
        SELECT attachment.run_id, attachment.activation_id, provider.execution_id
        FROM scheduler_run_activations attachment
        JOIN scheduler_runs run_record ON run_record.id = attachment.run_id
        LEFT JOIN provider_inputs provider ON provider.scheduler_run_id = attachment.run_id
        WHERE run_record.project_id = ? AND (? IS NULL OR run_record.scope_key = ?)
          ${runLinkSelection.sql}
      `).all(input.projectId, scopeKey ?? null, scopeKey ?? null, ...runLinkSelection.params) as Array<{ run_id: string; activation_id: string; execution_id: string | null }>;
      for (const row of runLinks) relate(`run:${row.execution_id ?? row.run_id}`, `activation:${row.activation_id}`);

      for (const item of items.values()) {
        item.relatedItemIds = [...(relationSets.get(item.id) ?? [])].filter((id) => items.has(id)).sort();
      }
      const projected = [...items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      return { items: projected, truncated };
    }

  /** Loads one scoped Request and its canonical update history in chronological
   * order. The request-id index keeps this lazy read independent of total
   * coordination history size. */
    requestLifecycleDetails(input: {
      projectId: string;
      conversationId?: string;
      recordId: string;
    }): CoordinationRequestLifecycleDto | undefined {
      const request = this.sqlite.prepare(`
        SELECT id, requester_agent_id, recipient_agent_id, state, version,
          payload_json, communication_event_id, created_at, updated_at
        FROM coordination_requests
        WHERE id = ? AND project_id = ? AND (? IS NULL OR conversation_id = ?)
      `).get(
        input.recordId,
        input.projectId,
        input.conversationId ?? null,
        input.conversationId ?? null,
      ) as {
        id: string;
        requester_agent_id: string | null;
        recipient_agent_id: string;
        state: CoordinationRequestState;
        version: number;
        payload_json: string;
        communication_event_id: string | null;
        created_at: string;
        updated_at: string;
      } | undefined;
      if (!request) return undefined;

      const selectedUpdateRows = this.sqlite.prepare(`
        SELECT * FROM (
          SELECT id, kind, actor_kind, actor_id, in_reply_to_update_id,
            payload_json, resulting_state, resulting_version, created_at,
            COALESCE(provider_failure_category, (
              SELECT COALESCE(activation.provider_failure_category, 'unknown')
              FROM agent_activations activation
              WHERE json_valid(coordination_request_updates.payload_json)
                AND activation.id = json_extract(
                  coordination_request_updates.payload_json, '$.activationId'
                )
                AND EXISTS (
                  SELECT 1 FROM scheduler_run_activations attached
                  JOIN scheduler_runs scheduler ON scheduler.id = attached.run_id
                  WHERE attached.activation_id = activation.id
                    AND scheduler.provider_failure_json IS NOT NULL
                )
              LIMIT 1
            )) AS provider_failure_category
          FROM coordination_request_updates
          WHERE request_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        ) recent_updates
        ORDER BY created_at, id
      `).all(request.id, REQUEST_LIFECYCLE_UPDATE_LIMIT + 1) as Array<{
        id: string;
        kind: CoordinationRequestUpdateKind;
        actor_kind: "agent" | "user" | "system" | "supervisor";
        actor_id: string | null;
        in_reply_to_update_id: string | null;
        payload_json: string;
        resulting_state: CoordinationRequestState;
        resulting_version: number;
        created_at: string;
        provider_failure_category: string | null;
      }>;
      const updatesTruncated = selectedUpdateRows.length > REQUEST_LIFECYCLE_UPDATE_LIMIT;
      const updateRows = updatesTruncated ? selectedUpdateRows.slice(1) : selectedUpdateRows;
      const artifactsByUpdate = new Map<
        string,
        CoordinationRequestLifecycleDto["updates"][number]["artifacts"]
      >();
      if (updateRows.length > 0) {
        const placeholders = updateRows.map(() => "?").join(", ");
        const artifactRows = this.sqlite.prepare(`
          SELECT id, owner_id, title, media_type, byte_length
          FROM runtime_artifacts
          WHERE owner_kind = 'request_update' AND owner_id IN (${placeholders})
          ORDER BY created_at, id
        `).all(...updateRows.map((update) => update.id)) as Array<{
          id: string;
          owner_id: string;
          title: string;
          media_type: string;
          byte_length: number;
        }>;
        for (const artifact of artifactRows) {
          const artifacts = artifactsByUpdate.get(artifact.owner_id) ?? [];
          artifacts.push({
            id: artifact.id,
            title: artifact.title,
            mediaType: artifact.media_type,
            byteLength: artifact.byte_length,
          });
          artifactsByUpdate.set(artifact.owner_id, artifacts);
        }
      }

      const requestPayload = parseStoredJson(request.payload_json);
      const requestText = boundedLifecycleText(requestPayload);
      return {
        request: {
          id: request.id,
          ...(request.requester_agent_id
            ? { requesterAgentId: request.requester_agent_id }
            : {}),
          recipientAgentId: request.recipient_agent_id,
          state: request.state,
          version: request.version,
          ...(requestText.text ? { text: requestText.text } : {}),
          ...(requestText.truncated ? { textTruncated: true as const } : {}),
          refs: payloadRefs(requestPayload),
          ...(request.communication_event_id
            ? { communicationEventId: request.communication_event_id }
            : {}),
          createdAt: request.created_at,
          updatedAt: request.updated_at,
        },
        updates: updateRows.map((row) => {
          const payload = parseStoredJson(row.payload_json);
          const text = row.provider_failure_category
            ? {
                text: publicProviderFailureSummary(
                  undefined,
                  row.provider_failure_category,
                ) ?? "Provider execution failed.",
              }
            : boundedLifecycleText(payload);
          const artifacts = artifactsByUpdate.get(row.id) ?? [];
          return {
            id: row.id,
            kind: row.kind,
            actorKind: row.actor_kind,
            ...(row.actor_id ? { actorId: row.actor_id } : {}),
            ...(row.in_reply_to_update_id
              ? { inReplyToUpdateId: row.in_reply_to_update_id }
              : {}),
            ...(text.text ? { text: text.text } : {}),
            ...(text.truncated ? { textTruncated: true as const } : {}),
            refs: [
              ...new Set([
                ...payloadRefs(payload),
                ...artifacts.map((artifact) => `ponderosa://artifact/${artifact.id}`),
              ]),
            ],
            artifacts,
            resultingState: row.resulting_state,
            resultingVersion: row.resulting_version,
            createdAt: row.created_at,
          };
        }),
        ...(updatesTruncated ? { updatesTruncated: true as const } : {}),
      };
    }

  /** Loads the technical fields for one canonical inspector record without
     * materializing payloads for the rest of the graph. */
    agentWorkItemDetails(input: {
      projectId: string;
      conversationId?: string;
      kind: "request" | "join" | "activation" | "run" | "trigger";
      recordId: string;
    }): Array<{ label: string; value: string }> | undefined {
      const scopeKey = input.conversationId ? `conversation:${input.conversationId}` : undefined;
      if (input.kind === "request") {
        const row = this.sqlite.prepare(`
          SELECT id, requester_agent_id, recipient_agent_id, version, lifetime_kind, deadline_at,
            payload_json, communication_event_id, terminal_at
          FROM coordination_requests
          WHERE id = ? AND project_id = ? AND (? IS NULL OR conversation_id = ?)
        `).get(input.recordId, input.projectId, input.conversationId ?? null, input.conversationId ?? null) as {
          id: string; requester_agent_id: string | null; recipient_agent_id: string; version: number;
          lifetime_kind: string; deadline_at: string | null; payload_json: string;
          communication_event_id: string | null; terminal_at: string | null;
        } | undefined;
        return row ? inspectorDetails(
          ["Request ID", row.id], ["Requester Agent ID", row.requester_agent_id ?? "user"],
          ["Recipient Agent ID", row.recipient_agent_id], ["Version", row.version], ["Lifetime", row.lifetime_kind],
          ["Deadline", row.deadline_at], ["Communication event", row.communication_event_id],
          ["Payload", inspectorJson(row.payload_json)], ["Terminal time", row.terminal_at],
        ) : undefined;
      }
      if (input.kind === "join") {
        const row = this.sqlite.prepare(`
          SELECT id, mode, wake_policy, quorum, satisfying_outcomes_json, deadline_at, terminal_at
          FROM coordination_joins
          WHERE id = ? AND project_id = ? AND (? IS NULL OR conversation_id = ?)
        `).get(input.recordId, input.projectId, input.conversationId ?? null, input.conversationId ?? null) as {
          id: string; mode: string; wake_policy: CoordinationJoinWakePolicy; quorum: number; satisfying_outcomes_json: string;
          deadline_at: string | null; terminal_at: string | null;
        } | undefined;
        return row ? inspectorDetails(["Join ID", row.id], ["Mode", row.mode],
          ["Wake policy", inspectorWakePolicy(row.wake_policy)], ["Quorum", row.quorum],
          ["Accepted outcomes", inspectorJson(row.satisfying_outcomes_json)], ["Deadline", row.deadline_at],
          ["Terminal time", row.terminal_at]) : undefined;
      }
      if (input.kind === "activation") {
        const row = this.sqlite.prepare(`
          SELECT id, kind, priority, dispatch_policy, prompt_class, delivery_failures, terminal_outcome,
            last_delivery_error, provider_failure_category,
            EXISTS (
              SELECT 1 FROM scheduler_run_activations attached
              JOIN scheduler_runs scheduler ON scheduler.id = attached.run_id
              WHERE attached.activation_id = agent_activations.id
                AND scheduler.provider_failure_json IS NOT NULL
            ) AS has_provider_failure,
            payload_json, terminal_at
          FROM agent_activations
          WHERE id = ? AND project_id = ? AND (? IS NULL OR scope_key = ?)
        `).get(input.recordId, input.projectId, scopeKey ?? null, scopeKey ?? null) as {
          id: string; kind: string; priority: number; dispatch_policy: string; prompt_class: string;
          delivery_failures: number; terminal_outcome: string | null; last_delivery_error: string | null;
          provider_failure_category: string | null; has_provider_failure: number;
          payload_json: string; terminal_at: string | null;
        } | undefined;
        const lastDeliveryError = row ? publicActivationDeliveryError({
          lastDeliveryError: row.last_delivery_error,
          providerFailureCategory: row.provider_failure_category,
          hasProviderFailure: Boolean(row.has_provider_failure),
        }) : undefined;
        const publicPayload = row
          ? JSON.stringify(providerSafeActivationPayload(this.sqlite, row.id, row.payload_json))
          : undefined;
        return row ? inspectorDetails(["Activation ID", row.id], ["Kind", row.kind], ["Priority", row.priority],
          ["Dispatch", row.dispatch_policy], ["Prompt class", row.prompt_class], ["Delivery failures", row.delivery_failures],
          ["Terminal outcome", row.terminal_outcome], ["Last error", lastDeliveryError],
          ["Payload", inspectorJson(publicPayload ?? "{}")], ["Terminal time", row.terminal_at]) : undefined;
      }
      if (input.kind === "run") {
        const row = this.sqlite.prepare(`
          SELECT scheduler.id, scheduler.status, scheduler.fencing_token, scheduler.prompt_injection_state,
            scheduler.context_disposition, scheduler.lease_expires_at, scheduler.terminal_at,
            CASE WHEN scheduler.provider_failure_json IS NULL THEN 0 ELSE 1 END AS has_provider_failure,
            json_extract(
              CASE WHEN json_valid(scheduler.provider_failure_json)
                THEN scheduler.provider_failure_json ELSE '{}' END,
              '$.category'
            ) AS provider_failure_category,
            provider.execution_id, provider.prompt_hash, execution.status AS execution_status,
            execution.wake_cause, execution.completed_at
          FROM scheduler_runs scheduler
          LEFT JOIN provider_inputs provider ON provider.scheduler_run_id = scheduler.id
          LEFT JOIN runs execution ON execution.id = provider.execution_id AND execution.agent_id = scheduler.agent_id
          WHERE scheduler.project_id = ? AND (scheduler.id = ? OR provider.execution_id = ?)
            AND (? IS NULL OR scheduler.scope_key = ?)
        `).get(input.projectId, input.recordId, input.recordId, scopeKey ?? null, scopeKey ?? null) as {
          id: string; status: string; fencing_token: number; prompt_injection_state: string; context_disposition: string;
          lease_expires_at: string; terminal_at: string | null; execution_id: string | null; prompt_hash: string | null;
          execution_status: string | null; wake_cause: string | null; completed_at: string | null;
          has_provider_failure: 0 | 1;
          provider_failure_category: string | null;
        } | undefined;
        const providerFailureSummary = row?.has_provider_failure
          ? publicProviderFailureSummary(undefined, row.provider_failure_category ?? "unknown")
          : undefined;
        return row ? inspectorDetails(["Execution Run ID", row.execution_id], ["Scheduler Run ID", row.id],
          ["Scheduler status", row.status], ["Execution projection status", row.execution_status], ["Wake cause", row.wake_cause],
          ["Fence", row.fencing_token], ["Prompt injection", row.prompt_injection_state],
          ["Provider context", row.context_disposition], ["Prompt hash", row.prompt_hash],
          ["Provider failure summary", providerFailureSummary],
          ["Operator action", providerFailureSummary
            ? "Review provider access and retry the affected work when the provider is available."
            : undefined],
          ["Lease expires", row.lease_expires_at], ["Scheduler terminal time", row.terminal_at],
          ["Execution completed time", row.completed_at]) : undefined;
      }
      const row = this.sqlite.prepare(`
        SELECT id, trigger_id, attempts, input_hash, last_error, trigger_snapshot_json
        FROM trigger_occurrences
        WHERE id = ? AND project_id = ? AND (? IS NULL OR scope_key = ?)
      `).get(input.recordId, input.projectId, scopeKey ?? null, scopeKey ?? null) as {
        id: string; trigger_id: string; attempts: number; input_hash: string;
        last_error: string | null; trigger_snapshot_json: string;
      } | undefined;
      return row ? inspectorDetails(["Occurrence ID", row.id], ["Automation ID", row.trigger_id], ["Attempts", row.attempts],
        ["Input hash", row.input_hash], ["Last error", row.last_error],
        ["Automation snapshot", inspectorJson(row.trigger_snapshot_json)]) : undefined;
    }
}
