import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "@ponderosa/agents";
import type { CommunicationEvent, TeamDirectoryDto } from "@ponderosa/core";
import type { ActiveRun, AgentMessageCapability } from "../src/app-contracts.js";
import { registerAgentDirectoryRoutes } from "../src/routes/agent-directory.js";

describe("Agent context scopes", () => {
  const roots: string[] = [];
  const stores: AgentStore[] = [];

  afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("returns cross-chat Direct history with provenance while current_chat stays local", async () => {
    const root = mkdtempSync(join(tmpdir(), "ponderosa-agent-context-"));
    roots.push(root);
    const store = new AgentStore(root);
    stores.push(store);
    const project = store.createProject({ label: "Multi Chat", hostPath: "/multi-chat" });
    const home = store.createConversation(project.id, { title: "Home" });
    const blue = store.createConversation(project.id, { title: "Channel Blue" });
    const agent = store.createAgent(project.id, { title: "Probe", engine: "codex", conversationId: home.id });
    store.updateAgentConversationMemberships(agent.id, {
      conversationIds: [home.id, blue.id],
      primaryConversationId: home.id,
    });
    const event: CommunicationEvent = {
      eventId: "blue-albatross",
      schemaVersion: 2,
      projectId: project.id,
      conversationId: blue.id,
      sender: { kind: "agent", agentId: agent.id },
      intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
      text: "Remember BLUE-ALBATROSS",
      identity: {
        senderLabel: "Probe",
        recipientLabels: { [agent.id]: "Probe" },
        conversationLabel: "Channel Blue",
      },
      createdAt: "2026-08-01T12:00:00.000Z",
    };
    store.appendCommunicationEvent(event);
    store.appendEvent(agent.id, {
      type: "user_message",
      text: event.text,
      communicationEventId: event.eventId,
    });
    store.updateAgent(agent.id, { title: "Renamed Probe" });
    store.updateConversation(blue.id, { title: "Renamed Blue" });

    const token = "agent-context-token";
    const capability: AgentMessageCapability = {
      agentId: agent.id,
      conversationId: home.id,
      runId: "run-home",
      v3SchedulerRunId: "scheduler-run-home",
      v3FencingToken: 1,
      mentionDepth: 0,
      mentionTrail: [],
      reachableArtifactIds: [],
      availableToolNames: ["ponderosa_context"],
    };
    const active = { messageCapability: token } as ActiveRun;
    const app = Fastify();
    registerAgentDirectoryRoutes(app, {
      store,
      agentMessageCapabilities: new Map([[token, capability]]),
      activeRuns: new Map([[agent.id, active]]),
      capabilityOwnsAuthoritativeRun: () => true,
      teamDirectory: () => ({ agents: [] }) as unknown as TeamDirectoryDto,
    });

    const local = await app.inject({
      method: "GET",
      url: "/api/agent-context?scope=current_chat",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toMatchObject({
      scope: { kind: "project_chat", conversationId: home.id },
      messages: [],
    });

    const privateHistory = await app.inject({
      method: "GET",
      url: "/api/agent-context?scope=agent_private",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(privateHistory.statusCode).toBe(200);
    expect(privateHistory.json()).toMatchObject({
      scope: { kind: "agent_private", agentId: agent.id },
      messages: [{
        communicationEventId: event.eventId,
        text: event.text,
        provenance: {
          communicationEventId: event.eventId,
          originConversationId: blue.id,
          originConversationTitle: blue.title,
          timestamp: event.createdAt,
          author: { kind: "agent", id: agent.id, displayName: "Probe" },
          communicationType: "user_dm",
        },
      }],
    });
    capability.availableToolNames = [];
    const unavailable = await app.inject({
      method: "GET",
      url: "/api/agent-context?scope=agent_private",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unavailable.statusCode).toBe(403);
    expect(unavailable.json()).toEqual({ error: "older scoped context is unavailable for this Run" });
    await app.close();
  });
});
