import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import { createServerReadModels } from "../../dist/server-read-models.js";

/** Disposable persisted Communications through the production presentation DTO. */
export async function collaborationFixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "collaboration-presentation-"));
  const store = new AgentStore(dataDir);
  const workspace = new WorkspaceStore(dataDir);
  const coordinationV3 = new CoordinationV3Store(store.sqlite);
  const project = store.createProject({ label: "Disposable", hostPath: dataDir, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Team" });
  const cedar = store.createAgent(project.id, { title: "Cedar", engine: "codex", conversationId: chat.id });
  const boston = store.createAgent(project.id, { title: "Boston", engine: "codex", conversationId: chat.id });
  const juniper = store.createAgent(project.id, { title: "Juniper", engine: "codex", conversationId: chat.id });
  const readModels = createServerReadModels({ store, workspace, coordinationV3,
    managementPlans: new Map(), activeRuns: new Map(), scheduledSessionRollovers: new Map(),
    runtimeStallAfterMs: 60_000, reusableRuntime: () => undefined, transitionRun: () => false,
    appendWorkspace: () => {}, publish: () => {}, reconcileCommunicationNotifications: () => {},
    reconcileCoordinationAttentionNotifications: () => {}, isClosed: () => false });
  const events = [
    { text: "Investigation complete.", recipients: [boston] },
    { text: "#issue investigation complete", recipients: [boston] },
    { text: `#${boston.handle} Group result.`, recipients: [boston, juniper] },
  ].map((item, index) => {
    const event = { schemaVersion: 2, eventId: `fixture-${index}`, projectId: project.id, conversationId: chat.id,
      sender: { kind: "agent", agentId: cedar.id }, intent: "collaboration",
      audience: { kind: "agents", agentIds: item.recipients.map(agent => agent.id) }, text: item.text,
      identity: { senderLabel: cedar.title,
        recipientLabels: Object.fromEntries(item.recipients.map(agent => [agent.id, agent.title])),
        recipientHandles: Object.fromEntries(item.recipients.map(agent => [agent.id, agent.handle])) },
      createdAt: `2026-10-03T01:00:0${index}Z` };
    store.appendCommunicationEvent(event);
    return event;
  });
  const messages = () => readModels.withMessagePresentation(project.id, events.map(event => ({
    id: event.eventId, communicationEventId: event.eventId, conversationId: chat.id,
    role: "assistant", authorAgentId: cedar.id, text: event.text, createdAt: event.createdAt,
  })));
  const authority = () => Object.fromEntries(["agent_activations", "coordination_requests", "coordination_joins", "provider_inputs"]
    .map(table => [table, store.sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]));
  return { store, workspace, coordinationV3, readModels, project, chat, cedar, boston, juniper, events, messages, authority,
    async close() { store.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const fixture = await collaborationFixture();
  try {
    const before = fixture.authority();
    const messages = fixture.messages();
    const result = { projectId: fixture.project.id, chatId: fixture.chat.id,
      agents: [fixture.cedar, fixture.boston, fixture.juniper].map(({ id, title, handle }) => ({ id, title, handle })),
      messages, before, after: fixture.authority() };
    await writeFile(process.argv[2], JSON.stringify(result));
    console.log(JSON.stringify({ before, after: result.after, unknownBinding: messages[1].agentMentions }));
  } finally { await fixture.close(); }
}
