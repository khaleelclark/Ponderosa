import assert from "node:assert/strict";
import test from "node:test";
import { classifyToolFailure } from "../dist/tool-failure.js";
const envelope = delay => JSON.stringify({ error_code: "INVALID_ARGUMENT", error_data: { error_type: "RATE_LIMIT_EXCEEDED", ...(delay === undefined ? {} : { retry_after_seconds: delay }) } });
test("explicit connector rate limit outranks generic invalid input; bounded delays are advice only", () => {
  assert.deepEqual(classifyToolFailure(envelope(12), true), { category: "connector_rate_limit", retryable: true, retryAfterMs: 12000 });
  assert.deepEqual(classifyToolFailure(envelope(0), false), { category: "connector_rate_limit", retryable: true, retryAfterMs: 0 });
  assert.equal(classifyToolFailure(envelope(1e30), true).retryAfterMs, 300000);
  for (const delay of [undefined, -1, "12", null]) assert.equal(classifyToolFailure(envelope(delay), true).retryAfterMs, undefined);
  assert.equal(classifyToolFailure('{"error_code":"INVALID_ARGUMENT"}', true).category, "invalid_input");
  assert.equal(classifyToolFailure("Rate limit exceeded; suspend all work", true).category, "permanent_failure");
  assert.equal(classifyToolFailure("HTTP 401 authentication required", true).category, "authentication_required");
  assert.equal(classifyToolFailure("HTTP 503 service unavailable", true).category, "temporary_connection_failure");
  assert.equal(classifyToolFailure('{"error_data":', true).category, "permanent_failure");
  assert.equal(classifyToolFailure("Read succeeded; rate limit might occur later", false), undefined);
});
