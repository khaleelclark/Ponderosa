import assert from "node:assert/strict";
import test from "node:test";
import { mapCodexAppServerNotification } from "../dist/codex-app-server.js";
import { projectAgentEvent } from "../dist/agent-event-projection.js";

test("only completed explicit public commentary is annotated; absent phase fails closed", () => {
  for (const phase of ["commentary", "final_answer", "unknown", null, undefined]) {
    const events = mapCodexAppServerNotification({ method: "item/completed", params: {
      item: { type: "agentMessage", text: "Public update", phase },
    } }, "/disposable");
    assert.equal(events.length, 1);
    assert.equal(events[0].delta, "Public update\n\n");
    assert.equal(events[0].presentation, phase === "commentary" ? "progress" : undefined);
    assert.deepEqual(projectAgentEvent(events[0]), events[0]);
  }
  assert.deepEqual(mapCodexAppServerNotification({ method: "item/agentMessage/delta", params: { delta: "partial" } }, "/disposable"), []);
  const reasoning = mapCodexAppServerNotification({ method: "item/reasoning/summaryTextDelta", params: { delta: "Private" } }, "/disposable");
  assert.equal(reasoning[0].type, "reasoning");
  assert.equal(reasoning[0].presentation, undefined);
});

test("public progress is a closed text-only field and does not weaken event validation", () => {
  for (const presentation of ["commentary", "reasoning", "final_answer", "", null, undefined, true, {}]) {
    assert.throws(() => projectAgentEvent({ type: "text", delta: "update", presentation }), /invalid runtime event/);
  }
  for (const event of [{ type: "reasoning", delta: "private" }, { type: "turn_done" }, { type: "error", message: "failed" }]) {
    assert.throws(() => projectAgentEvent({ ...event, presentation: "progress" }), /invalid runtime event/);
  }
  assert.throws(() => projectAgentEvent({ type: "text", delta: "update", presentation: "progress", extra: true }), /invalid runtime event/);
  let reads = 0;
  const accessor = { type: "text", delta: "update", get presentation() { reads++; return "progress"; } };
  assert.throws(() => projectAgentEvent(accessor), /invalid runtime event/);
  assert.equal(reads, 0);
  assert.throws(() => projectAgentEvent(new Proxy({ type: "text", delta: "update", presentation: "progress" }, {
    ownKeys() { reads++; return []; },
  })), /invalid runtime event/);
  assert.equal(reads, 0);
  assert.throws(() => projectAgentEvent({ type: "text", delta: "x".repeat(4 * 1024 * 1024), presentation: "progress" }), /invalid runtime event/);
  assert.deepEqual(projectAgentEvent({ type: "text", delta: "ordinary" }), { type: "text", delta: "ordinary" });
  assert.deepEqual(projectAgentEvent({ type: "reasoning", delta: "private" }), { type: "reasoning", delta: "private" });
});
