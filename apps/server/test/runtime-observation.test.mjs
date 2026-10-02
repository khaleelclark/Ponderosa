import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore } from "@ponderosa/agents";
import { runtimeObservation } from "../dist/runtime-observation.js";

test("interruption diagnostics preserve exact bounded evidence without inventing an origin or completion", () => {
  const run = { runId: "execution", v3SchedulerRunId: "exact-run", v3FencingToken: 7, generation: 3 };
  const unconfirmed = runtimeObservation(run, { pid: 42, pgid: 42, birthMarker: "b".repeat(500) }, { exitCode: 0, stderr: "private output" });
  assert.equal(unconfirmed.runId, "exact-run"); assert.equal(unconfirmed.fencingToken, 7);
  assert.equal(unconfirmed.origin, "not_established"); assert.equal(unconfirmed.terminalEventObserved, false);
  assert.deepEqual(unconfirmed.rootExit, { exitCode: 0 }); assert.equal(unconfirmed.process.birthMarker.length, 128);
  assert.equal(JSON.stringify(unconfirmed).includes("private output"), false);
  const observed = runtimeObservation({ ...run, observedProviderSessionGeneration: "provider-generation-2", observedProviderTerminalStatus: "completed" }, { pid: 43, pgid: 43, birthMarker: "exact" }, { signal: "SIGTERM" }, "explicit host teardown".repeat(20));
  assert.equal(observed.origin, "host_operation_observed"); assert.equal(observed.hostOperation.length, 160);
  assert.equal(observed.providerSessionGeneration, "provider-generation-2"); assert.equal(observed.terminalStatus, "completed");
  for (const terminalStatus of ["failed", "interrupted", "unknown"]) { const result = runtimeObservation({ ...run, observedProviderTerminalStatus: terminalStatus }); assert.equal(result.terminalEventObserved, true); assert.equal(result.terminalStatus, terminalStatus); assert.equal(result.origin, "not_established"); }
  const directory = mkdtempSync(join(tmpdir(), "runtime-evidence-")); let store = new AgentStore(directory);
  try {
    const p = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
    const a = store.createAgent(p.id, { title: "Synthetic", engine: "codex", conversationId: p.lastConversationId });
    store.appendEvent(a.id, { type: "agent_lifecycle", executionId: "exact-run", status: "failed", reason: "runtime_error", runtimeObservation: unconfirmed });
    store.close(); store = new AgentStore(directory);
    assert.deepEqual(store.readEvents(a.id).at(-1).event.runtimeObservation, unconfirmed);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
