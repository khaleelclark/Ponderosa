import assert from "node:assert/strict";
import test from "node:test";
import { retainAgentCreateAttempt } from "../src/components/agentCreateRetry.js";

test("Agent creation retries retain one identity until the submitted form changes", () => {
  let generated = 0;
  const createId = () => `request-${++generated}`;
  const first = retainAgentCreateAttempt(undefined, "payload-a", createId);
  const retry = retainAgentCreateAttempt(first, "payload-a", createId);
  const changed = retainAgentCreateAttempt(retry, "payload-b", createId);

  assert.equal(retry, first);
  assert.equal(retry.idempotencyKey, "request-1");
  assert.equal(changed.idempotencyKey, "request-2");
});
