import assert from "node:assert/strict";
import test from "node:test";
import { classifyToolFailure } from "../dist/tool-failure.js";

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
