import assert from "node:assert/strict";
import test from "node:test";
import { retainIdempotentAttempt } from "../src/components/idempotentAttempt.js";

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
