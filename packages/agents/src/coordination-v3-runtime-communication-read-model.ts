import { PONDEROSA_BROWSER_TOOLS, type MessageDeliveryReceiptDto } from "@ponderosa/core";
import type Database from "better-sqlite3";
import type {
  RuntimeArtifactV3,
  RuntimeCommunicationV3View,
} from "./coordination-v3-types.js";
import type { CoordinationV3RuntimeScopeAuthority } from "./coordination-v3-runtime-scope-authority.js";
import { AgentPhaseReadModel } from "./store-agent-phase-read-model.js";

const browserTools = new Set(PONDEROSA_BROWSER_TOOLS.map(tool => tool.name));

function deliveryRuntime(payloadJson: string): MessageDeliveryReceiptDto["runtime"] {
  try {
    const payload = JSON.parse(payloadJson) as { dispatch?: Record<string, unknown> };
    const dispatch = payload.dispatch;
    if (!dispatch) return undefined;
    const runtime = Object.fromEntries(
      ["engine", "model", "effort", "speed"].flatMap(key => {
        const value = dispatch[key];
        return typeof value === "string" && value.trim() ? [[key, value.trim()]] : [];
      }),
    );
    return Object.keys(runtime).length ? runtime : undefined;
  } catch {
    return undefined;
  }
}

export class CoordinationV3RuntimeCommunicationReadModel {
  private readonly phaseReadModel: AgentPhaseReadModel;
  constructor(
    private readonly sqlite: Database.Database,
    private readonly runtimeScopeAuthority: CoordinationV3RuntimeScopeAuthority,
  ) { this.phaseReadModel = new AgentPhaseReadModel(sqlite); }

  private steeringWaitReason(activation: {
    id: string; agent_id: string; scope_key: string; dispatch_policy: string; kind: string;
    state: string; steering_wait_reason: string | null;
  }): MessageDeliveryReceiptDto["steeringWaitReason"] {
    if (activation.dispatch_policy !== "steer_or_run" ||
      !["pending", "retry_pending"].includes(activation.state)) return undefined;
    const now = new Date().toISOString();
    const barrier = this.sqlite.prepare(`
      SELECT run.status,
        EXISTS (SELECT 1 FROM context_rollovers rollover
          WHERE rollover.agent_id = run.agent_id
            AND rollover.state IN ('requested', 'handoff_committed', 'session_retiring', 'continuation_ready')) AS rollover,
        EXISTS (SELECT 1 FROM scheduler_prompt_injections injection
          WHERE injection.run_id = run.id AND injection.kind = 'steer'
            AND injection.state IN ('pending', 'submitted')) AS prior_steering,
        EXISTS (SELECT 1 FROM activation_outbox outbox WHERE outbox.activation_id = ?
          AND outbox.event_kind = 'communication_revision' AND outbox.processed_at IS NULL) AS revision
      FROM scheduler_runs run
      WHERE run.agent_id = ? AND run.scope_key = ? AND run.status IN ('leased', 'running')
        AND run.lease_expires_at > ?
      ORDER BY run.created_at DESC LIMIT 1
    `).get(activation.id, activation.agent_id, activation.scope_key, now) as {
      status: string; rollover: number; prior_steering: number; revision: number;
    } | undefined;
    if (!barrier) return undefined; // Steer-or-run now awaits a new Run, not active steering.
    if (barrier.revision) return "revision_pending";
    if (barrier.rollover && activation.kind !== "context_rollover_handoff") return "context_refresh";
    if (barrier.prior_steering) return "prior_steering";
    if (barrier.status === "leased") return "run_starting";
    // The last observed deferral remains useful until another attempt is
    // admitted. Passing available_at only permits a retry; it proves neither
    // provider readiness nor an attempted/accepted steer.
    if (activation.state === "retry_pending") {
      if (activation.steering_wait_reason === "provider_not_ready") return "provider_not_ready";
      if (activation.steering_wait_reason === "provider_unsupported") return "provider_unsupported";
      if (activation.steering_wait_reason === "preparation_retry") return "preparation_retry";
    }
    return "scheduler_pending";
  }

  private liveProgressActivity(agentId: string, executionId: string): NonNullable<MessageDeliveryReceiptDto["liveProgress"]>["activity"] {
    // Reuse the exact open-call projection: missing call IDs, completed calls,
    // unrelated Runs and prose do not establish an ongoing activity.
    const phase = this.phaseReadModel.activeExecutionPhase(agentId, executionId);
    if (phase?.kind === "running_command") return "command";
    if (phase?.kind !== "using_tool") return "working";
    const tool = this.sqlite.prepare(`
      SELECT substr(json_extract(event_json, '$.name'), 1, 256) AS name
      FROM activity_projection
      WHERE agent_id = ? AND execution_id = ? AND event_type = 'tool_call'
        AND json_extract(event_json, '$.id') = ?
      ORDER BY seq DESC LIMIT 1
    `).get(agentId, executionId, phase.callId) as { name: string | null } | undefined;
    const name = typeof tool?.name === "string" ? tool.name.split(/\.|__/u).at(-1) : undefined;
    return name && browserTools.has(name) ? "browser" : "tool";
  }

  /** Scope comes from a canonical human delivery, never from an Agent roster,
   * message prose, or the merged Work log. Unknown historical evidence fails closed. */
  private liveProgress(projectId: string, agentId: string, activationId: string, injection: {
    id: string; run_id: string; state: string; execution_id: string | null; acknowledged_at: string | null;
  }): MessageDeliveryReceiptDto["liveProgress"] {
    if (injection.state !== "acknowledged" || !injection.execution_id || !injection.acknowledged_at) return undefined;
    const eligible = this.sqlite.prepare(`
      SELECT agent.handle
      FROM scheduler_runs run
      JOIN agents agent ON agent.id = run.agent_id
      JOIN agent_activations cause ON cause.id = ? AND cause.scope_key = run.scope_key
      WHERE run.id = ? AND run.project_id = ? AND run.agent_id = ?
        AND run.status = 'running' AND run.lease_expires_at > ?
        AND agent.deleted_at IS NULL
        AND json_extract(cause.payload_json, '$.communication.sender.kind') = 'user'
        AND json_extract(cause.payload_json, '$.communication.intent') IN ('broadcast', 'user_dm')
        AND NOT EXISTS (
          SELECT 1 FROM runtime_communications reply
          WHERE reply.project_id = run.project_id
            AND json_extract(reply.sender_json, '$.agentId') = run.agent_id
            AND json_extract(reply.sender_json, '$.executionId') = ?
            AND reply.created_at >= ?
            AND reply.intent = json_extract(cause.payload_json, '$.communication.intent')
            AND json_extract(reply.payload_json, '$.communication.conversationId')
              IS json_extract(cause.payload_json, '$.communication.conversationId')
        )
        AND (SELECT latest.id FROM scheduler_prompt_injections latest
             WHERE latest.run_id = run.id ORDER BY latest.sequence DESC LIMIT 1) = ?
        AND (SELECT candidate.id FROM scheduler_prompt_injections current, json_each(current.activation_ids_json) member
             JOIN agent_activations candidate ON candidate.id = member.value
             WHERE current.id = ? ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1) = ?
    `).get(activationId, injection.run_id, projectId, agentId, new Date().toISOString(),
      injection.execution_id, injection.acknowledged_at, injection.id,
      injection.id, activationId) as { handle: string } | undefined;
    if (!eligible) return undefined;
    // substr runs in SQLite, before a possibly large delta crosses into JS.
    const progress = this.sqlite.prepare(`
      SELECT substr(json_extract(payload_json, '$.delta'), 1, 1201) AS text, seq, created_at
      FROM events
      WHERE agent_id = ? AND json_extract(payload_json, '$.executionId') = ?
        AND json_extract(payload_json, '$.progressInjectionId') = ?
        AND type = 'text' AND json_extract(payload_json, '$.presentation') = 'progress'
      ORDER BY seq DESC LIMIT 1
    `).get(agentId, injection.execution_id, injection.id) as { text: string; seq: number; created_at: string } | undefined;
    if (!progress || typeof progress.text !== "string" || !progress.text.trim()) return undefined;
    const characters = Array.from(progress.text);
    return { text: characters.slice(0, 1200).join("").trimEnd(), createdAt: progress.created_at,
      seq: progress.seq, recipientHandle: eligible.handle, activity: this.liveProgressActivity(agentId, injection.execution_id),
      ...(characters.length > 1200 ? { truncated: true as const } : {}) };
  }

  runtimeCommunications(projectId?: string): RuntimeCommunicationV3View[] {
    const rows = this.sqlite.prepare(`
      SELECT id, project_id, audience_json, payload_json, created_at
      FROM runtime_communications
      WHERE (? IS NULL OR project_id = ?)
      ORDER BY created_at, id
    `).all(projectId ?? null, projectId ?? null) as Array<{
      id: string;
      project_id: string;
      audience_json: string;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      audience: JSON.parse(row.audience_json) as unknown,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
      sourceKind: "runtime" as const,
    }));
  }

  /** Provider coordination commits its deterministic Communication identity in
   * the Request transaction. Return only rows whose Agent audit projection is
   * incomplete so startup can close the post-commit projection crash window. */
  requestCommunicationsNeedingProjection(projectId?: string, communicationEventId?: string): RuntimeCommunicationV3View[] {
    const rows = this.sqlite.prepare(`
      SELECT request.id, request.project_id, request.conversation_id,
        request.requester_agent_id, request.recipient_agent_id,
        request.communication_event_id, request.payload_json, request.created_at
      FROM coordination_requests request
      WHERE (? IS NULL OR request.project_id = ?)
        ${communicationEventId === undefined ? "" : "AND request.communication_event_id = ?"}
        AND request.conversation_id IS NOT NULL
        AND request.requester_agent_id IS NOT NULL
        AND request.communication_event_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM runtime_communications runtime_communication
          WHERE runtime_communication.id = request.communication_event_id
        )
        AND (
          NOT EXISTS (
            SELECT 1 FROM messages sender_projection
            WHERE sender_projection.agent_id = request.requester_agent_id
              AND sender_projection.communication_event_id = request.communication_event_id
          ) OR NOT EXISTS (
            SELECT 1 FROM messages recipient_projection
            WHERE recipient_projection.agent_id = request.recipient_agent_id
              AND recipient_projection.communication_event_id = request.communication_event_id
          )
        )
      ORDER BY request.created_at, request.id
    `).all(projectId ?? null, projectId ?? null, ...(communicationEventId === undefined ? [] : [communicationEventId])) as Array<{
      id: string;
      project_id: string;
      conversation_id: string;
      requester_agent_id: string;
      recipient_agent_id: string;
      communication_event_id: string;
      payload_json: string;
      created_at: string;
    }>;
    return rows.flatMap((row) => {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json) as unknown;
      } catch {
        return [];
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
      const request = payload as Record<string, unknown>;
      if (typeof request.text !== "string" || !request.text.trim()) return [];
      const requesterRunId = typeof request.requesterRunId === "string"
        ? request.requesterRunId
        : undefined;
      const event = {
        eventId: row.communication_event_id,
        schemaVersion: 2,
        projectId: row.project_id,
        conversationId: row.conversation_id,
        sender: {
          kind: "agent",
          agentId: row.requester_agent_id,
          ...(requesterRunId ? { executionId: requesterRunId } : {}),
        },
        intent: "collaboration",
        audience: { kind: "agents", agentIds: [row.recipient_agent_id] },
        text: request.text,
        createdAt: row.created_at,
        idempotencyKey: `v3-request:${row.id}`,
      };
      return [{
        id: row.id,
        projectId: row.project_id,
        audience: event.audience,
        payload: { communication: event },
        createdAt: row.created_at,
        sourceKind: "request" as const,
        recipientAgentIds: [row.recipient_agent_id],
      }];
    });
  }

  runtimeCommunication(id: string): RuntimeCommunicationV3View | undefined {
    const row = this.sqlite.prepare(`
      SELECT id, project_id, audience_json, payload_json, created_at
      FROM runtime_communications WHERE id = ?
    `).get(id) as {
      id: string;
      project_id: string;
      audience_json: string;
      payload_json: string;
      created_at: string;
    } | undefined;
    if (!row) return undefined;
    const activations = this.sqlite.prepare(`
      SELECT activation_id, agent_id
      FROM runtime_communication_activation_intake
      WHERE communication_id = ?
      ORDER BY recipient_index
    `).all(id) as Array<{ activation_id: string; agent_id: string }>;
    return {
        id: row.id,
        projectId: row.project_id,
        audience: JSON.parse(row.audience_json) as unknown,
        payload: JSON.parse(row.payload_json) as unknown,
        createdAt: row.created_at,
        ...(activations.length ? {
          activations: activations.map((activation) => ({
            id: activation.activation_id,
            agentId: activation.agent_id,
          })),
        } : {}),
      };
  }

  runtimeArtifacts(
    ownerKind?: RuntimeArtifactV3["ownerKind"],
    ownerId?: string,
  ): RuntimeArtifactV3[] {
    const rows = this.sqlite.prepare(`
      SELECT id, owner_kind, owner_id, project_id, role, title, media_type, blob_path,
        blob_hash, byte_length, origin_agent_id, execution_id, created_at
      FROM runtime_artifacts
      WHERE (? IS NULL OR owner_kind = ?) AND (? IS NULL OR owner_id = ?)
      ORDER BY created_at, id
    `).all(ownerKind ?? null, ownerKind ?? null, ownerId ?? null, ownerId ?? null) as Array<{
      id: string;
      owner_kind: "communication" | "request_update";
      owner_id: string;
      project_id: string;
      role: "long_text" | "document";
      title: string;
      media_type: "text/markdown";
      blob_path: string;
      blob_hash: string;
      byte_length: number;
      origin_agent_id: string | null;
      execution_id: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      projectId: row.project_id,
      role: row.role,
      title: row.title,
      mediaType: row.media_type,
      blobPath: row.blob_path,
      blobHash: row.blob_hash,
      byteLength: row.byte_length,
      createdAt: row.created_at,
      ...(row.origin_agent_id ? { originAgentId: row.origin_agent_id } : {}),
      ...(row.execution_id ? { executionId: row.execution_id } : {}),
    }));
  }

  runtimeArtifact(id: string): RuntimeArtifactV3 | undefined {
    const row = this.sqlite.prepare(`
      SELECT id, owner_kind, owner_id, project_id, role, title, media_type, blob_path,
        blob_hash, byte_length, origin_agent_id, execution_id, created_at
      FROM runtime_artifacts WHERE id = ?
    `).get(id) as {
      id: string;
      owner_kind: "communication" | "request_update";
      owner_id: string;
      project_id: string;
      role: "long_text" | "document";
      title: string;
      media_type: "text/markdown";
      blob_path: string;
      blob_hash: string;
      byte_length: number;
      origin_agent_id: string | null;
      execution_id: string | null;
      created_at: string;
    } | undefined;
    return row
      ? {
        id: row.id,
        ownerKind: row.owner_kind,
        ownerId: row.owner_id,
        projectId: row.project_id,
        role: row.role,
        title: row.title,
        mediaType: row.media_type,
        blobPath: row.blob_path,
        blobHash: row.blob_hash,
        byteLength: row.byte_length,
        createdAt: row.created_at,
        ...(row.origin_agent_id ? { originAgentId: row.origin_agent_id } : {}),
        ...(row.execution_id ? { executionId: row.execution_id } : {}),
      }
      : undefined;
  }

  deliveryReceiptsForCommunication(
    projectId: string,
    communicationEventId: string,
  ): MessageDeliveryReceiptDto[] {
    return this.deliveryReceiptsForCommunications(projectId, [communicationEventId])
      .get(communicationEventId) ?? [];
  }

  deliveryReceiptsForCommunications(
    projectId: string,
    requestedCommunicationEventIds: readonly string[],
  ): Map<string, MessageDeliveryReceiptDto[]> {
    const communicationEventIds = [...new Set(
      requestedCommunicationEventIds.map((eventId) => eventId.trim()).filter(Boolean),
    )];
    const receiptsByCommunication = new Map<string, MessageDeliveryReceiptDto[]>(
      communicationEventIds.map((eventId) => [eventId, []]),
    );
    if (!projectId.trim() || communicationEventIds.length === 0) {
      return receiptsByCommunication;
    }
    const eventBindings = Object.fromEntries(
      communicationEventIds.map((eventId, index) => [`event${index}`, eventId]),
    );
    const eventPlaceholders = communicationEventIds
      .map((_, index) => `@event${index}`)
      .join(", ");
    const activations = this.sqlite.prepare(`
      SELECT DISTINCT CASE WHEN runtime.id IN (${eventPlaceholders}) THEN runtime.id
          ELSE json_extract(runtime.payload_json, '$.communication.eventId') END AS communication_event_id,
        activation.id, activation.project_id, activation.agent_id,
        activation.scope_key, activation.kind, activation.state, activation.updated_at,
        activation.dispatch_policy, activation.steering_wait_reason,
        activation.rowid AS row_sequence,
        COALESCE(retry_lineage.attempt_number, 0) AS attempt_number,
        runtime.sender_json, runtime.intent, runtime.audience_json, runtime.payload_json
      FROM activation_sources source
      JOIN runtime_communications runtime ON runtime.id = source.source_id
      JOIN agent_activations activation ON activation.id = source.activation_id
      LEFT JOIN activation_delivery_retry_lineage retry_lineage
        ON retry_lineage.successor_activation_id = activation.id
      WHERE source.source_kind = 'communication'
        AND runtime.project_id = @projectId
        AND activation.project_id = runtime.project_id
        AND (
          runtime.id IN (${eventPlaceholders}) OR
          CASE WHEN json_valid(runtime.payload_json)
            THEN json_extract(runtime.payload_json, '$.communication.eventId')
            ELSE NULL
          END IN (${eventPlaceholders})
        )
      ORDER BY communication_event_id, attempt_number, row_sequence
    `).all({ projectId, ...eventBindings }) as Array<{
      communication_event_id: string;
      id: string;
      project_id: string;
      agent_id: string;
      scope_key: string;
      kind: string;
      state: string;
      updated_at: string;
      dispatch_policy: string;
      steering_wait_reason: string | null;
      row_sequence: number;
      attempt_number: number;
      sender_json: string;
      intent: string;
      audience_json: string;
      payload_json: string;
    }>;
    const activationIds = [...new Set(activations.map((activation) => activation.id))];
    const requiredReplySummaries = new Map<string, {
      attemptCount: number;
      latestAttemptAt: string;
      exhausted: boolean;
    }>();
    if (activationIds.length > 0) {
      const rootBindings = Object.fromEntries(
        activationIds.map((activationId, index) => [`root${index}`, activationId]),
      );
      const rootPlaceholders = activationIds
        .map((_, index) => `@root${index}`)
        .join(", ");
      const rows = this.sqlite.prepare(`
        WITH RECURSIVE required_reply_chain (
          root_activation_id, source_activation_id, attempt_count, state, updated_at
        ) AS (
          SELECT source_activation_id, source_activation_id, attempt_count, state, updated_at
          FROM required_reply_obligations
          WHERE source_activation_id IN (${rootPlaceholders})
          UNION
          SELECT chain.root_activation_id, child.source_activation_id,
            child.attempt_count, child.state, child.updated_at
          FROM required_reply_chain chain
          JOIN required_reply_obligations parent
            ON parent.source_activation_id = chain.source_activation_id
          JOIN required_reply_obligations child
            ON child.source_activation_id = parent.recovery_activation_id
              AND child.attempt_count = chain.attempt_count + 1
        )
        SELECT root_activation_id,
          MAX(MAX(attempt_count) + 1, COALESCE((SELECT root.delivery_failures FROM agent_activations root
            WHERE root.id = required_reply_chain.root_activation_id), 0)) AS attempt_count,
          MAX(updated_at) AS latest_attempt_at,
          MAX(CASE WHEN state = 'failed' AND EXISTS (SELECT 1 FROM agent_activations root
            WHERE root.id = required_reply_chain.root_activation_id AND root.terminal_outcome = 'retry_exhausted')
            THEN 1 ELSE 0 END) AS exhausted
        FROM required_reply_chain
        GROUP BY root_activation_id
      `).all(rootBindings) as Array<{
        root_activation_id: string;
        attempt_count: number;
        latest_attempt_at: string;
        exhausted: number;
      }>;
      for (const row of rows) requiredReplySummaries.set(row.root_activation_id, {
        attemptCount: row.attempt_count,
        latestAttemptAt: row.latest_attempt_at,
        exhausted: Boolean(row.exhausted),
      });
    }
    const latestByCommunication = new Map<
      string,
      Map<string, {
        activation: typeof activations[number];
        attemptCount: number;
        latestAttemptAt: string;
        requiredReplyExhausted: boolean;
        recipientCurrentlyAuthorized: boolean;
      }>
    >();
    for (const activation of activations) {
      let sender: unknown;
      let audience: unknown;
      let payload: unknown;
      try {
        sender = JSON.parse(activation.sender_json) as unknown;
        audience = JSON.parse(activation.audience_json) as unknown;
        payload = JSON.parse(activation.payload_json) as unknown;
      } catch {
        continue;
      }
      const authorityInput = {
        projectId,
        sender,
        intent: activation.intent,
        audience,
        payload,
        activations: [{
          agentId: activation.agent_id,
          kind: activation.kind,
          scopeKey: activation.scope_key,
        }],
      };
      if (!this.runtimeScopeAuthority.runtimeCommunicationAuthorityAgrees(
        authorityInput,
        false,
      )) continue;
      const recipientCurrentlyAuthorized =
        this.runtimeScopeAuthority.runtimeCommunicationAuthorityAgrees(authorityInput);
      let latestByRecipient = latestByCommunication.get(activation.communication_event_id);
      if (!latestByRecipient) {
        latestByRecipient = new Map();
        latestByCommunication.set(activation.communication_event_id, latestByRecipient);
      }
      const previous = latestByRecipient.get(activation.agent_id);
      const requiredReply = requiredReplySummaries.get(activation.id);
      const latestAttemptAt = [
        previous?.latestAttemptAt,
        requiredReply?.latestAttemptAt,
        activation.updated_at,
      ].filter((value): value is string => Boolean(value)).sort().at(-1)!;
      latestByRecipient.set(activation.agent_id, {
        activation,
        attemptCount: (previous?.attemptCount ?? 0) + (requiredReply?.attemptCount ?? 1),
        latestAttemptAt,
        requiredReplyExhausted: requiredReply?.exhausted ?? false,
        recipientCurrentlyAuthorized,
      });
    }
    // One membership scan per batch; enrich only the latest injection for each activation.
    const latestInjections = (ids: string[]) => {
      const rows = ids.length ? this.sqlite.prepare(`
        WITH matches AS MATERIALIZED (
          SELECT member.value AS activation_id, injection.id, injection.run_id, injection.kind,
            injection.state, injection.updated_at, injection.acknowledged_at,
            ROW_NUMBER() OVER (PARTITION BY member.value
              ORDER BY injection.created_at DESC, injection.sequence DESC) AS receipt_rank
          FROM scheduler_prompt_injections injection, json_each(injection.activation_ids_json) member
          WHERE member.value IN (SELECT value FROM json_each(?))
        )
        SELECT activation_id, id, run_id, kind, state, updated_at, acknowledged_at,
          (SELECT operation.state FROM provider_operation_outbox operation
            WHERE operation.run_id = matches.run_id AND operation.operation = 'interrupt'
              AND operation.idempotency_key LIKE 'cancel:%'
            ORDER BY operation.id DESC LIMIT 1) AS run_stop_operation_state,
          (SELECT provider.execution_id FROM provider_inputs provider
            WHERE provider.scheduler_run_id = matches.run_id
            ORDER BY provider.created_at DESC, provider.execution_id DESC LIMIT 1) AS execution_id
        FROM matches WHERE receipt_rank = 1
      `).all(JSON.stringify(ids)) as Array<{
        activation_id: string; id: string; run_id: string; kind: "turn" | "steer";
        state: string; updated_at: string; acknowledged_at: string | null;
        execution_id: string | null; run_stop_operation_state: string | null;
      }> : [];
      return new Map(rows.map(row => [row.activation_id, row]));
    };
    const selected = [...latestByCommunication.values()].flatMap(recipients =>
      [...recipients.values()].map(({ activation }) => activation));
    const injections = latestInjections(selected.map(activation => activation.id));
    const recoveries = new Map(selected.map(activation => {
      const injection = injections.get(activation.id);
      const recovery = injection
          ? this.sqlite.prepare(`
            SELECT recovery.state, recovery.recover_at, recovery.updated_at,
              mapping.recovery_activation_id, recovery_activation.state AS recovery_activation_state
            FROM scheduler_steering_recoveries recovery
            LEFT JOIN scheduler_steering_recovery_activations mapping
              ON mapping.injection_id = recovery.injection_id AND mapping.source_activation_id = ?
            LEFT JOIN agent_activations recovery_activation
              ON recovery_activation.id = mapping.recovery_activation_id
            WHERE recovery.injection_id = ?
          `).get(activation.id, injection.id) as {
            state: "grace_period" | "wait_for_run" | "recovery_queued";
            recover_at: string;
            updated_at: string;
            recovery_activation_id: string | null;
            recovery_activation_state: string | null;
          } | undefined
          : undefined;
      return [activation.id, recovery] as const;
    }));
    const recoveryInjections = latestInjections([...recoveries.values()].flatMap(recovery =>
      recovery?.recovery_activation_id ? [recovery.recovery_activation_id] : []));
    for (const [communicationEventId, latestByRecipient] of latestByCommunication) {
      const receipts = [...latestByRecipient.values()].map(({
        activation,
        attemptCount,
        latestAttemptAt,
        requiredReplyExhausted,
        recipientCurrentlyAuthorized,
      }) => {
        const injection = injections.get(activation.id);
        const recovery = recoveries.get(activation.id);
        const recoveryInjection = recovery?.recovery_activation_id
          ? recoveryInjections.get(recovery.recovery_activation_id) : undefined;
        let state: MessageDeliveryReceiptDto["state"];
        if (requiredReplyExhausted) state = "retry_exhausted";
        else if (activation.state === "outcome_unknown") {
          if (!recovery) state = injection?.state === "acknowledged" ? "run_unconfirmed" : "undelivered";
          else if (recovery.state === "grace_period") state = "unconfirmed";
          else if (recovery.recovery_activation_state === "consumed") state = "recovered";
          else if (
            ["failed", "outcome_unknown", "cancelled"]
              .includes(recovery.recovery_activation_state ?? "")
          ) state = "failed";
          else if (recovery.recovery_activation_state === "attached") state = "recovering";
          else {
            state = recovery.state === "wait_for_run" ? "waiting_for_run" : "recovery_queued";
          }
        } else if (activation.state === "failed") state = "failed";
        else if (activation.state === "cancelled") state = "cancelled";
        else if (activation.state === "consumed") state = "processed";
        else if (injection?.state === "acknowledged") state = "delivered";
        else if (
          injection?.kind === "steer"
          && (injection.state === "pending" || injection.state === "submitted")
        ) state = "steering";
        else if (injection?.kind === "turn" && injection.state === "submitted") state = "started";
        else if (activation.state === "attached") state = "preparing";
        else if (activation.state === "retry_pending") state = "retrying";
        else state = "queued";
        const runtime = deliveryRuntime(activation.payload_json);
        const steeringWaitReason = recipientCurrentlyAuthorized && (state === "queued" || state === "retrying")
          ? this.steeringWaitReason(activation) : undefined;
        const liveProgress = injection && recipientCurrentlyAuthorized && state === "delivered"
          ? this.liveProgress(projectId, activation.agent_id, activation.id, injection) : undefined;
        return {
          activationId: activation.id,
          targetAgentId: activation.agent_id,
          ...(runtime ? { runtime } : {}),
          ...(injection?.execution_id ? { executionId: injection.execution_id } : {}),
          ...(recoveryInjection?.execution_id
            ? { recoveryExecutionId: recoveryInjection.execution_id }
            : {}),
          state,
          ...(activation.dispatch_policy === "next_run" && ["pending", "retry_pending"].includes(activation.state)
            ? { queuedForNextRun: true as const } : {}),
          ...(steeringWaitReason ? { steeringWaitReason } : {}),
          updatedAt: [
            latestAttemptAt,
            recovery?.updated_at,
            recoveryInjection?.updated_at,
            injection?.updated_at,
            activation.updated_at,
          ].filter((value): value is string => Boolean(value)).sort().at(-1)!,
          attemptCount,
          ...(injection?.state === "acknowledged" ? { providerAcknowledged: true as const } : {}),
          ...(state === "cancelled" && injection?.state === "acknowledged" ? {
            // A scheduler cancellation is a fence, not an observed process
            // exit. Only the completed teardown operation confirms stopping.
            runStopState: injection.run_stop_operation_state === "completed" ? "stopped" as const
              : injection.run_stop_operation_state === "pending" || injection.run_stop_operation_state === "claimed" ? "stopping" as const
              : "unconfirmed" as const,
          } : {}),
          ...(
            (state === "undelivered" || state === "run_unconfirmed" || state === "retry_exhausted" || state === "failed")
            && recipientCurrentlyAuthorized
            && this.runtimeScopeAuthority.recipientAuthorizedForActivationScope(
              activation.project_id,
              activation.agent_id,
              activation.scope_key,
            )
              ? {
                canRetry: true as const,
                ...(activation.state === "outcome_unknown"
                  ? { retryMayDuplicate: true as const }
                  : {}),
              }
              : {}
          ),
          ...(injection ? { injectionId: injection.id, injectionKind: injection.kind } : {}),
          ...(liveProgress ? { liveProgress } : {}),
          ...(recovery ? { recoveryAt: recovery.recover_at } : {}),
          ...(recovery?.state === "grace_period" ? { canLetCurrentRunFinish: true } : {}),
          ...(recovery?.recovery_activation_id
            ? { recoveryActivationId: recovery.recovery_activation_id }
            : {}),
        };
      });
      receiptsByCommunication.set(communicationEventId, receipts);
    }
    return receiptsByCommunication;
  }

  communicationRecipientAgentIds(projectId: string, communicationId: string): string[] {
    return (this.sqlite.prepare(`
      SELECT DISTINCT activation.agent_id
      FROM activation_sources source
      JOIN agent_activations activation ON activation.id = source.activation_id
      JOIN runtime_communications communication ON communication.id = source.source_id
      WHERE source.source_kind = 'communication'
        AND communication.project_id = ?
        AND activation.project_id = communication.project_id
        AND (source.source_id = ? OR json_extract(communication.payload_json, '$.communication.eventId') = ?)
      ORDER BY activation.agent_id
    `).all(projectId, communicationId, communicationId) as Array<{ agent_id: string }>)
      .map((row) => row.agent_id);
  }
}
