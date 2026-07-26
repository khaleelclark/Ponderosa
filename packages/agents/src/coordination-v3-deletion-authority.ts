import type Database from "better-sqlite3";
import type { CoordinationV3StoreSupport } from "./coordination-v3-store-support.js";
import type { UpdateRequestV3Input } from "./coordination-v3-types.js";

type CancelAgentRunInput = {
  agentId: string;
  idempotencyKey: string;
  expectedRunId?: string;
  now?: string;
};

/** Fences and settles V3 authority during Agent, Team Chat, and Project removal. */
export class CoordinationV3DeletionAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly support: CoordinationV3StoreSupport,
    private readonly cancelAgentRun: (input: CancelAgentRunInput) => unknown,
    private readonly cancelJoin: (
      joinId: string,
      ownerAgentId: string,
      now?: string,
    ) => boolean,
    private readonly updateRequest: (input: UpdateRequestV3Input) => unknown,
    private readonly deleteTriggerDefinition: (
      triggerId: string,
      now?: string,
    ) => boolean,
  ) {}

  handleAgentDeletion(
    agentId: string,
    now = new Date().toISOString(),
  ): void {
    this.sqlite.transaction(() => {
      // This is intentionally idempotent with the server's pre-interrupt call.
      // Keeping it here makes direct store callers uphold the same fence-first
      // deletion invariant inside the projection-deletion transaction.
      this.cancelAgentRun({
        agentId,
        idempotencyKey: `agent-delete:${agentId}`,
        now,
      });
      const owned = this.sqlite.prepare(`
        SELECT id FROM coordination_joins
        WHERE owner_agent_id = ? AND state = 'open'
      `).all(agentId) as Array<{ id: string }>;
      for (const join of owned) {
        this.sqlite.prepare(`
          UPDATE coordination_joins
          SET state = 'cancelled', updated_at = ?, terminal_at = ?
          WHERE id = ?
        `).run(now, now, join.id);
        this.sqlite.prepare(`
          UPDATE agent_activations SET state = 'cancelled', updated_at = ?
          WHERE state IN ('pending', 'retry_pending') AND id IN (
            SELECT activation_id FROM activation_sources
            WHERE source_kind = 'join' AND source_id = ?
          )
        `).run(now, join.id);
      }
      const received = this.sqlite.prepare(`
        SELECT id FROM coordination_requests
        WHERE recipient_agent_id = ?
          AND state IN (
            'open', 'in_progress', 'waiting_dependency', 'awaiting_answer'
          )
      `).all(agentId) as Array<{ id: string }>;
      for (const request of received) {
        this.updateRequest({
          requestId: request.id,
          updateId: `system:recipient-unavailable:${request.id}:${now}`,
          kind: "recipient_unavailable",
          actor: { kind: "system", id: "agent-deletion" },
          now,
        });
      }
      const requested = this.sqlite.prepare(`
        SELECT id FROM coordination_requests
        WHERE requester_agent_id = ?
          AND state IN (
            'open', 'in_progress', 'waiting_dependency', 'awaiting_answer'
          )
      `).all(agentId) as Array<{ id: string }>;
      for (const request of requested) {
        this.updateRequest({
          requestId: request.id,
          updateId: `user:requester-deleted:${request.id}`,
          kind: "cancelled",
          actor: { kind: "user", id: "agent-deletion" },
          payload: { reason: "requester_agent_deleted" },
          now,
        });
      }
      this.sqlite.prepare(`
        UPDATE agent_activations
        SET state = 'failed', terminal_outcome = 'recipient_unavailable',
          terminal_at = COALESCE(terminal_at, ?), last_delivery_error = ?,
          updated_at = ?
        WHERE agent_id = ? AND state IN ('pending', 'retry_pending')
      `).run(now, "activation recipient was deleted", now, agentId);
      const ownedTriggers = this.sqlite.prepare(`
        SELECT id FROM trigger_definitions WHERE agent_id = ?
      `).all(agentId) as Array<{ id: string }>;
      for (const trigger of ownedTriggers) {
        this.deleteTriggerDefinition(trigger.id, now);
      }
    })();
  }

  handleAgentConversationRemoval(
    agentId: string,
    conversationId: string,
    now = new Date().toISOString(),
  ): void {
    this.sqlite.transaction(() => {
      const scopeKey = `conversation:${conversationId}`;
      const active = this.sqlite.prepare(`
        SELECT 1 FROM scheduler_runs
        WHERE agent_id = ? AND scope_key = ?
          AND status IN ('leased', 'running')
      `).get(agentId, scopeKey);
      if (active) {
        this.cancelAgentRun({
          agentId,
          idempotencyKey:
            `conversation-removal:${conversationId}:${agentId}`,
          now,
        });
      }
      const joins = this.sqlite.prepare(`
        SELECT id FROM coordination_joins
        WHERE owner_agent_id = ? AND conversation_id = ? AND state = 'open'
      `).all(agentId, conversationId) as Array<{ id: string }>;
      for (const join of joins) {
        this.cancelJoin(join.id, agentId, now);
      }
      const received = this.sqlite.prepare(`
        SELECT id FROM coordination_requests
        WHERE recipient_agent_id = ? AND conversation_id = ?
          AND state IN (
            'open', 'in_progress', 'waiting_dependency', 'awaiting_answer'
          )
      `).all(agentId, conversationId) as Array<{ id: string }>;
      for (const request of received) {
        this.updateRequest({
          requestId: request.id,
          updateId:
            `system:conversation-recipient-unavailable:` +
            `${conversationId}:${request.id}`,
          kind: "recipient_unavailable",
          actor: {
            kind: "system",
            id: "conversation-membership-removal",
          },
          payload: { conversationId },
          now,
        });
      }
      const requested = this.sqlite.prepare(`
        SELECT id FROM coordination_requests
        WHERE requester_agent_id = ? AND conversation_id = ?
          AND state IN (
            'open', 'in_progress', 'waiting_dependency', 'awaiting_answer'
          )
      `).all(agentId, conversationId) as Array<{ id: string }>;
      for (const request of requested) {
        this.updateRequest({
          requestId: request.id,
          updateId:
            `user:conversation-request-cancelled:` +
            `${conversationId}:${request.id}`,
          kind: "cancelled",
          actor: { kind: "user", id: "local-operator" },
          payload: {
            conversationId,
            reason: "requester_removed_from_conversation",
          },
          now,
        });
      }
      this.sqlite.prepare(`
        UPDATE agent_activations
        SET state = 'failed', terminal_outcome = 'recipient_unavailable',
          terminal_at = COALESCE(terminal_at, ?), last_delivery_error = ?,
          updated_at = ?
        WHERE agent_id = ? AND scope_key = ?
          AND state IN ('pending', 'retry_pending')
      `).run(
        now,
        "activation recipient is no longer a member of the Team Chat",
        now,
        agentId,
        scopeKey,
      );
      const scopedTriggers = this.sqlite.prepare(`
        SELECT id FROM trigger_definitions
        WHERE agent_id = ? AND conversation_id = ?
      `).all(agentId, conversationId) as Array<{ id: string }>;
      for (const trigger of scopedTriggers) {
        this.deleteTriggerDefinition(trigger.id, now);
      }
    })();
  }

  prepareProjectDeletion(
    projectId: string,
    now = new Date().toISOString(),
  ): void {
    this.sqlite.transaction(() => {
      this.support.requireProject(projectId);
      const activeAgents = this.sqlite.prepare(`
        SELECT agent_id FROM scheduler_runs
        WHERE project_id = ? AND status IN ('leased', 'running')
        ORDER BY agent_id
      `).all(projectId) as Array<{ agent_id: string }>;
      for (const { agent_id } of activeAgents) {
        this.cancelAgentRun({
          agentId: agent_id,
          idempotencyKey: `project-delete:${projectId}:${agent_id}`,
          now,
        });
      }
      this.sqlite.prepare(`
        UPDATE coordination_joins
        SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE project_id = ? AND state = 'open'
      `).run(now, now, projectId);
      this.sqlite.prepare(`
        UPDATE coordination_requests
        SET state = 'cancelled', version = version + 1,
          open_question_update_id = NULL, updated_at = ?, terminal_at = ?
        WHERE project_id = ?
          AND state IN (
            'open', 'in_progress', 'waiting_dependency', 'awaiting_answer'
          )
      `).run(now, now, projectId);
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?
        WHERE project_id = ?
          AND state IN ('pending', 'retry_pending', 'attached')
      `).run(now, projectId);
    })();
  }

  purgeProject(projectId: string): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        DELETE FROM trigger_filesystem_bursts WHERE project_id = ?
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM trigger_definitions WHERE project_id = ?
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM trigger_occurrences WHERE project_id = ?
      `).run(projectId);
      this.sqlite.prepare(`DELETE FROM activation_outbox WHERE activation_id IN (
        SELECT id FROM agent_activations WHERE project_id = ?
      )`).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM provider_operation_outbox WHERE run_id IN (
          SELECT id FROM scheduler_runs WHERE project_id = ?
        )
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM scheduler_cancellation_receipts WHERE agent_id IN (
          SELECT id FROM agents WHERE project_id = ?
        )
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM scheduler_prompt_injections WHERE run_id IN (
          SELECT id FROM scheduler_runs WHERE project_id = ?
        )
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM scheduler_run_activations WHERE run_id IN (
          SELECT id FROM scheduler_runs WHERE project_id = ?
        )
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM scheduler_runs WHERE project_id = ?
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM activation_sources WHERE activation_id IN (
          SELECT id FROM agent_activations WHERE project_id = ?
        )
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM activation_delivery_retry_lineage
        WHERE root_activation_id IN (
          SELECT id FROM agent_activations WHERE project_id = ?
        )
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM agent_activations WHERE project_id = ?
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM coordination_join_members WHERE join_id IN (
          SELECT id FROM coordination_joins WHERE project_id = ?
        )
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM coordination_joins WHERE project_id = ?
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM coordination_request_updates WHERE request_id IN (
          SELECT id FROM coordination_requests WHERE project_id = ?
        )
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM coordination_requests WHERE project_id = ?
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM runtime_artifacts WHERE project_id = ?
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM runtime_communications WHERE project_id = ?
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM coordination_idempotency WHERE project_id = ?
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM scheduler_agent_fences WHERE agent_id IN (
          SELECT id FROM agents WHERE project_id = ?
        )
      `).run(projectId);
    })();
  }
}
