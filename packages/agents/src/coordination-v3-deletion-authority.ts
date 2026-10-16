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
    private readonly updateRequest: (input: UpdateRequestV3Input) => unknown,
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
      this.sqlite.prepare(`
        UPDATE required_reply_obligations
        SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE agent_id = ? AND state IN ('pending', 'recovery_pending')
      `).run(now, now, agentId);
      this.sqlite.prepare(`
        UPDATE context_rollovers
        SET state = 'failed', continuity_waiting = 0, last_error = 'agent deletion fenced context rollover',
          updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
        WHERE agent_id = ?
          AND (state IN ('requested','handoff_committed','session_retiring','continuation_ready') OR continuity_waiting = 1)
      `).run(now, now, agentId);
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
      this.sqlite.prepare(`
        UPDATE communication_v4_next_run_recipients
        SET state = 'unavailable', unavailable_at = ?,
          unavailable_reason = 'recipient Agent was deleted'
        WHERE agent_id = ? AND state = 'pending'
      `).run(now, agentId);
    })();
  }

  /** Erase one deleted Agent's private scheduling/input history after exact
   * runtime drain. Shared Communications and terminal Request/Join outcomes
   * remain available to surviving participants. */
  purgeAgentExecutionHistory(agentId: string): void {
    this.sqlite.transaction(() => {
      const deleted = this.sqlite.prepare("SELECT deleted_at FROM agents WHERE id = ?")
        .get(agentId) as { deleted_at: string | null } | undefined;
      if (!deleted?.deleted_at) throw new Error("Agent execution purge requires a committed deletion");
      if (this.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id = ? AND status IN ('leased','running')").get(agentId)
        || this.sqlite.prepare("SELECT 1 FROM provider_process_authority WHERE agent_id = ?").get(agentId)) {
        throw new Error("Agent execution purge requires observed runtime drain");
      }
      const incidents = this.sqlite.prepare(`SELECT DISTINCT incident_id FROM system_incident_runs
        WHERE run_id IN (SELECT id FROM scheduler_runs WHERE agent_id = ?)`)
        .all(agentId) as Array<{ incident_id: string }>;
      this.sqlite.prepare(`DELETE FROM system_incident_runs
        WHERE run_id IN (SELECT id FROM scheduler_runs WHERE agent_id = ?)`).run(agentId);
      for (const { incident_id } of incidents) this.sqlite.prepare(`DELETE FROM system_incidents
        WHERE id = ? AND NOT EXISTS (SELECT 1 FROM system_incident_runs WHERE incident_id = ?)`).run(incident_id, incident_id);
      this.sqlite.prepare("DELETE FROM context_rollovers WHERE agent_id = ?").run(agentId);
      this.sqlite.prepare("DELETE FROM scheduler_runs WHERE agent_id = ?").run(agentId);
      // Foreign-Run references must never be severed to force a purge through.
      if (this.sqlite.prepare(`SELECT 1 FROM scheduler_run_activations
        WHERE activation_id IN (SELECT id FROM agent_activations WHERE agent_id = ?)`).get(agentId)
        || this.sqlite.prepare(`SELECT 1 FROM scheduler_steering_recovery_activations
        WHERE source_activation_id IN (SELECT id FROM agent_activations WHERE agent_id = ?)
          OR recovery_activation_id IN (SELECT id FROM agent_activations WHERE agent_id = ?)`).get(agentId, agentId)) {
        throw new Error("Agent execution history is still referenced by surviving work");
      }
      if (this.sqlite.prepare(`SELECT 1 FROM activation_delivery_retry_lineage lineage
        JOIN agent_activations predecessor ON predecessor.id = lineage.predecessor_activation_id
        JOIN agent_activations successor ON successor.id = lineage.successor_activation_id
        JOIN agent_activations root ON root.id = lineage.root_activation_id
        WHERE ? IN (predecessor.agent_id, successor.agent_id, root.agent_id)
          AND (predecessor.agent_id != ? OR successor.agent_id != ? OR root.agent_id != ?)`)
        .get(agentId, agentId, agentId, agentId)) {
        throw new Error("Agent delivery lineage is still referenced by surviving work");
      }
      this.sqlite.prepare(`DELETE FROM activation_delivery_retry_lineage
        WHERE predecessor_activation_id IN (SELECT id FROM agent_activations WHERE agent_id = ?)
          OR successor_activation_id IN (SELECT id FROM agent_activations WHERE agent_id = ?)
          OR root_activation_id IN (SELECT id FROM agent_activations WHERE agent_id = ?)`).run(agentId, agentId, agentId);
      this.sqlite.prepare("DELETE FROM agent_activations WHERE agent_id = ?").run(agentId);
      this.sqlite.prepare("DELETE FROM scheduler_cancellation_receipts WHERE agent_id = ?").run(agentId);
      this.sqlite.prepare("DELETE FROM scheduler_agent_fences WHERE agent_id = ?").run(agentId);
      this.sqlite.prepare(`DELETE FROM coordination_idempotency
        WHERE actor_scope = ? OR substr(actor_scope, 1, length(?)) = ?`).run(`agent:${agentId}`, `agent:${agentId}:run:`, `agent:${agentId}:run:`);
      this.sqlite.prepare("DELETE FROM agent_management_approvals WHERE owner_agent_id = ?").run(agentId);
      this.sqlite.prepare("DELETE FROM agent_management_plans WHERE owner_agent_id = ?").run(agentId);
      // Creation receipts shared with a surviving Agent remain authoritative.
      this.sqlite.prepare(`DELETE FROM agent_creation_operations WHERE status = 'completed'
        AND id IN (SELECT operation_id FROM agent_creation_operation_members WHERE agent_id = ?)
        AND NOT EXISTS (SELECT 1 FROM agent_creation_operation_members member
          JOIN agents agent ON agent.id = member.agent_id
          WHERE member.operation_id = agent_creation_operations.id AND agent.deleted_at IS NULL)`).run(agentId);
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
        UPDATE required_reply_obligations
        SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE project_id = ? AND state IN ('pending', 'recovery_pending')
      `).run(now, now, projectId);
      this.sqlite.prepare(`
        UPDATE context_rollovers
        SET state = 'failed', last_error = 'project deletion fenced context rollover',
          updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
        WHERE project_id = ?
          AND state IN ('requested','handoff_committed','session_retiring','continuation_ready')
      `).run(now, now, projectId);
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
      // Remove rollover ownership before its source Runs and Activations so no
      // restart recovery can observe a partially purged Project transition.
      this.sqlite.prepare(`
        DELETE FROM communication_v4_next_run_recipients WHERE delivery_id IN (
          SELECT id FROM communication_v4_next_run_deliveries WHERE project_id = ?
        )
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM communication_v4_next_run_deliveries WHERE project_id = ?
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM context_rollovers WHERE project_id = ?
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
        DELETE FROM system_incident_runs WHERE run_id IN (
          SELECT id FROM scheduler_runs WHERE project_id = ?
        )
      `).run(projectId);
      this.sqlite.prepare(`
        DELETE FROM system_incidents WHERE NOT EXISTS (
          SELECT 1 FROM system_incident_runs linked
          WHERE linked.incident_id = system_incidents.id
        )
      `).run();
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

  purgeCommunicationV4Conversation(conversationId: string): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        DELETE FROM communication_v4_next_run_recipients WHERE delivery_id IN (
          SELECT id FROM communication_v4_next_run_deliveries WHERE conversation_id = ?
        )
      `).run(conversationId);
      this.sqlite.prepare(`
        DELETE FROM communication_v4_next_run_deliveries WHERE conversation_id = ?
      `).run(conversationId);
    })();
  }
}
