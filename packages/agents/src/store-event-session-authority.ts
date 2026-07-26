import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import type {
  AgentDto,
  AgentLifecycleReason,
  AgentLifecycleStatus,
  CommunicationProjection,
  ProjectDto,
} from "@ponderosa/core";
import type { Db } from "./db.js";
import type { LogEvent, StoredLogEvent } from "./log-event.js";
import { communicationMessageProjection } from "./store-communication.js";
import { AgentEventProjectionStore } from "./store-event-projection.js";
import { agents, continuationHandoffs } from "./schema.js";

export class AgentEventSessionAuthority {
  constructor(
    private readonly db: Db,
    private readonly client: Database.Database,
    private readonly eventProjection: AgentEventProjectionStore,
    private readonly getAgent: (agentId: string) => AgentDto | undefined,
    private readonly projectIdOf: (agentId: string) => string,
    private readonly listProjects: () => ProjectDto[],
    private readonly listAgents: (projectId: string) => AgentDto[],
    private readonly communicationProjectionAllowed: (
      projectId: string,
      projection: Pick<CommunicationProjection, "eventId" | "surface" | "projectionKey">,
    ) => boolean,
    private readonly appendCommunicationProjection: (
      projectId: string,
      projection: CommunicationProjection,
    ) => void,
  ) {}

  recoverInterruptedExecutions(): string[] {
    const recovered: string[] = [];
    for (const project of this.listProjects()) {
      for (const agent of this.listAgents(project.id)) {
        const events = this.readEvents(agent.id);
        let startedIndex = -1;
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]!.event;
          if (event.type === "agent_lifecycle" && event.status === "running") {
            startedIndex = index;
            break;
          }
        }
        if (startedIndex < 0) continue;
        const start = events[startedIndex]!;
        const terminal = events.slice(startedIndex + 1).some((stored) =>
          stored.event.type === "agent_lifecycle" && ["cancelled", "completed", "failed", "interrupted"].includes(stored.event.status));
        if (terminal) continue;
        const executionId = start.event.type === "agent_lifecycle" ? start.event.executionId : `recovered:${agent.id}`;
        this.appendEvent(agent.id, {
          type: "agent_lifecycle", status: "failed", reason: "execution_interrupted",
          executionId,
        });
        recovered.push(agent.id);
      }
    }
    return recovered;
  }

  appendEvent(agentId: string, event: LogEvent): StoredLogEvent {
    if (!this.getAgent(agentId)) throw new Error(`unknown or deleted agent: ${agentId}`);
    const projectId = this.projectIdOf(agentId);
    const communicationEventId = event.type === "communication_projection" || event.type === "user_message"
      ? event.communicationEventId : undefined;
    if (communicationEventId && !this.communicationProjectionAllowed(projectId, {
      eventId: communicationEventId,
      surface: "direct_agent_audit",
      projectionKey: agentId,
    })) {
      // Scope validation must precede the canonical agent append. A rejected
      // projection may not leave an unprojectable user_message in events.jsonl.
      throw new Error("communication scope cannot project to requested surface");
    }
    const stored = this.eventProjection.append(agentId, projectId, event);
    const message = communicationMessageProjection(agentId, stored);
    if (communicationEventId && message) {
      this.appendCommunicationProjection(projectId, {
        eventId: communicationEventId,
        surface: "direct_agent_audit",
        projectionKey: agentId,
        projectedAt: stored.ts,
        message,
      });
    }
    return stored;
  }

  readEvents(agentId: string): StoredLogEvent[] {
    return this.eventProjection.readAll(agentId, this.projectIdOf(agentId));
  }

  readEventsSince(agentId: string, sinceSeq: number): StoredLogEvent[] {
    return this.eventProjection.readSince(agentId, sinceSeq);
  }

  lastSeqOf(agentId: string): number {
    return this.eventProjection.lastSeq(agentId);
  }

  latestHealthObservation(agentId: string): {
    status: AgentLifecycleStatus;
    statusTimestamp: string;
    reason: AgentLifecycleReason;
    executionId?: string;
  } | undefined {
    return this.eventProjection.latestHealth(agentId);
  }

  continuationHandoffForRun(agentId: string, executionId: string): {
    id: string; executionId: string; text: string; createdAt: string; consumedAt?: string;
  } | undefined {
    const row = this.db.select().from(continuationHandoffs)
      .where(and(eq(continuationHandoffs.agentId, agentId), eq(continuationHandoffs.sourceExecutionId, executionId)))
      .get();
    return row ? {
      id: row.id,
      executionId: row.sourceExecutionId,
      text: row.text,
      createdAt: row.createdAt,
      ...(row.consumedAt ? { consumedAt: row.consumedAt } : {}),
    } : undefined;
  }

  pendingContinuationHandoff(agentId: string): {
    id: string; executionId: string; text: string; createdAt: string;
  } | undefined {
    const row = this.client.prepare(`
      SELECT handoff.id, handoff.source_execution_id, handoff.text, handoff.created_at
      FROM continuation_handoffs handoff
      JOIN runs source_run ON source_run.id = handoff.source_execution_id
      WHERE handoff.agent_id = ? AND handoff.consumed_at IS NULL
        AND source_run.status = 'completed'
      ORDER BY handoff.created_at ASC, handoff.id ASC LIMIT 1
    `).get(agentId) as { id: string; source_execution_id: string; text: string; created_at: string } | undefined;
    return row ? { id: row.id, executionId: row.source_execution_id, text: row.text, createdAt: row.created_at } : undefined;
  }

  consumeContinuationHandoff(agentId: string, handoffId: string, executionId: string): boolean {
    const pending = this.client.prepare(`
      SELECT 1 FROM continuation_handoffs
      WHERE id = ? AND agent_id = ? AND consumed_at IS NULL
    `).get(handoffId, agentId);
    if (!pending) return false;
    this.appendEvent(agentId, { type: "continuation_handoff_consumed", handoffId, executionId });
    return true;
  }

  /** Durable compatibility and reachability state for the accepted provider session. */
  resumeSessionState(agentId: string): {
    sessionId: string;
    toolContractHash?: string;
    artifactIds: string[];
  } | undefined {
    const row = this.db
      .select({
        sessionId: agents.activeSessionId,
        toolContractHash: agents.activeSessionContractHash,
        artifactIdsJson: agents.activeSessionArtifactIdsJson,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    if (!row?.sessionId) return undefined;
    let artifactIds: string[] = [];
    try {
      const parsed = JSON.parse(row.artifactIdsJson) as unknown;
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) artifactIds = parsed;
    } catch {
      // A malformed rebuildable projection fails closed to no retained roots.
    }
    return {
      sessionId: row.sessionId,
      ...(row.toolContractHash ? { toolContractHash: row.toolContractHash } : {}),
      artifactIds: [...new Set(artifactIds)].sort(),
    };
  }

  /** The engine session id to resume for an agent (undefined if none yet). */
  resumeSessionId(agentId: string): string | undefined {
    return this.resumeSessionState(agentId)?.sessionId;
  }

  /**
   * Forget only the provider runtime session so the next turn seeds a fresh
   * session from canonical history. Agent identity, memberships, event logs,
   * and queued collaboration deliveries are intentionally untouched.
   */
  clearResumeSession(
    agentId: string,
    reason: "explicit_compaction" | "resume_compaction_failed" | "request_context_rollover" | "tool_contract_changed" | "provider_root_exit",
  ): boolean {
    const row = this.db
      .select({ id: agents.id, activeSessionId: agents.activeSessionId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    if (!row?.activeSessionId) return false;

    this.appendEvent(agentId, { type: "session_reset", reason });
    return true;
  }
}
