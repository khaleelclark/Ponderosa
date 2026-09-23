import type {
  AgentLifecycleReason,
  AgentLifecycleStatus,
} from "@ponderosa/core";
import type { LogEvent, StoredLogEvent } from "./log-event.js";
import type { AgentEventSessionAuthority } from "./store-event-session-authority.js";

/**
 * Public event-log and continuation facade shared by AgentStore while the
 * authority implementation remains replaceable during construction.
 */
export abstract class AgentEventSessionFacade {
  protected abstract readonly eventSession: AgentEventSessionAuthority;

  appendEvent(agentId: string, event: LogEvent, ts?: string): StoredLogEvent {
    return this.eventSession.appendEvent(agentId, event, ts);
  }

  readEvents(agentId: string): StoredLogEvent[] {
    return this.eventSession.readEvents(agentId);
  }

  readEventsSince(agentId: string, sinceSeq: number, limit?: number): StoredLogEvent[] {
    return this.eventSession.readEventsSince(agentId, sinceSeq, limit);
  }

  lastSeqOf(agentId: string): number {
    return this.eventSession.lastSeqOf(agentId);
  }

  latestHealthObservation(agentId: string): {
    status: AgentLifecycleStatus;
    statusTimestamp: string;
    reason: AgentLifecycleReason;
    executionId?: string;
  } | undefined {
    return this.eventSession.latestHealthObservation(agentId);
  }

  continuationHandoffForRun(agentId: string, executionId: string): {
    id: string;
    executionId: string;
    text: string;
    createdAt: string;
    consumedAt?: string;
  } | undefined {
    return this.eventSession.continuationHandoffForRun(agentId, executionId);
  }

  continuationHandoffForRollover(
    agentId: string,
    handoffId: string,
    sourceExecutionId?: string,
  ): {
    id: string;
    executionId: string;
    text: string;
    createdAt: string;
    consumedAt?: string;
  } | undefined {
    return this.eventSession.continuationHandoffForRollover(
      agentId,
      handoffId,
      sourceExecutionId,
    );
  }

  continuationHandoffForContextRollover(
    agentId: string,
    rolloverId: string,
  ): {
    id: string;
    executionId: string;
    text: string;
    createdAt: string;
    consumedAt?: string;
  } | undefined {
    return this.eventSession.continuationHandoffForContextRollover(
      agentId,
      rolloverId,
    );
  }

  pendingContinuationHandoff(agentId: string, scopeKey?: string): {
    id: string;
    executionId: string;
    text: string;
    createdAt: string;
  } | undefined {
    return this.eventSession.pendingContinuationHandoff(agentId, scopeKey);
  }

  consumeContinuationHandoff(
    agentId: string,
    handoffId: string,
    executionId: string,
  ): boolean {
    return this.eventSession.consumeContinuationHandoff(
      agentId,
      handoffId,
      executionId,
    );
  }

  resumeSessionState(agentId: string): {
    sessionId: string;
    toolContractHash?: string;
    artifactIds: string[];
  } | undefined {
    return this.eventSession.resumeSessionState(agentId);
  }

  resumeSessionId(agentId: string): string | undefined {
    return this.eventSession.resumeSessionId(agentId);
  }

  clearResumeSession(
    agentId: string,
    reason:
      | "explicit_compaction"
      | "resume_compaction_failed"
      | "request_context_rollover"
      | "tool_contract_changed"
      | "provider_root_exit",
  ): boolean {
    return this.eventSession.clearResumeSession(agentId, reason);
  }
}
