import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_OPERATION_START_TIMEOUT_MS,
  acceptBroadcastOperation,
  acceptDirectOperation,
  activeOperationExecutionTargets,
  activeOperationIsRunning,
  createDeliveryOperationTracker,
  reconcileActiveOperationTracker,
} from "../src/components/activeOperationTracker.js";

const initiatedAt = Date.parse("2026-09-09T12:00:00.000Z");
const health = (agentId, executionId, startedAt) => ({
  agentId,
  childAgentIds: [],
  status: "running",
  statusTimestamp: startedAt,
  reason: "active_run",
  runtimeActivity: { state: "responding", executionId, startedAt },
});
const receipt = (activationId, targetAgentId, state, updatedAt, executionId) => ({
  communicationEventId: "communication-a",
  receipt: {
    activationId,
    targetAgentId,
    ...(executionId ? { executionId } : {}),
    state,
    updatedAt,
    attemptCount: 1,
  },
});

test("fresh direct Steer binds its exact Run after a delayed start, then clears", () => {
  const pending = createDeliveryOperationTracker(
    "steer",
    ["agent-a"],
    new Map(),
    initiatedAt,
  );
  assert.ok(pending);
  const accepted = acceptDirectOperation(pending, {
    messageId: "message-a",
    replayed: false,
    recipients: [{
      agentId: "agent-a",
      queued: true,
      deliveryId: "activation-a",
      state: "queued",
    }],
  });
  assert.ok(accepted);
  assert.equal(activeOperationIsRunning(accepted), false);
  assert.equal(
    reconcileActiveOperationTracker(
      accepted,
      new Map(),
      [receipt("activation-a", "agent-a", "queued", "2026-09-09T12:00:01.000Z")],
      initiatedAt + 1_000,
    ),
    accepted,
  );

  const runningHealth = new Map([["agent-a", health(
    "agent-a",
    "execution-a",
    "2026-09-09T12:00:30.000Z",
  )]]);
  const running = reconcileActiveOperationTracker(
    accepted,
    runningHealth,
    [receipt(
      "activation-a",
      "agent-a",
      "started",
      "2026-09-09T12:00:01.000Z",
      "execution-a",
    )],
    initiatedAt + 30_000,
  );
  assert.ok(running);
  assert.deepEqual(activeOperationExecutionTargets(running), [{
    agentId: "agent-a",
    runId: "execution-a",
  }]);
  assert.equal(
    reconcileActiveOperationTracker(running, new Map(), [], initiatedAt + 3_000),
    undefined,
  );
});

test("accepted Steer to an already-running Agent remains cancellable", () => {
  const runningHealth = new Map([["agent-a", health(
    "agent-a",
    "execution-existing",
    "2026-09-09T11:59:00.000Z",
  )]]);
  const pending = createDeliveryOperationTracker(
    "steer",
    ["agent-a"],
    runningHealth,
    initiatedAt,
  );
  assert.ok(pending);
  const accepted = acceptDirectOperation(pending, {
    messageId: "message-a",
    replayed: false,
    recipients: [{
      agentId: "agent-a",
      queued: true,
      deliveryId: "activation-a",
      state: "queued",
    }],
  });
  assert.ok(accepted);
  assert.deepEqual(activeOperationExecutionTargets(accepted), [{
    agentId: "agent-a",
    runId: "execution-existing",
  }]);
  assert.equal(
    reconcileActiveOperationTracker(accepted, runningHealth, [], initiatedAt + 100),
    accepted,
  );
});

test("accepted Steer rebinds a finished baseline only to its receipt execution", () => {
  const baselineHealth = new Map([["agent-a", health(
    "agent-a",
    "execution-before-send",
    "2026-09-09T11:59:00.000Z",
  )]]);
  const pending = createDeliveryOperationTracker(
    "steer",
    ["agent-a"],
    baselineHealth,
    initiatedAt,
  );
  assert.ok(pending);
  const accepted = acceptDirectOperation(pending, {
    messageId: "message-a",
    replayed: false,
    recipients: [{
      agentId: "agent-a",
      queued: true,
      deliveryId: "activation-a",
      state: "queued",
    }],
  });
  assert.ok(accepted);
  const nextHealth = new Map([["agent-a", health(
    "agent-a",
    "execution-after-send",
    "2026-09-09T12:00:10.000Z",
  )]]);
  const awaitingReceipt = reconcileActiveOperationTracker(
    accepted,
    nextHealth,
    [],
    initiatedAt + 10_000,
  );
  assert.ok(awaitingReceipt);
  assert.deepEqual(activeOperationExecutionTargets(awaitingReceipt), []);
  const rebound = reconcileActiveOperationTracker(
    awaitingReceipt,
    nextHealth,
    [receipt(
      "activation-a",
      "agent-a",
      "started",
      "2026-09-09T12:00:01.000Z",
      "execution-after-send",
    )],
    initiatedAt + 10_000,
  );
  assert.ok(rebound);
  assert.deepEqual(activeOperationExecutionTargets(rebound), [{
    agentId: "agent-a",
    runId: "execution-after-send",
  }]);
});

test("targeted broadcast binds only receipts from its communication", () => {
  const pending = createDeliveryOperationTracker(
    "steer",
    ["agent-a"],
    new Map(),
    initiatedAt,
  );
  assert.ok(pending);
  const accepted = acceptBroadcastOperation(pending, "communication-a");
  assert.ok(accepted);
  const running = reconcileActiveOperationTracker(
    accepted,
    new Map([["agent-a", health(
      "agent-a",
      "broadcast-execution",
      "2026-09-09T12:00:03.000Z",
    )]]),
    [
      { ...receipt("wrong", "agent-a", "started", "2026-09-09T12:00:02.000Z", "wrong-execution"),
        communicationEventId: "other-communication" },
      receipt(
        "broadcast-activation",
        "agent-a",
        "steering",
        "2026-09-09T12:00:03.200Z",
        "broadcast-execution",
      ),
    ],
    initiatedAt + 3_200,
  );
  assert.ok(running);
  assert.deepEqual(activeOperationExecutionTargets(running), [{
    agentId: "agent-a",
    runId: "broadcast-execution",
  }]);
});

test("Queue and passive broadcasts never seed an operation tracker", () => {
  assert.equal(
    createDeliveryOperationTracker("queue", ["agent-a"], new Map(), initiatedAt),
    undefined,
  );
  assert.equal(
    createDeliveryOperationTracker("steer", [], new Map(), initiatedAt),
    undefined,
  );
});

test("terminal activation failure clears a pending tracker", () => {
  const pending = createDeliveryOperationTracker(
    "steer",
    ["agent-a"],
    new Map(),
    initiatedAt,
  );
  assert.ok(pending);
  const accepted = acceptBroadcastOperation(pending, "communication-a");
  assert.ok(accepted);
  assert.equal(reconcileActiveOperationTracker(
    accepted,
    new Map(),
    [receipt("activation-a", "agent-a", "failed", "2026-09-09T12:00:01.000Z")],
    initiatedAt + 1_000,
  ), undefined);
});

test("an unmatched or completed tracker cannot attach to a later unrelated Run", () => {
  const pending = createDeliveryOperationTracker(
    "steer",
    ["agent-a"],
    new Map(),
    initiatedAt,
  );
  assert.ok(pending);
  const accepted = acceptDirectOperation(pending, {
    messageId: "message-a",
    replayed: false,
    recipients: [{
      agentId: "agent-a",
      queued: true,
      deliveryId: "activation-a",
      state: "queued",
    }],
  });
  assert.ok(accepted);
  const laterHealth = new Map([["agent-a", health(
    "agent-a",
    "unrelated-execution",
    "2026-09-09T12:02:00.000Z",
  )]]);
  const stillPending = reconcileActiveOperationTracker(
    accepted,
    laterHealth,
    [receipt(
      "activation-a",
      "agent-a",
      "started",
      "2026-09-09T12:00:01.000Z",
      "expected-execution",
    )],
    initiatedAt + 2_000,
  );
  assert.equal(stillPending, accepted);
  assert.deepEqual(activeOperationExecutionTargets(stillPending), []);
  assert.equal(reconcileActiveOperationTracker(
    accepted,
    laterHealth,
    [receipt(
      "activation-a",
      "agent-a",
      "started",
      "2026-09-09T12:00:01.000Z",
      "expected-execution",
    )],
    initiatedAt + ACTIVE_OPERATION_START_TIMEOUT_MS + 1,
  ), undefined);
});
