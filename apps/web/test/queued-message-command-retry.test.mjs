import assert from "node:assert/strict";
import test from "node:test";
import {
  completeQueuedMessageCommandAttempt,
  retainQueuedMessageCommandAttempt,
  runQueuedMessageCommand,
} from "../src/components/queuedMessageCommandAttempts.js";

test("queued commands retain one identity through ambiguous failures", () => {
  const registry = new Map();
  let generated = 0;
  const createId = () => `request-${++generated}`;

  for (const command of ["cancel", "steer"]) {
    const first = retainQueuedMessageCommandAttempt(
      registry,
      { command, deliveryId: "delivery-a" },
      createId,
    );
    const retry = retainQueuedMessageCommandAttempt(
      registry,
      { command, deliveryId: "delivery-a" },
      createId,
    );
    assert.equal(retry.attempt, first.attempt);
  }

  const firstEdit = retainQueuedMessageCommandAttempt(
    registry,
    { command: "edit", deliveryId: "delivery-a", text: " cafe\u0301\r\n" },
    createId,
  );
  const equivalentEdit = retainQueuedMessageCommandAttempt(
    registry,
    { command: "edit", deliveryId: "delivery-a", text: "café\n" },
    createId,
  );
  assert.equal(equivalentEdit.attempt, firstEdit.attempt);
  assert.equal(equivalentEdit.canonicalText, "café");

  const changedEdit = retainQueuedMessageCommandAttempt(
    registry,
    { command: "edit", deliveryId: "delivery-a", text: "different" },
    createId,
  );
  assert.notEqual(changedEdit.attempt, firstEdit.attempt);
});

test("queued command identity clears only after its exact success", () => {
  const registry = new Map();
  let generated = 0;
  const createId = () => `request-${++generated}`;
  const first = retainQueuedMessageCommandAttempt(
    registry,
    { command: "edit", deliveryId: "delivery-a", text: "first" },
    createId,
  );
  const changed = retainQueuedMessageCommandAttempt(
    registry,
    { command: "edit", deliveryId: "delivery-a", text: "second" },
    createId,
  );

  completeQueuedMessageCommandAttempt(registry, first.slot, first.attempt);
  assert.equal(
    retainQueuedMessageCommandAttempt(
      registry,
      { command: "edit", deliveryId: "delivery-a", text: "second" },
      createId,
    ).attempt,
    changed.attempt,
  );

  completeQueuedMessageCommandAttempt(registry, changed.slot, changed.attempt);
  assert.notEqual(
    retainQueuedMessageCommandAttempt(
      registry,
      { command: "edit", deliveryId: "delivery-a", text: "second" },
      createId,
    ).attempt,
    changed.attempt,
  );
});

test("queued command runner retries a lost response with its frozen request", async () => {
  const registry = new Map();
  const dispatched = [];
  let generated = 0;
  const createId = () => `request-${++generated}`;
  const input = {
    command: "edit",
    deliveryId: "delivery-a",
    text: " cafe\u0301\r\n",
  };

  await assert.rejects(
    runQueuedMessageCommand(registry, input, createId, async request => {
      dispatched.push(request);
      throw new Error("response lost");
    }),
    /response lost/,
  );
  await runQueuedMessageCommand(registry, input, createId, async request => {
    dispatched.push(request);
    return undefined;
  });

  assert.deepEqual(dispatched, [
    { idempotencyKey: "request-1", canonicalText: "café" },
    { idempotencyKey: "request-1", canonicalText: "café" },
  ]);

  await runQueuedMessageCommand(registry, input, createId, async request => {
    dispatched.push(request);
    return undefined;
  });
  assert.equal(dispatched[2].idempotencyKey, "request-2");
});
