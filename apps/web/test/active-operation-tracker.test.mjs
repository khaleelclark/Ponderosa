import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_OPERATION_START_TIMEOUT_MS,
  acceptBroadcastOperation,
  acceptDirectOperation,
  activeOperationExecutionTargets,
  activeOperationForScope,
  activeOperationsForScope,
  activeOperationIsRunning,
  activeOperationReceiptIdentity,
  createActiveOperationTracker,
  createCreationOperationTracker,
  createDeliveryOperationTracker,
  createQueuedSteerOperationTracker,
  mergeActiveOperationReceipts,
  retainActiveOperation,
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

test("exact active-operation receipts override stale paginated copies", () => {
  const stale = receipt(
    "delivery-a",
    "agent-a",
    "waiting_for_run",
    "2026-09-09T12:00:00.000Z",
    "run-old",
  );
  const exact = receipt(
    "delivery-a",
    "agent-a",
    "recovering",
    "2026-09-09T12:01:00.000Z",
  );
  exact.receipt.recoveryExecutionId = "run-recovery";
  assert.deepEqual(mergeActiveOperationReceipts([exact], [stale]), [exact]);
});

test("exact receipt refresh includes every operation in only the active Chat", () => {
  assert.deepEqual(activeOperationReceiptIdentity([
    {
      kind: "delivery",
      initiatedAt,
      expiresAt: initiatedAt + 60_000,
      communicationEventId: "communication-b",
      scopeId: "chat-a",
      targets: [{ agentId: "agent-a", activationId: "activation-b" }],
    },
    {
      kind: "delivery",
      initiatedAt,
      expiresAt: initiatedAt + 60_000,
      scopeId: "chat-a",
      targets: [{ agentId: "agent-b", activationId: "activation-a" }],
    },
    {
      kind: "delivery",
      initiatedAt,
      expiresAt: initiatedAt + 60_000,
      communicationEventId: "foreign-communication",
      scopeId: "chat-b",
      targets: [{ agentId: "agent-c", activationId: "foreign-activation" }],
    },
  ], "chat-a"), {
    communicationEventIds: ["communication-b"],
    activationIds: ["activation-a", "activation-b"],
  });
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
  const awaitingTerminal = reconcileActiveOperationTracker(
    running,
    new Map(),
    [],
    initiatedAt + 3_000,
  );
  assert.ok(awaitingTerminal);
  assert.deepEqual(activeOperationExecutionTargets(awaitingTerminal), []);
  assert.equal(reconcileActiveOperationTracker(
    awaitingTerminal,
    new Map(),
    [receipt(
      "activation-a",
      "agent-a",
      "processed",
      "2026-09-09T12:00:40.000Z",
      "execution-a",
    )],
    initiatedAt + 40_000,
  ), undefined);
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

test("an exact tracker survives projection delay without attaching to another Run", () => {
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
  const delayed = reconcileActiveOperationTracker(
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
  );
  assert.ok(delayed);
  assert.deepEqual(activeOperationExecutionTargets(delayed), []);
  const exactHealth = new Map([["agent-a", health(
    "agent-a",
    "expected-execution",
    "2026-09-09T12:02:10.000Z",
  )]]);
  const exact = reconcileActiveOperationTracker(
    delayed,
    exactHealth,
    [receipt(
      "activation-a",
      "agent-a",
      "started",
      "2026-09-09T12:02:10.000Z",
      "expected-execution",
    )],
    initiatedAt + ACTIVE_OPERATION_START_TIMEOUT_MS * 2,
  );
  assert.deepEqual(activeOperationExecutionTargets(exact), [{
    agentId: "agent-a",
    runId: "expected-execution",
  }]);
});

test("only unattributed pending trackers expire", () => {
  const unattributed = createActiveOperationTracker(
    "creation",
    ["agent-a"],
    new Map(),
    initiatedAt,
  );
  assert.equal(reconcileActiveOperationTracker(
    unattributed,
    new Map(),
    [],
    initiatedAt + ACTIVE_OPERATION_START_TIMEOUT_MS + 1,
  ), undefined);
});

test("creation replay and clock skew bind only the canonical opening execution", () => {
  const tracker = createCreationOperationTracker(
    "agent-a",
    "chat-a",
    initiatedAt,
  );
  const originalHealth = new Map([["agent-a", health(
    "agent-a",
    "opening-execution",
    // Server time may precede the browser's initiation time.
    "2026-09-09T11:59:30.000Z",
  )]]);
  const original = reconcileActiveOperationTracker(
    tracker,
    originalHealth,
    [{
      ...receipt(
        "opening-activation",
        "agent-a",
        "started",
        "2026-09-09T12:00:01.000Z",
        "opening-execution",
      ),
      communicationEventId: "agent-opening:agent-a",
    }],
    initiatedAt + 1_000,
  );
  assert.deepEqual(activeOperationExecutionTargets(original), [{
    agentId: "agent-a",
    runId: "opening-execution",
  }]);

  const unrelatedHealth = new Map([["agent-a", health(
    "agent-a",
    "unrelated-execution",
    "2026-09-09T12:00:10.000Z",
  )]]);
  const replayBeforeReceipt = reconcileActiveOperationTracker(
    tracker,
    unrelatedHealth,
    [],
    initiatedAt + 10_000,
  );
  assert.deepEqual(activeOperationExecutionTargets(replayBeforeReceipt), []);
  assert.equal(reconcileActiveOperationTracker(
    replayBeforeReceipt,
    unrelatedHealth,
    [{
      ...receipt(
        "opening-activation",
        "agent-a",
        "processed",
        "2026-09-09T12:00:11.000Z",
        "opening-execution",
      ),
      communicationEventId: "agent-opening:agent-a",
    }],
    initiatedAt + 11_000,
  ), undefined);
});

test("steering recovery rebinds only its projected recovery execution", () => {
  const baseline = new Map([["agent-a", health(
    "agent-a",
    "execution-original",
    "2026-09-09T11:59:00.000Z",
  )]]);
  const pending = createDeliveryOperationTracker(
    "steer",
    ["agent-a"],
    baseline,
    initiatedAt,
    "chat-a",
  );
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
  const original = reconcileActiveOperationTracker(
    accepted,
    baseline,
    [receipt(
      "activation-a",
      "agent-a",
      "delivered",
      "2026-09-09T12:00:01.000Z",
      "execution-original",
    )],
    initiatedAt + 1_000,
  );
  const recoveryHealth = new Map([["agent-a", health(
    "agent-a",
    "execution-recovery",
    "2026-09-09T12:00:20.000Z",
  )]]);
  const recoveryReceipt = receipt(
    "activation-a",
    "agent-a",
    "recovering",
    "2026-09-09T12:00:20.000Z",
    "execution-original",
  );
  recoveryReceipt.receipt.recoveryActivationId = "activation-recovery";
  recoveryReceipt.receipt.recoveryExecutionId = "execution-recovery";
  const recovery = reconcileActiveOperationTracker(
    original,
    recoveryHealth,
    [recoveryReceipt],
    initiatedAt + 20_000,
  );
  assert.deepEqual(activeOperationExecutionTargets(recovery), [{
    agentId: "agent-a",
    runId: "execution-recovery",
  }]);
  recoveryReceipt.receipt.state = "recovered";
  assert.equal(reconcileActiveOperationTracker(
    recovery,
    new Map(),
    [recoveryReceipt],
    initiatedAt + 30_000,
  ), undefined);
});

test("operation controls are visible only in their owning Chat", () => {
  const tracker = createCreationOperationTracker("agent-a", "chat-a", initiatedAt);
  tracker.targets[0].matchedExecutionId = "execution-a";
  assert.equal(activeOperationForScope(tracker, "chat-a"), tracker);
  assert.equal(activeOperationForScope(tracker, "chat-b"), undefined);
});

test("queued-message Steer retains its exact activation and Run", () => {
  const runningHealth = new Map([["agent-a", health(
    "agent-a",
    "execution-a",
    "2026-09-09T12:00:00.000Z",
  )]]);
  const tracker = createQueuedSteerOperationTracker(
    "activation-a",
    "agent-a",
    runningHealth,
    "chat-a",
    initiatedAt,
  );
  assert.equal(tracker.targets[0].activationId, "activation-a");
  assert.deepEqual(activeOperationExecutionTargets(tracker), [{
    agentId: "agent-a",
    runId: "execution-a",
  }]);
});

test("concurrent operations remain independently addressable by Chat", () => {
  const first = createQueuedSteerOperationTracker(
    "activation-a",
    "agent-a",
    new Map([["agent-a", health(
      "agent-a",
      "execution-a",
      "2026-09-09T12:00:00.000Z",
    )]]),
    "chat-a",
    initiatedAt,
  );
  const second = createQueuedSteerOperationTracker(
    "activation-b",
    "agent-b",
    new Map([["agent-b", health(
      "agent-b",
      "execution-b",
      "2026-09-09T12:00:01.000Z",
    )]]),
    "chat-b",
    initiatedAt + 1_000,
  );
  const retained = retainActiveOperation(
    retainActiveOperation([], first),
    second,
  );
  assert.deepEqual(activeOperationsForScope(retained, "chat-a"), [first]);
  assert.deepEqual(activeOperationsForScope(retained, "chat-b"), [second]);
  assert.deepEqual(activeOperationExecutionTargets(
    activeOperationsForScope(retained, "chat-a")[0],
  ), [{ agentId: "agent-a", runId: "execution-a" }]);
});

test("All Messages receipt projection binds an idle Agent's exact Run", () => {
  const tracker = acceptDirectOperation(
    createDeliveryOperationTracker(
      "steer",
      ["agent-a"],
      new Map(),
      initiatedAt,
      "chat-a",
    ),
    {
      messageId: "message-a",
      replayed: false,
      recipients: [{
        agentId: "agent-a",
        queued: true,
        deliveryId: "activation-a",
        state: "queued",
      }],
    },
  );
  const running = reconcileActiveOperationTracker(
    tracker,
    new Map([["agent-a", health(
      "agent-a",
      "execution-a",
      "2026-09-09T12:00:02.000Z",
    )]]),
    [{
      communicationEventId: "message-a",
      receipt: {
        activationId: "activation-a",
        targetAgentId: "agent-a",
        executionId: "execution-a",
        state: "started",
        updatedAt: "2026-09-09T12:00:02.000Z",
        attemptCount: 1,
      },
    }],
  );
  assert.deepEqual(activeOperationExecutionTargets(running), [{
    agentId: "agent-a",
    runId: "execution-a",
  }]);
});
