/** Communication V3 coordination contracts.
 *
 * Agents are durable identities. Requests, joins, activations, runs, provider
 * sessions, and processes have independent lifetimes. This module contains only
 * pure state reduction; callers must authorize actors and persist transitions
 * transactionally before invoking scheduler side effects.
 */

export type RequestLifetime =
  | { kind: "deadline"; at: string }
  | { kind: "indefinite" };

export type CoordinationRequestState =
  | "open"
  | "in_progress"
  | "waiting_dependency"
  | "awaiting_answer"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "superseded"
  | "recipient_unavailable"
  | "outcome_unknown"
  | "expired";

/** Canonical private Request audience; roster/manager visibility adds no access. */
export function requestParticipantAgentIds(request: { requesterAgentId?: string; recipientAgentId: string }): string[] {
  return [...new Set([...(request.requesterAgentId ? [request.requesterAgentId] : []), request.recipientAgentId])];
}

export function agentCanReadRequest(request: { requesterAgentId?: string; recipientAgentId: string }, agentId: string): boolean {
  return requestParticipantAgentIds(request).includes(agentId);
}

export type CoordinationRequestUpdateKind =
  | "progress"
  | "waiting_dependency"
  | "dependency_resolved"
  | "question"
  | "answer"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "superseded"
  | "recipient_unavailable"
  | "outcome_unknown"
  | "expired";

export type CoordinationActorClass = "recipient" | "recipient_or_supervisor" | "requester_or_user" | "system" | "supervisor_or_user";

export const REQUEST_UPDATE_AUTHORIZATION: Readonly<Record<CoordinationRequestUpdateKind, CoordinationActorClass>> = {
  progress: "recipient",
  waiting_dependency: "recipient",
  dependency_resolved: "recipient",
  question: "recipient",
  completed: "recipient",
  blocked: "recipient",
  failed: "recipient_or_supervisor",
  answer: "requester_or_user",
  cancelled: "requester_or_user",
  superseded: "requester_or_user",
  recipient_unavailable: "system",
  expired: "system",
  outcome_unknown: "supervisor_or_user",
};

export const TERMINAL_REQUEST_STATES: ReadonlySet<CoordinationRequestState> = new Set([
  "completed", "blocked", "failed", "cancelled", "superseded",
  "recipient_unavailable", "outcome_unknown", "expired",
]);

export interface CoordinationRequestSnapshot {
  state: CoordinationRequestState;
  version: number;
  openQuestionUpdateId?: string;
  /** An open Join owned by this Request remains the authority for suspension. */
  ownsUnresolvedJoin?: boolean;
}

export interface CoordinationRequestTransition {
  kind: CoordinationRequestUpdateKind;
  updateId: string;
  inReplyToUpdateId?: string;
}

export class CoordinationTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinationTransitionError";
  }
}

const TERMINAL_BY_UPDATE: Partial<Record<CoordinationRequestUpdateKind, CoordinationRequestState>> = {
  completed: "completed",
  blocked: "blocked",
  failed: "failed",
  cancelled: "cancelled",
  superseded: "superseded",
  recipient_unavailable: "recipient_unavailable",
  outcome_unknown: "outcome_unknown",
  expired: "expired",
};

/** Exhaustive request reducer. Authorization and idempotent replay happen before this call. */
export function reduceCoordinationRequest(
  current: CoordinationRequestSnapshot,
  transition: CoordinationRequestTransition,
): CoordinationRequestSnapshot {
  if (TERMINAL_REQUEST_STATES.has(current.state)) {
    throw new CoordinationTransitionError(`request is terminal (${current.state})`);
  }

  const terminal = TERMINAL_BY_UPDATE[transition.kind];
  if (terminal) {
    return { state: terminal, version: current.version + 1 };
  }

  switch (transition.kind) {
    case "progress":
      if (current.state === "awaiting_answer") {
        throw new CoordinationTransitionError("answer or a terminal update is required while awaiting an answer");
      }
      return {
        state: current.state === "waiting_dependency" && current.ownsUnresolvedJoin
          ? "waiting_dependency"
          : "in_progress",
        version: current.version + 1,
      };
    case "waiting_dependency":
      if (current.state === "awaiting_answer") {
        throw new CoordinationTransitionError("answer or a terminal update is required while awaiting an answer");
      }
      return { state: "waiting_dependency", version: current.version + 1 };
    case "dependency_resolved":
      if (current.state !== "waiting_dependency") {
        throw new CoordinationTransitionError("dependency_resolved requires waiting_dependency");
      }
      return { state: "in_progress", version: current.version + 1 };
    case "question":
      if (current.state === "awaiting_answer" || current.openQuestionUpdateId) {
        throw new CoordinationTransitionError("only one blocking question may be outstanding");
      }
      return {
        state: "awaiting_answer",
        version: current.version + 1,
        openQuestionUpdateId: transition.updateId,
      };
    case "answer":
      if (current.state !== "awaiting_answer" || !current.openQuestionUpdateId) {
        throw new CoordinationTransitionError("answer requires an outstanding question");
      }
      if (transition.inReplyToUpdateId !== current.openQuestionUpdateId) {
        throw new CoordinationTransitionError("answer must reference the outstanding question");
      }
      return { state: "in_progress", version: current.version + 1 };
    default:
      throw new CoordinationTransitionError(`unsupported request update: ${transition.kind}`);
  }
}

export type CoordinationJoinMode = "all" | "any" | "quorum";
export type CoordinationJoinWakePolicy = "each_result" | "final_only";
export interface CoordinationReplyAuthority {
  intent: "broadcast" | "direct_to_user" | "collaboration";
  recipientAgentIds?: string[];
}
export type CoordinationJoinState = "open" | "satisfied" | "impossible" | "expired" | "cancelled";

export interface CoordinationJoinSnapshot {
  state: CoordinationJoinState;
  mode: CoordinationJoinMode;
  quorum: number;
  requestIds: readonly string[];
  satisfyingOutcomes: readonly CoordinationRequestState[];
}

export function requiredJoinCount(join: Pick<CoordinationJoinSnapshot, "mode" | "quorum" | "requestIds">): number {
  return join.mode === "all" ? join.requestIds.length : join.mode === "any" ? 1 : join.quorum;
}

/** Reevaluate one immutable join after a member request transition. */
export function evaluateCoordinationJoin(
  join: CoordinationJoinSnapshot,
  requestStates: ReadonlyMap<string, CoordinationRequestState>,
): CoordinationJoinState {
  if (join.state !== "open") return join.state;
  const states = join.requestIds.map((requestId) => {
    const state = requestStates.get(requestId);
    if (!state) throw new CoordinationTransitionError(`join request is missing: ${requestId}`);
    return state;
  });
  const satisfying = new Set(join.satisfyingOutcomes);
  const completed = states.filter((state) => satisfying.has(state)).length;
  const stillPossible = states.filter((state) => !TERMINAL_REQUEST_STATES.has(state)).length;
  const required = requiredJoinCount(join);
  if (completed >= required) return "satisfied";
  if (completed + stillPossible < required) return "impossible";
  return "open";
}

export function joinTransitionNeedsActivation(
  previous: CoordinationJoinState,
  next: CoordinationJoinState,
): boolean {
  return previous === "open" && (next === "satisfied" || next === "impossible" || next === "expired");
}

export type DerivedAgentAvailability = "running" | "runnable" | "waiting" | "idle";

export function deriveAgentAvailability(input: {
  hasActiveRun: boolean;
  hasActionableActivation: boolean;
  ownsOpenJoin: boolean;
  hasSuspendedRecipientRequest: boolean;
}): DerivedAgentAvailability {
  if (input.hasActiveRun) return "running";
  if (input.hasActionableActivation) return "runnable";
  if (input.ownsOpenJoin || input.hasSuspendedRecipientRequest) return "waiting";
  return "idle";
}

export type PromptInjectionState = "not_injected" | "injecting" | "injected";

export function activationRetryDisposition(input: {
  promptInjectionState: PromptInjectionState;
  sameRunResumable: boolean;
}): "retry" | "resume_same_run" | "outcome_unknown" {
  if (input.promptInjectionState === "not_injected") return "retry";
  return input.sameRunResumable ? "resume_same_run" : "outcome_unknown";
}
