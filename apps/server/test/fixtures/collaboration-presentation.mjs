import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import { createServerReadModels } from "../../dist/server-read-models.js";
import Fastify from "fastify";
import { registerSearchRoutes } from "../../dist/routes/search.js";

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
    store.appendCommunicationProjection(project.id, { eventId: event.eventId, surface: "collaboration_view", projectionKey: chat.id,
      projectedAt: event.createdAt, message: { messageId: event.eventId, role: "assistant", createdAt: event.createdAt,
        authorAgentId: cedar.id, renderedText: `#${item.recipients.map(a => a.handle).join(" #")} ${event.text}` } });
    return event;
  });
  const messages = () => readModels.withMessagePresentation(project.id, store.readProjectedCommunicationMessages(project.id, "collaboration_view", chat.id).map(message => ({
    id: message.messageId, communicationEventId: message.eventId, conversationId: chat.id,
    role: message.role, authorAgentId: message.authorAgentId, text: message.text, createdAt: message.createdAt,
  })));
  const authority = () => Object.fromEntries(["agent_activations", "coordination_requests", "coordination_joins", "provider_inputs"]
    .map(table => [table, store.sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]));
  async function allPage() {
    const event = { ...events[0], eventId: "fixture-operator", sender: { kind: "user", userId: "local-operator" },
      text: "Operator collaboration.", audience: { kind: "agents", agentIds: [boston.id, juniper.id] },
      identity: { senderLabel: "Operator", recipientLabels: { [boston.id]: boston.title, [juniper.id]: juniper.title },
        recipientHandles: { [boston.id]: boston.handle, [juniper.id]: juniper.handle } } };
    store.appendCommunicationEvent(event);
    store.appendCommunicationProjection(project.id, { eventId: event.eventId, surface: "collaboration_view", projectionKey: chat.id,
      projectedAt: event.createdAt, message: { messageId: event.eventId, role: "user", createdAt: event.createdAt } });
    const app = Fastify();
    try {
      registerSearchRoutes(app, { store, workspace, coordinationV3, globalChatSearch: () => ({ items: [] }) });
      const response = await app.inject({ url: "/api/all-chat" });
      if (response.statusCode !== 200) throw Error(response.body);
      return response.json();
    } finally { await app.close(); }
  }
  return { store, workspace, coordinationV3, readModels, project, chat, cedar, boston, juniper, events, messages, authority, allPage,
    async close() { store.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const fixture = await collaborationFixture();
  try {
    const before = fixture.authority();
    const messages = fixture.messages();
    const result = { projectId: fixture.project.id, chatId: fixture.chat.id,
      agents: [fixture.cedar, fixture.boston, fixture.juniper].map(({ id, title, handle }) => ({ id, title, handle })),
      messages, allPage: process.argv.includes("--include-all") ? await fixture.allPage() : undefined,
      before, after: fixture.authority() };
    await writeFile(process.argv[2], JSON.stringify(result));
    console.log(JSON.stringify({ before, after: result.after, unknownBinding: messages[1].agentMentions }));
  } finally { await fixture.close(); }
}
