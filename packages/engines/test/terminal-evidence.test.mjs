import assert from "node:assert/strict";
import test from "node:test";
import { mapCodexAppServerNotification } from "../dist/codex-app-server.js";
import { projectAgentEvent } from "../dist/agent-event-projection.js";

test("only an explicit provider completed status proves completion; interruption and unknown remain failures", () => {
  for (const status of ["completed", "failed", "interrupted", "inProgress", "unknown", undefined]) {
    const events = mapCodexAppServerNotification({ method: "turn/completed", params: { turn: { id: "exact", status } } }, "/synthetic");
    assert.equal(events.length, 1);
    const projected = projectAgentEvent(events[0]);
    assert.equal(projected.type, status === "completed" ? "turn_done" : "error");
    if (status !== "completed") assert.equal(projected.terminalStatus, status === "failed" || status === "interrupted" ? status : "unknown");
    if (status === "interrupted") assert.match(projected.message, /interrupted/);
  }
  for (const terminalStatus of ["completed", "cancelled", "untrusted prose", 1]) assert.throws(() => projectAgentEvent({ type: "error", message: "not completion", terminalStatus }), { code: "invalid_agent_event" });
  assert.equal(projectAgentEvent({ type: "error", message: "ordinary error" }).terminalStatus, undefined);
});
