import assert from "node:assert/strict";
import test from "node:test";
import { mapCodexAppServerNotification } from "../dist/codex-app-server.js";
import { mapCodexEvent } from "../dist/events.js";
import { projectAgentEvent } from "../dist/agent-event-projection.js";

test("provider command exit and signal survive strict projection without a terminal Run event", () => {
  for (const exitCode of [0, 1, 2, -1]) {
    for (const signal of [undefined, "SIGTERM"]) {
      const event = mapCodexAppServerNotification({ method: "item/completed", params: { item: { type: "commandExecution", id: "command", aggregatedOutput: "", exitCode, signal } } }, "/synthetic")[0];
      const projected = projectAgentEvent(event);
      assert.equal(projected.type, "tool_result"); assert.equal(projected.exitCode, exitCode); assert.equal(projected.signal, signal);
      assert.equal(projected.isError === true, exitCode !== 0 || Boolean(signal));
      const cli = mapCodexEvent({ type: "item.completed", item: { type: "command_execution", id: "command", aggregated_output: "", exit_code: exitCode, signal } }, { cwd: "/synthetic" })[0];
      assert.deepEqual(projectAgentEvent(cli), projected);
    }
  }
  assert.deepEqual(projectAgentEvent({ type: "tool_result", id: "historical", output: "" }), { type: "tool_result", id: "historical", output: "" });
  for (const field of [{ exitCode: NaN }, { exitCode: 1.5 }, { exitCode: 2147483648 }, { signal: "arbitrary prose" }, { retryAfterMs: 1 }]) {
    assert.throws(() => projectAgentEvent({ type: "tool_result", id: "bad", output: "", ...field }), { code: "invalid_agent_event" });
  }
});

test("connector envelope retains original output and bounded delay through strict projection", () => {
  const output = JSON.stringify({ error_code: "INVALID_ARGUMENT", error_data: { error_type: "RATE_LIMIT_EXCEEDED", retry_after_seconds: 2 } });
  const events = mapCodexAppServerNotification({ method: "item/completed", params: { item: { type: "mcpToolCall", id: "connector", status: "failed", error: output } } }, "/synthetic");
  const event = events.find(event => event.type === "tool_result");
  assert.ok(event);
  const projected = projectAgentEvent(event);
  assert.equal(projected.failureCategory, "connector_rate_limit"); assert.equal(projected.retryAfterMs, 2000);
  assert.ok(projected.output.includes("RATE_LIMIT_EXCEEDED"));
});
