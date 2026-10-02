import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { mapCodexAppServerNotification } from "@ponderosa/engines";
import { providerEventStream } from "../dist/provider-session-facade.js";
import { createServer } from "../dist/app.js";

const terminal = status => mapCodexAppServerNotification({
  method: "turn/completed", params: { turn: { id: "synthetic-turn", status } },
}, process.cwd());

for (const status of ["failed", "interrupted", "unknown"]) {
  test(`strict provider stream preserves observed ${status} while sanitizing private failure text`, async () => {
    async function* source() { yield { ...terminal(status)[0], message: "private provider diagnostic" }; }
    const events = [];
    for await (const event of providerEventStream(source())) events.push(event);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.equal(events[0].terminalStatus, status);
    assert.equal(events[0].message, "Provider execution failed.");
    assert.equal(JSON.stringify(events).includes("private provider diagnostic"), false);
  });

  test(`adapter ${status} survives the stream and persists on the exact failed Run lifecycle`, { timeout: 10000 }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "provider-terminal-")));
    const store = new AgentStore(directory);
    const coordination = new CoordinationV3Store(store.sqlite);
    const project = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
    const chat = store.createConversation(project.id, { title: "Synthetic" });
    const agent = store.createAgent(project.id, { title: "Synthetic", engine: "codex", conversationId: chat.id });
    let launches = 0;
    const adapter = {
      id: "codex", displayName: "Synthetic", trustedSystemPromptChannel: "developer",
      listModels: () => [], listEfforts: () => [],
      seed: async function* () {
        launches++;
        yield { type: "session", sessionId: "synthetic-session" };
        yield* terminal(status);
      },
    };
    const app = createServer({ dataDir: directory, store, engines: [{ adapter }], logger: false,
      startDrained: true, communicationV3: { pollMs: 10 } });
    let runId, expectedObservation;
    try {
      await app.ready();
      coordination.coordinate({ projectId: project.id, conversationId: chat.id,
        actorScope: "user:local-operator", idempotencyKey: "exact-opening",
        requests: [{ requestId: "exact-parent", recipientAgentId: agent.id,
          lifetime: { kind: "indefinite" }, payload: {} }] });
      assert.equal((await app.inject({ method: "POST", url: "/api/deployment/resume" })).statusCode, 200);
      let lifecycle;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        lifecycle = store.readEvents(agent.id).find(row => row.event.type === "agent_lifecycle" && row.event.status === "failed");
        if (lifecycle) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(lifecycle, "the controlled adapter must reach a persisted failed lifecycle");
      runId = lifecycle.event.executionId;
      const run = store.sqlite.prepare("SELECT status,fencing_token FROM scheduler_runs WHERE id=? AND agent_id=?").get(runId, agent.id);
      assert.ok(run);
      // The existing failure authority keeps unconfirmed injected work fenced.
      // Observed provider evidence must not change that canonical outcome.
      assert.equal(run.status, "outcome_unknown");
      const observation = lifecycle.event.runtimeObservation;
      assert.equal(observation.runId, runId);
      assert.equal(observation.terminalEventObserved, true);
      assert.equal(observation.terminalStatus, status);
      assert.equal(observation.origin, "not_established");
      assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?").get(agent.id).n, 1);
      assert.equal(launches, 1);
      assert.notEqual(coordination.getRequest("exact-parent").state, "completed");
      assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM coordination_request_updates WHERE request_id='exact-parent' AND kind='completed'").get().n, 0);
      expectedObservation = observation;
    } finally {
      app.prepareForShutdown(); await app.close(); store.close();
      try {
        if (expectedObservation) {
          const reopened = new AgentStore(directory);
          try {
            const lifecycle = reopened.readEvents(agent.id).find(row => row.event.type === "agent_lifecycle" && row.event.executionId === runId && row.event.status === "failed");
            assert.deepEqual(lifecycle.event.runtimeObservation, expectedObservation);
          } finally { reopened.close(); }
        }
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
}

test("invalid terminal enums cannot pass the strict provider stream", async () => {
  for (const terminalStatus of ["completed", "anything", 1, null]) {
    async function* source() { yield { type: "error", message: "private", terminalStatus }; }
    await assert.rejects(async () => { for await (const _event of providerEventStream(source())) {} });
  }
});

test("failure prose alone does not invent terminal evidence", async () => {
  async function* source() { yield { type: "error", message: "the provider was interrupted" }; }
  for await (const event of providerEventStream(source())) assert.equal(event.terminalStatus, undefined);
});
