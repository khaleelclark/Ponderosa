import type Database from "better-sqlite3";
import {
  deriveAgentAvailability,
  type AgentCoordinationV3Dto,
  type AgentHealthProjectionDto,
  type AgentPhaseDto,
  type CoordinationJoinMode,
  type CoordinationJoinState,
  type CoordinationJoinWakePolicy,
  type DerivedAgentAvailability,
  type ProviderBlockedWorkDto,
} from "@ponderosa/core";

type WaitingPhase = Extract<
  AgentPhaseDto,
  { kind: "waiting_on_request" | "waiting_on_join" }
>;

const MAX_PHASE_DEPENDENCY_IDENTITIES = 3;

export class CoordinationV3SchedulerStatusReadModel {
  constructor(private readonly sqlite: Database.Database) {}

  isSchedulerRunCancelled(runId: string): boolean {
    return Boolean(this.sqlite.prepare(`
      SELECT 1 FROM scheduler_runs WHERE id = ? AND status = 'cancelled'
    `).get(runId));
  }

  getAgentAvailability(agentId: string): DerivedAgentAvailability {
    const hasActiveRun = Boolean(this.sqlite.prepare(`
      SELECT 1 FROM scheduler_runs WHERE agent_id = ? AND status IN ('leased', 'running') LIMIT 1
    `).get(agentId));
    const hasActionableActivation = Boolean(this.sqlite.prepare(`
      SELECT 1 FROM agent_activations
      WHERE agent_id = ? AND state IN ('pending', 'retry_pending') LIMIT 1
    `).get(agentId));
    const ownsOpenJoin = Boolean(this.sqlite.prepare(`
      SELECT 1 FROM coordination_joins WHERE owner_agent_id = ? AND state = 'open' LIMIT 1
    `).get(agentId));
    const hasSuspendedRecipientRequest = Boolean(this.sqlite.prepare(`
      SELECT 1 FROM coordination_requests
      WHERE recipient_agent_id = ? AND state IN ('awaiting_answer', 'waiting_dependency') LIMIT 1
    `).get(agentId));
    return deriveAgentAvailability({ hasActiveRun, hasActionableActivation, ownsOpenJoin, hasSuspendedRecipientRequest });
  }

  /** Canonical, payload-free dependency currently keeping one Agent waiting. */
  activeWaitDependency(
    agentId: string,
    scope: AgentHealthProjectionDto["scope"],
  ): WaitingPhase | undefined {
    const scopeMatches = (table: "join_record" | "request") => `
      AND ((? = 'project' AND ${table}.project_id = ?)
        OR (? = 'conversation' AND ${table}.conversation_id = ?))
    `;
    const scopeParameters = [scope.type, scope.id, scope.type, scope.id] as const;
    const latestJoin = this.sqlite.prepare(`
      SELECT join_record.id, join_record.updated_at
      FROM coordination_joins join_record
      WHERE join_record.owner_agent_id = ? AND join_record.state = 'open'
        ${scopeMatches("join_record")}
      ORDER BY join_record.updated_at DESC, join_record.id DESC
      LIMIT 1
    `).get(agentId, ...scopeParameters) as {
      id: string;
      updated_at: string;
    } | undefined;
    const latestRequests = this.sqlite.prepare(`
      SELECT request.id, request.requester_agent_id, request.updated_at
      FROM coordination_requests request
      WHERE request.recipient_agent_id = ?
        AND request.state IN ('awaiting_answer', 'waiting_dependency')
        ${scopeMatches("request")}
      ORDER BY request.updated_at DESC, request.id DESC
      LIMIT ${MAX_PHASE_DEPENDENCY_IDENTITIES}
    `).all(agentId, ...scopeParameters) as Array<{
      id: string;
      requester_agent_id: string | null;
      updated_at: string;
    }>;
    const latestRequest = latestRequests[0];
    const joinSortKey = latestJoin
      ? `${latestJoin.updated_at}\u0000${latestJoin.id}`
      : undefined;
    const requestSortKey = latestRequest
      ? `${latestRequest.updated_at}\u0000${latestRequest.id}`
      : undefined;

    if (latestJoin && (!requestSortKey || joinSortKey! >= requestSortKey)) {
      const dependencyCount = (this.sqlite.prepare(`
        SELECT COUNT(DISTINCT request.id) AS count
        FROM coordination_joins join_record
        JOIN coordination_join_members member ON member.join_id = join_record.id
        JOIN coordination_requests request ON request.id = member.request_id
        WHERE join_record.id = ?
          AND join_record.owner_agent_id = ? AND join_record.state = 'open'
          AND request.terminal_at IS NULL
          ${scopeMatches("join_record")}
      `).get(latestJoin.id, agentId, ...scopeParameters) as { count: number }).count;
      if (dependencyCount < 1) return undefined;
      const requests = this.sqlite.prepare(`
        SELECT request.id, request.recipient_agent_id,
          MIN(member.position) AS member_position
        FROM coordination_joins join_record
        JOIN coordination_join_members member ON member.join_id = join_record.id
        JOIN coordination_requests request ON request.id = member.request_id
        WHERE join_record.id = ?
          AND join_record.owner_agent_id = ? AND join_record.state = 'open'
          AND request.terminal_at IS NULL
          ${scopeMatches("join_record")}
        GROUP BY request.id, request.recipient_agent_id
        ORDER BY member_position, request.id
        LIMIT ${MAX_PHASE_DEPENDENCY_IDENTITIES}
      `).all(latestJoin.id, agentId, ...scopeParameters) as Array<{
        id: string;
        recipient_agent_id: string;
      }>;
      return {
        kind: "waiting_on_join",
        observedAt: latestJoin.updated_at,
        joinId: latestJoin.id,
        requestIds: requests.map((request) => request.id),
        dependencyCount,
        additionalDependencyCount: Math.max(0, dependencyCount - requests.length),
        counterpartyAgentIds: [...new Set(
          requests.map((request) => request.recipient_agent_id).filter(Boolean),
        )].slice(0, MAX_PHASE_DEPENDENCY_IDENTITIES),
      };
    }

    if (!latestRequest) return undefined;
    const dependencyCount = (this.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM coordination_requests request
      WHERE request.recipient_agent_id = ?
        AND request.state IN ('awaiting_answer', 'waiting_dependency')
        ${scopeMatches("request")}
    `).get(agentId, ...scopeParameters) as { count: number }).count;
    return {
      kind: "waiting_on_request",
      observedAt: latestRequest.updated_at,
      requestId: latestRequest.id,
      dependencyCount,
      additionalDependencyCount: Math.max(0, dependencyCount - 1),
      counterpartyAgentIds: [...new Set(
        latestRequests.flatMap((request) => request.requester_agent_id
          ? [request.requester_agent_id]
          : []),
      )].slice(0, MAX_PHASE_DEPENDENCY_IDENTITIES),
    };
  }

  providerBlockedState(agentId: string): ProviderBlockedWorkDto | undefined {
    const rows = this.sqlite.prepare(`
      SELECT id, delivery_failures, provider_failure_category, available_at, updated_at
      FROM agent_activations
      WHERE agent_id = ? AND state = 'retry_pending'
        AND provider_failure_category IN ('capacity', 'rate_limit')
      ORDER BY available_at, id
    `).all(agentId) as Array<{
      id: string;
      delivery_failures: number;
      provider_failure_category: "capacity" | "rate_limit";
      available_at: string;
      updated_at: string;
    }>;
    if (!rows.length) return undefined;
    return {
      classification: rows.some((row) => row.provider_failure_category === "capacity")
        ? "capacity"
        : "rate_limit",
      activationIds: rows.map((row) => row.id),
      retryEligible: true,
      blockedAt: rows.reduce((latest, row) => row.updated_at > latest ? row.updated_at : latest, rows[0]!.updated_at),
      nextRetryAt: rows[0]!.available_at,
      deliveryFailures: Math.max(...rows.map((row) => row.delivery_failures)),
    };
  }

  activeRunCount(): number {
    return (this.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_runs WHERE status IN ('leased', 'running')
    `).get() as { count: number }).count;
  }

  ownsRun(runId: string, fencingToken: number, workerId?: string): boolean {
    const row = this.sqlite.prepare(`
      SELECT 1 FROM scheduler_runs
      WHERE id = ? AND fencing_token = ? AND status IN ('leased', 'running')
        AND side_effects_fenced_at IS NULL
        AND (? IS NULL OR lease_owner = ?)
    `).get(runId, fencingToken, workerId ?? null, workerId ?? null);
    return Boolean(row);
  }

  /** Host cleanup retains the original scheduler fence after provider-facing
   * side effects close, so it can consume Activations and finish the Run. */
  ownsRunForCleanup(runId: string, fencingToken: number, workerId?: string): boolean {
    const row = this.sqlite.prepare(`
      SELECT 1 FROM scheduler_runs
      WHERE id = ? AND fencing_token = ? AND status IN ('leased', 'running')
        AND (? IS NULL OR lease_owner = ?)
    `).get(runId, fencingToken, workerId ?? null, workerId ?? null);
    return Boolean(row);
  }

  /** A provider may deliver one terminal handoff after an injected Run became
   * uncertain. This identifies that exact fenced generation; updateRequest
   * still restricts the mutation to a recipient-authored late result. */
  ownsOutcomeUnknownRun(runId: string, fencingToken: number, workerId?: string): boolean {
    return Boolean(this.sqlite.prepare(`
      SELECT 1 FROM scheduler_runs
      WHERE id = ? AND fencing_token = ? AND status = 'outcome_unknown'
        AND (? IS NULL OR lease_owner = ?)
    `).get(runId, fencingToken, workerId ?? null, workerId ?? null));
  }

  agentSnapshot(agentId: string): AgentCoordinationV3Dto {
    const requests = this.sqlite.prepare(`
      SELECT id, requester_agent_id, recipient_agent_id, state, version, deadline_at, updated_at
      FROM coordination_requests
      WHERE requester_agent_id = ? OR recipient_agent_id = ?
      ORDER BY updated_at DESC, id DESC LIMIT 100
    `).all(agentId, agentId) as Array<{
      id: string; requester_agent_id: string | null; recipient_agent_id: string;
      state: string; version: number; deadline_at: string | null; updated_at: string;
    }>;
    const joins = this.sqlite.prepare(`
      SELECT j.id, j.mode, j.wake_policy, j.quorum, j.state, j.deadline_at, j.updated_at,
        COUNT(m.request_id) AS total,
        SUM(CASE WHEN r.state = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM coordination_joins j
      JOIN coordination_join_members m ON m.join_id = j.id
      JOIN coordination_requests r ON r.id = m.request_id
      WHERE j.owner_agent_id = ?
      GROUP BY j.id ORDER BY j.updated_at DESC, j.id DESC LIMIT 100
    `).all(agentId) as Array<{
      id: string; mode: CoordinationJoinMode; wake_policy: CoordinationJoinWakePolicy; quorum: number; state: CoordinationJoinState;
      deadline_at: string | null; updated_at: string; total: number; completed: number;
    }>;
    const activations = this.sqlite.prepare(`
      SELECT id, kind, priority, state, created_at
      FROM agent_activations WHERE agent_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 100
    `).all(agentId) as Array<{ id: string; kind: string; priority: number; state: string; created_at: string }>;
    const activeRun = this.sqlite.prepare(`
      SELECT id, status, fencing_token, prompt_injection_state, context_disposition,
        created_at, lease_expires_at
      FROM scheduler_runs WHERE agent_id = ? AND status IN ('leased', 'running') LIMIT 1
    `).get(agentId) as {
      id: string; status: string; fencing_token: number;
      prompt_injection_state: "not_injected" | "injecting" | "injected";
      context_disposition: "fresh_task" | "continued_session" | "reseeded";
      created_at: string; lease_expires_at: string;
    } | undefined;
    return {
      availability: this.getAgentAvailability(agentId),
      requests: requests.map((request) => ({
        id: request.id,
        direction: request.requester_agent_id === agentId ? "outbound" : "inbound",
        ...(request.requester_agent_id === agentId
          ? { counterpartyAgentId: request.recipient_agent_id }
          : request.requester_agent_id ? { counterpartyAgentId: request.requester_agent_id } : {}),
        state: request.state,
        version: request.version,
        ...(request.deadline_at ? { deadlineAt: request.deadline_at } : {}),
        updatedAt: request.updated_at,
      })),
      joins: joins.map((join) => ({
        id: join.id, mode: join.mode, wakePolicy: join.wake_policy, quorum: join.quorum, state: join.state,
        completed: join.completed, total: join.total,
        ...(join.deadline_at ? { deadlineAt: join.deadline_at } : {}),
        updatedAt: join.updated_at,
      })),
      activations: activations.map((activation) => ({
        id: activation.id, kind: activation.kind, priority: activation.priority,
        state: activation.state, createdAt: activation.created_at,
      })),
      ...(activeRun ? { activeRun: {
        id: activeRun.id, status: activeRun.status, fencingToken: activeRun.fencing_token,
        promptInjectionState: activeRun.prompt_injection_state,
        providerContextDisposition: activeRun.context_disposition,
        leaseStartedAt: activeRun.created_at,
        leaseExpiresAt: activeRun.lease_expires_at,
      } } : {}),
    };
  }

}
