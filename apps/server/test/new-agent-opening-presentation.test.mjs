import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "@ponderosa/agents";
import { createServer } from "../dist/app.js";

test("actual Chat HTTP presentation binds only the exact created opening, including replay, rename and reopening", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "opening-presentation-"));
  let store = new AgentStore(dataDir), app;
  const adapter = { id: "codex", displayName: "Synthetic", listModels: () => [], listEfforts: () => [] };
  const open = async () => {
    app = createServer({ dataDir, store, engines: [{ adapter, authStatus: async () => ({ authenticated: true }) }], logger: false, startDrained: true });
    await app.ready();
  };
  const close = async () => { app.prepareForShutdown(); await app.close(); store.close(); };
  try {
    const project = store.createProject({ label: "Synthetic", hostPath: dataDir, defaultEngine: "codex" });
    const chat = store.createConversation(project.id, { title: "Synthetic" });
    await open();
    const payload = { title: "Boston", engine: "codex", conversationId: chat.id, initialMessage: "#new-agent exact opening", idempotencyKey: "opening-once" };
    const create = () => app.inject({ method: "POST", url: `/api/projects/${project.id}/agents`, payload });
    const response = await create();
    assert.equal(response.statusCode, 200, response.body);
    const agent = response.json();
    const canonicalText = store.getCommunicationEvent(project.id, `agent-opening:${agent.id}`).text;
    assert.ok(canonicalText.endsWith(payload.initialMessage));
    const check = async (handle, title) => {
      const read = await app.inject(`/api/conversations/${chat.id}`);
      assert.equal(read.statusCode, 200, read.body);
      const messages = read.json().messages;
      const opening = messages.filter(message => message.communicationEventId === `agent-opening:${agent.id}`);
      assert.equal(opening.length, 1, "exact opening appears only once");
      assert.equal(opening[0].text, `#broadcast ${canonicalText}`, "existing scope presentation and content are unchanged");
      assert.deepEqual(opening[0].agentMentions?.filter(mention => mention.handle === "new-agent"), [{
        projectId: project.id, agentId: agent.id, handle: "new-agent", currentHandle: handle, currentTitle: title,
      }]);
      assert.equal(store.getCommunicationEvent(project.id, `agent-opening:${agent.id}`).text, canonicalText);
    };
    await check(agent.handle, agent.title);
    const replay = await create(); assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().id, agent.id);
    store.updateAgent(agent.id, { title: "Renamed Boston", handle: "Renamed-Boston" });
    await check("Renamed-Boston", "Renamed Boston");
    const broadcast = await app.inject({ method: "POST", url: `/api/conversations/${chat.id}/messages`, payload: { text: "#new-agent ordinary prose", idempotencyKey: "not-an-opening" } });
    assert.equal(broadcast.statusCode, 200, broadcast.body);
    assert.equal(broadcast.json().agentMentions?.some(mention => mention.handle === "new-agent"), undefined, "reserved text cannot invent opening authority");
    await close(); store = new AgentStore(dataDir); await open();
    await check("Renamed-Boston", "Renamed Boston");
  } finally {
    if (app) await close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
