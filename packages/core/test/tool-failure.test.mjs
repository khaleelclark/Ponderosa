import assert from "node:assert/strict";
import test from "node:test";
import { classifyToolFailure, toolFailureLabel } from "../dist/tool-failure.js";

test("unavailable host files are permanent tool failures, not connection failures", () => {
  for (const output of [
    "host file is unavailable, unsafe, empty, changing, or larger than 64 MiB",
    '{"error":"host file is unavailable, unsafe, empty, changing, or larger than 64 MiB"}',
    "host file is unavailable",
    "host file is unsafe",
    "host file is empty",
    "host file is changing",
    "host file is larger than 64 MiB",
  ]) {
    assert.deepEqual(classifyToolFailure(output, true), {
      category: "permanent_failure",
      retryable: false,
    });
  }
  assert.equal(toolFailureLabel("permanent_failure"), "Tool failed");
});

test("explicit transport, service outages, and structured UNAVAILABLE failures remain retryable", () => {
  for (const output of [
    "HTTP 503 Service Unavailable",
    "upstream returned 502",
    "gateway returned 504",
    "connection refused",
    "connection reset",
    "network error",
    "request timed out",
    "service temporarily unavailable",
    "service unavailable",
    "provider UNAVAILABLE",
    "the provider is temporarily unavailable",
    "temporarily unavailable service",
    '{"error_code":"UNAVAILABLE"}',
    '[{"type":"inputText","text":"{\\"error_code\\":\\"UNAVAILABLE\\"}"}]',
  ]) {
    assert.deepEqual(classifyToolFailure(output, true), {
      category: "temporary_connection_failure",
      retryable: true,
    });
  }
  assert.deepEqual(classifyToolFailure("temporarily unavailable host file", true), {
    category: "permanent_failure",
    retryable: false,
  });
  assert.deepEqual(classifyToolFailure("provider file unavailable", true), {
    category: "permanent_failure",
    retryable: false,
  });
});

test("authentication, permission, and invalid-input failures keep their classifications", () => {
  for (const [output, category] of [
    ["HTTP 401 Unauthorized", "authentication_required"],
    ["403 permission denied", "permission_denied"],
    ["400 invalid input", "invalid_input"],
    ['this Run has no unambiguous reply route; use intent "broadcast", "direct_to_user", or "collaboration" explicitly', "invalid_input"],
  ]) {
    assert.deepEqual(classifyToolFailure(output, true), { category, retryable: false });
  }
});

test("workspace paths containing oauth do not imply an authentication failure", () => {
  for (const output of [
    `sh: 1: tsc: not found
/home/phoenix/khaleel/job-tracker-chatgpt-oauth-20260920/apps/mcp-server:
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`,
    `src/lib/db.ts(1,10): error TS2305: Module '"@prisma/client"' has no exported member 'PrismaClient'.
/home/phoenix/khaleel/job-tracker-chatgpt-oauth-20260920/apps/mcp-server:
Exit status 2`,
  ]) {
    assert.deepEqual(classifyToolFailure(output, true), {
      category: "permanent_failure",
      retryable: false,
    });
  }
});

test("explicit OAuth and HTTP authentication failures remain classified", () => {
  for (const output of [
    "OAuth authentication required",
    "OAuth token expired",
    '{"error":"invalid_grant"}',
    "HTTP status 401",
    "HTTP 401",
    "HTTP/1.1 401",
    "401 Unauthorized",
    '{"status":401,"message":"request failed"}',
    '{"statusCode":401,"error":"request failed"}',
    "Request failed with status 401",
    "Request failed with status code 401",
    "Error code 401",
    "401: token expired",
    "OAuth access token expired",
    "Bearer token expired",
  ]) {
    assert.deepEqual(classifyToolFailure(output, true), {
      category: "authentication_required",
      retryable: false,
    });
  }
});
