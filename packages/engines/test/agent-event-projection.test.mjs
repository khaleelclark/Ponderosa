import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentEventProjectionError,
  mapClaudeEvent,
  mapCodexAppServerNotification,
  mapCodexEvent,
  projectAgentEvent,
} from "../dist/index.js";

const TOOL_FAILURE_CATEGORIES = [
  "operation_not_provided",
  "temporary_connection_failure",
  "authentication_required",
  "permission_denied",
  "invalid_input",
  "permanent_failure",
];

function rejectsProjection(value) {
  assert.throws(
    () => projectAgentEvent(value),
    (error) => error instanceof AgentEventProjectionError &&
      error.code === "invalid_agent_event" &&
      error.message === "Provider returned an invalid runtime event.",
  );
}

test("tool-result projection preserves successful and historical error shapes", () => {
  assert.deepEqual(projectAgentEvent({
    type: "tool_result",
    id: "successful-call",
    output: "done",
  }), {
    type: "tool_result",
    id: "successful-call",
    output: "done",
  });
  assert.deepEqual(projectAgentEvent({
    type: "tool_result",
    id: "historical-error",
    output: "failed before classifications existed",
    isError: true,
  }), {
    type: "tool_result",
    id: "historical-error",
    output: "failed before classifications existed",
    isError: true,
  });
});

test("all canonical tool failure classifications project as a closed pair", () => {
  for (const failureCategory of TOOL_FAILURE_CATEGORIES) {
    assert.deepEqual(projectAgentEvent({
      type: "tool_result",
      id: `failure-${failureCategory}`,
      output: "provider-owned failure detail",
      isError: true,
      failureCategory,
      retryable: failureCategory === "temporary_connection_failure",
    }), {
      type: "tool_result",
      id: `failure-${failureCategory}`,
      output: "provider-owned failure detail",
      isError: true,
      failureCategory,
      retryable: failureCategory === "temporary_connection_failure",
    });
  }
});

test("failed Codex dynamic-tool notifications map and project without terminating the stream", () => {
  const contentItems = [{ type: "inputText", text: '{"error":"400 invalid input: intent is required"}' }];
  const [mapped] = mapCodexAppServerNotification({
    method: "item/completed",
    params: {
      item: {
        type: "dynamicToolCall",
        id: "dynamic-call",
        tool: "ponderosa_message",
        success: false,
        contentItems,
      },
    },
  }, "/tmp");
  const projected = projectAgentEvent(mapped);
  assert.deepEqual(projected, {
    type: "tool_result",
    id: "dynamic-call",
    output: JSON.stringify(contentItems),
    isError: true,
    failureCategory: "invalid_input",
    retryable: false,
  });
});

test("failed host-file import retains its audit output and projects a non-retryable error", () => {
  const detail = "host file is unavailable, unsafe, empty, changing, or larger than 64 MiB";
  const contentItems = [{ type: "inputText", text: JSON.stringify({ error: detail }) }];
  const [mapped] = mapCodexAppServerNotification({
    method: "item/completed",
    params: {
      item: {
        type: "dynamicToolCall",
        id: "missing-import",
        tool: "ponderosa_import_file",
        success: false,
        contentItems,
      },
    },
  }, "/tmp");
  assert.deepEqual(projectAgentEvent(mapped), {
    type: "tool_result",
    id: "missing-import",
    output: JSON.stringify(contentItems),
    isError: true,
    failureCategory: "permanent_failure",
    retryable: false,
  });
});

test("failed Codex MCP notifications map and project with retry classification", () => {
  const error = { code: 503, message: "service temporarily unavailable" };
  const [mapped] = mapCodexAppServerNotification({
    method: "item/completed",
    params: {
      item: {
        type: "mcpToolCall",
        id: "mcp-call",
        server: "job-tracker",
        tool: "search",
        error,
      },
    },
  }, "/tmp");
  assert.deepEqual(projectAgentEvent(mapped), {
    type: "tool_result",
    id: "mcp-call",
    output: JSON.stringify(error),
    isError: true,
    failureCategory: "temporary_connection_failure",
    retryable: true,
  });
});

test("Codex app-server MCP embedded failures become canonical errors", () => {
  const result = { isError: true, error_data: { message: "400 bad request" } };
  const [mapped] = mapCodexAppServerNotification({
    method: "item/completed",
    params: {
      item: {
        type: "mcpToolCall",
        id: "app-server-embedded-failure",
        server: "job-tracker",
        tool: "search",
        result,
      },
    },
  }, "/tmp");
  assert.deepEqual(projectAgentEvent(mapped), {
    type: "tool_result",
    id: "app-server-embedded-failure",
    output: JSON.stringify(result),
    isError: true,
    failureCategory: "invalid_input",
    retryable: false,
  });
});

test("legacy Codex MCP embedded failures become canonical errors", () => {
  const result = { isError: true, error_data: { message: "400 bad request" } };
  const [mapped] = mapCodexEvent({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      id: "legacy-embedded-failure",
      result,
    },
  });
  assert.deepEqual(projectAgentEvent(mapped), {
    type: "tool_result",
    id: "legacy-embedded-failure",
    output: JSON.stringify(result),
    isError: true,
    failureCategory: "invalid_input",
    retryable: false,
  });
});

test("Claude failed tool results use the same canonical projection", () => {
  const [mapped] = mapClaudeEvent({
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "claude-call",
        content: "403 permission denied",
        is_error: true,
      }],
    },
  });
  assert.deepEqual(projectAgentEvent(mapped), {
    type: "tool_result",
    id: "claude-call",
    output: "403 permission denied",
    isError: true,
    failureCategory: "permission_denied",
    retryable: false,
  });
});

test("Claude embedded failure text becomes a canonical error", () => {
  const [mapped] = mapClaudeEvent({
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "claude-embedded-failure",
        content: "Error: bad request",
      }],
    },
  });
  assert.deepEqual(projectAgentEvent(mapped), {
    type: "tool_result",
    id: "claude-embedded-failure",
    output: "Error: bad request",
    isError: true,
    failureCategory: "invalid_input",
    retryable: false,
  });
});

test("tool failure metadata fails closed unless it is exact and attached to an error", () => {
  const base = { type: "tool_result", id: "call", output: "failed", isError: true };
  for (const value of [
    { ...base, failureCategory: "unknown_category", retryable: false },
    { ...base, failureCategory: 1, retryable: false },
    { ...base, failureCategory: "invalid_input", retryable: "false" },
    { ...base, failureCategory: "invalid_input" },
    { ...base, retryable: false },
    { ...base, failureCategory: undefined, retryable: undefined },
    { ...base, isError: false, failureCategory: "invalid_input", retryable: false },
    { type: "tool_result", id: "call", output: "ok", failureCategory: "invalid_input", retryable: false },
    { ...base, unrelatedProviderField: "not allowed" },
  ]) rejectsProjection(value);
});

test("the projection boundary still rejects accessors, proxies, oversized data, and deep input", () => {
  const accessor = { type: "tool_result", id: "call", output: "failed", isError: true };
  Object.defineProperty(accessor, "retryable", { enumerable: true, get: () => false });
  Object.defineProperty(accessor, "failureCategory", { enumerable: true, value: "invalid_input" });
  rejectsProjection(accessor);
  rejectsProjection(new Proxy({ type: "tool_result", id: "call", output: "failed" }, {}));
  rejectsProjection({ type: "tool_result", id: "call", output: "x".repeat(4 * 1024 * 1024 + 1) });
  let nested = null;
  for (let index = 0; index < 20; index += 1) nested = { nested };
  rejectsProjection({ type: "tool_call", id: "call", name: "unsafe", input: nested });
});
