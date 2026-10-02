import assert from "node:assert/strict";
import test from "node:test";
import { mapCodexAppServerNotification } from "../dist/codex-app-server.js";

test("only completed explicit public commentary is annotated; absent phase fails closed", () => {
  for (const phase of ["commentary", "final_answer", "unknown", null, undefined]) {
    const events = mapCodexAppServerNotification({ method: "item/completed", params: {
      item: { type: "agentMessage", text: "Public update", phase },
    } }, "/disposable");
    assert.equal(events.length, 1);
    assert.equal(events[0].delta, "Public update\n\n");
    assert.equal(events[0].presentation, phase === "commentary" ? "progress" : undefined);
  }
  assert.deepEqual(mapCodexAppServerNotification({ method: "item/agentMessage/delta", params: { delta: "partial" } }, "/disposable"), []);
  const reasoning = mapCodexAppServerNotification({ method: "item/reasoning/summaryTextDelta", params: { delta: "Private" } }, "/disposable");
  assert.equal(reasoning[0].type, "reasoning");
  assert.equal(reasoning[0].presentation, undefined);
});
