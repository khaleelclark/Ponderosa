import { describe, expect, it } from "vitest";
import {
  CoordinationTransitionError,
  REQUEST_UPDATE_AUTHORIZATION,
  activationRetryDisposition,
  deriveAgentAvailability,
  evaluateCoordinationJoin,
  joinTransitionNeedsActivation,
  reduceCoordinationRequest,
  type CoordinationJoinSnapshot,
  type CoordinationRequestState,
} from "@ponderosa/core";

const nonterminal: CoordinationRequestState[] = ["open", "in_progress", "waiting_dependency", "awaiting_answer"];
const terminal: CoordinationRequestState[] = [
  "completed", "blocked", "failed", "cancelled", "superseded",
  "recipient_unavailable", "outcome_unknown", "expired",
];

describe("Communication V3 request reducer", () => {
  it("permits every terminal transition from every nonterminal state", () => {
    for (const state of nonterminal) {
      for (const kind of terminal) {
        const result = reduceCoordinationRequest(
          { state, version: 4, ...(state === "awaiting_answer" ? { openQuestionUpdateId: "question-1" } : {}) },
          { kind, updateId: `${state}-${kind}` },
        );
        expect(result).toEqual({ state: kind, version: 5 });
      }
    }
  });

  it("enforces one stable outstanding question and a correlated answer", () => {
    const questioned = reduceCoordinationRequest(
      { state: "in_progress", version: 1 },
      { kind: "question", updateId: "question-1" },
    );
    expect(questioned).toEqual({ state: "awaiting_answer", version: 2, openQuestionUpdateId: "question-1" });
    expect(() => reduceCoordinationRequest(questioned, { kind: "question", updateId: "question-2" }))
      .toThrow(CoordinationTransitionError);
    expect(() => reduceCoordinationRequest(questioned, {
      kind: "answer", updateId: "answer-1", inReplyToUpdateId: "wrong",
    })).toThrow("outstanding question");
    expect(reduceCoordinationRequest(questioned, {
      kind: "answer", updateId: "answer-1", inReplyToUpdateId: "question-1",
    })).toEqual({ state: "in_progress", version: 3 });
  });

  it("distinguishes temporary dependencies from terminal blocking", () => {
    const waiting = reduceCoordinationRequest(
      { state: "in_progress", version: 1 },
      { kind: "waiting_dependency", updateId: "dependency-1" },
    );
    expect(waiting.state).toBe("waiting_dependency");
    expect(reduceCoordinationRequest(waiting, { kind: "dependency_resolved", updateId: "dependency-2" }).state)
      .toBe("in_progress");
    expect(reduceCoordinationRequest(waiting, { kind: "blocked", updateId: "blocked-1" }).state)
      .toBe("blocked");
  });

  it("rejects mutation after terminal state", () => {
    expect(() => reduceCoordinationRequest(
      { state: "completed", version: 2 },
      { kind: "progress", updateId: "late" },
    )).toThrow("terminal");
  });

  it("keeps authorization outside the reducer as an exhaustive contract", () => {
    expect(REQUEST_UPDATE_AUTHORIZATION).toMatchObject({
      completed: "recipient",
      failed: "recipient_or_supervisor",
      question: "recipient",
      answer: "requester_or_user",
      superseded: "requester_or_user",
      recipient_unavailable: "system",
      expired: "system",
      outcome_unknown: "supervisor_or_user",
    });
  });
});

describe("Communication V3 joins and derived availability", () => {
  const join: CoordinationJoinSnapshot = {
    state: "open",
    mode: "quorum",
    quorum: 2,
    requestIds: ["a", "b", "c"],
    satisfyingOutcomes: ["completed"],
  };

  it("satisfies, remains open, or becomes impossible from immutable request outcomes", () => {
    expect(evaluateCoordinationJoin(join, new Map([
      ["a", "completed"], ["b", "open"], ["c", "failed"],
    ]))).toBe("open");
    expect(evaluateCoordinationJoin(join, new Map([
      ["a", "completed"], ["b", "completed"], ["c", "failed"],
    ]))).toBe("satisfied");
    expect(evaluateCoordinationJoin(join, new Map([
      ["a", "completed"], ["b", "superseded"], ["c", "failed"],
    ]))).toBe("impossible");
  });

  it("activates only actionable terminal join transitions", () => {
    expect(joinTransitionNeedsActivation("open", "satisfied")).toBe(true);
    expect(joinTransitionNeedsActivation("open", "impossible")).toBe(true);
    expect(joinTransitionNeedsActivation("open", "expired")).toBe(true);
    expect(joinTransitionNeedsActivation("open", "cancelled")).toBe(false);
  });

  it("derives waiting from either joins or suspended recipient requests", () => {
    expect(deriveAgentAvailability({
      hasActiveRun: false, hasActionableActivation: false, ownsOpenJoin: false, hasSuspendedRecipientRequest: true,
    })).toBe("waiting");
    expect(deriveAgentAvailability({
      hasActiveRun: false, hasActionableActivation: true, ownsOpenJoin: true, hasSuspendedRecipientRequest: true,
    })).toBe("runnable");
  });

  it("never blindly replays an injected prompt", () => {
    expect(activationRetryDisposition({ promptInjectionState: "not_injected", sameRunResumable: false })).toBe("retry");
    expect(activationRetryDisposition({ promptInjectionState: "injected", sameRunResumable: true })).toBe("resume_same_run");
    expect(activationRetryDisposition({ promptInjectionState: "injected", sameRunResumable: false })).toBe("outcome_unknown");
  });
});
