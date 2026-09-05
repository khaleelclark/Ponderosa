import assert from "node:assert/strict";
import test from "node:test";
import { retainIdempotentAttempt } from "../src/components/idempotentAttempt.js";
import {
  recipientActionSnapshot,
  recipientUploadCacheKey,
} from "../src/conversationRouting.js";

test("Agent creation retries retain one identity until the submitted form changes", () => {
  let generated = 0;
  const createId = () => `request-${++generated}`;
  const first = retainIdempotentAttempt(undefined, "payload-a", createId, () => ({ uploads: ["one"] }));
  const retry = retainIdempotentAttempt(first, "payload-a", createId, () => ({ uploads: ["two"] }));
  const changed = retainIdempotentAttempt(retry, "payload-b", createId, () => ({ uploads: [] }));

  assert.equal(retry, first);
  assert.equal(retry.idempotencyKey, "request-1");
  assert.deepEqual(retry.prepared.uploads, ["one"]);
  assert.equal(changed.idempotencyKey, "request-2");
});

test("recipient and broadcast-owner changes start a new prepared action", () => {
  let generated = 0;
  const createId = () => `request-${++generated}`;
  const fingerprint = (ids, owner) => JSON.stringify({
    text: "continue",
    ...recipientActionSnapshot(ids, owner),
  });
  const first = retainIdempotentAttempt(
    undefined,
    fingerprint(["agent-b", "agent-a"], "agent-a"),
    createId,
    () => ({ uploads: "original" }),
  );
  const reordered = retainIdempotentAttempt(
    first,
    fingerprint(["agent-a", "agent-b"], "agent-a"),
    createId,
    () => ({ uploads: "replacement" }),
  );
  const rosterChanged = retainIdempotentAttempt(
    reordered,
    fingerprint(["agent-a", "agent-c"], "agent-a"),
    createId,
    () => ({ uploads: "new-roster" }),
  );
  const ownerChanged = retainIdempotentAttempt(
    rosterChanged,
    fingerprint(["agent-a", "agent-c"], "agent-c"),
    createId,
    () => ({ uploads: "new-owner" }),
  );

  assert.equal(reordered, first);
  assert.equal(rosterChanged.idempotencyKey, "request-2");
  assert.equal(ownerChanged.idempotencyKey, "request-3");
  assert.notEqual(
    recipientUploadCacheKey("direct", ["agent-a"]),
    recipientUploadCacheKey("direct", ["agent-b"]),
  );
});
