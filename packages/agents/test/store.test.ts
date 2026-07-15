import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentStore } from "../src/store.js";
import type { CommunicationEvent } from "@ponderosa/core";
import type { LogEvent } from "../src/log-event.js";
import { artifactContentPath, communicationEventsPath, communicationProjectionsPath, messageDispatchesPath, projectDir, projectJsonPath, runTriggersPath } from "../src/paths.js";

let dir: string;
let store: AgentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pond-store-"));
  store = new AgentStore(dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Read every projection table as plain sorted rows (for equality snapshots). */
function snapshot(s: AgentStore): Record<string, unknown[]> {
  const db = s.sqlite;
  const tables = [
    "projects",
    "agent_presets",
    "conversations",
    "agent_conversation_memberships",
    "agents",
    "messages",
    "runs",
    "work_items",
    "artifacts",
    "events",
  ];
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const order = t === "agent_conversation_memberships"
      ? "agent_id, position"
      : t === "runs"
        ? "agent_id, id"
        : "id";
    const rows = db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all() as unknown[];
    out[t] = rows;
  }
  return out;
}

function seedAgent(): { projectId: string; agentId: string } {
  const project = store.createProject({ label: "Demo", hostPath: "/repo" });
  const agent = store.createAgent(project.id, { title: "Auth", engine: "codex" });
  return { projectId: project.id, agentId: agent.id };
}

function appendCanonicalConversationMessage(
  conversationId: string,
  input: Parameters<AgentStore["appendConversationMessage"]>[1],
  authorAgentId?: string,
  channel: Parameters<AgentStore["appendConversationMessage"]>[3] = "main",
  deliveryIntents?: Parameters<AgentStore["appendConversationMessage"]>[4],
  messageReceiptKey?: string,
) {
  const conversation = store.getConversation(conversationId)!;
  const eventId = `test-message-${Math.random().toString(36).slice(2)}`;
  const recipientIds = [...new Set((deliveryIntents ?? []).map((intent) => intent.targetAgentId))];
  const event: CommunicationEvent = channel === "collaboration"
    ? {
        eventId, schemaVersion: 2, projectId: conversation.projectId, conversationId,
        sender: authorAgentId ? { kind: "agent", agentId: authorAgentId } : { kind: "user", userId: "local-operator" },
        intent: "collaboration", audience: { kind: "agents", agentIds: recipientIds as [string, ...string[]] },
        text: input.text, createdAt: new Date().toISOString(),
      }
    : deliveryIntents?.length
      ? {
          eventId, schemaVersion: 2, projectId: conversation.projectId, conversationId,
          sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
          audience: recipientIds.length === 1
            ? { kind: "user_agent", userId: "local-operator", agentId: recipientIds[0]! }
            : { kind: "user_agents", userId: "local-operator", agentIds: recipientIds as [string, ...string[]] },
          text: input.text, createdAt: new Date().toISOString(),
        }
      : {
          eventId, schemaVersion: 1, projectId: conversation.projectId, conversationId,
          sender: authorAgentId ? { kind: "agent", agentId: authorAgentId } : { kind: "user", userId: "local-operator" },
          intent: "broadcast", audience: { kind: "organization", organizationId: conversation.projectId },
          text: input.text, createdAt: new Date().toISOString(),
        };
  store.appendCommunicationEvent(event);
  return store.appendConversationMessage(
    conversationId, input, authorAgentId, channel, deliveryIntents, messageReceiptKey, eventId,
  );
}

describe("AgentStore — V1 layout", () => {
  it("drops pre-V1 identity and Task-era state while preserving managed source workspaces", () => {
    const legacyDir = join(dir, "legacy-state");
    const workspaceFile = join(legacyDir, "workspaces", "demo", "README.md");
    const legacyAgentFile = join(legacyDir, "projects", "project-old", "threads", "thread-old", "thread.json");
    mkdirSync(join(legacyDir, "workspaces", "demo"), { recursive: true });
    mkdirSync(join(legacyDir, "projects", "project-old", "threads", "thread-old"), { recursive: true });
    writeFileSync(workspaceFile, "# Keep me\n", "utf8");
    writeFileSync(legacyAgentFile, "{}\n", "utf8");
    const legacyDb = new Database(join(legacyDir, "ponderosa.db"));
    legacyDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY)");
    legacyDb.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
    legacyDb.close();

    const migrated = new AgentStore(legacyDir);
    try {
      expect(readFileSync(workspaceFile, "utf8")).toBe("# Keep me\n");
      expect(existsSync(legacyAgentFile)).toBe(false);
      expect(migrated.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'").get())
        .toEqual({ name: "agents" });
      expect(migrated.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'").get())
        .toBeUndefined();
      expect(migrated.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get())
        .toBeUndefined();
      expect(migrated.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get())
        .toEqual({ name: "runs" });
    } finally {
      migrated.close();
    }
  });
});

describe("AgentStore — canonical communication events", () => {
  it("keeps long-form documents canonical, scoped, and out of projected summary text", () => {
    const project = store.createProject({ label: "Docs", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: room.id });
    const recipient = store.createAgent(project.id, { title: "Recipient", engine: "codex", conversationId: room.id });
    const event: CommunicationEvent = {
      eventId: "doc-event", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "agent", agentId: author.id, executionId: "run-1" },
      intent: "collaboration", audience: { kind: "agents", agentIds: [recipient.id] },
      text: "Concise review summary", createdAt: "2026-07-12T00:00:00.000Z",
      document: { id: "doc-1", title: "Architecture Review", mediaType: "text/markdown", content: "# Full review\n\nPrivate detail.", byteLength: 30, authorAgentId: author.id, executionId: "run-1", createdAt: "2026-07-12T00:00:00.000Z" },
    };
    event.document!.byteLength = Buffer.byteLength(event.document!.content, "utf8");
    store.appendCommunicationEvent(event);
    store.appendCommunicationProjection(project.id, { eventId: event.eventId, surface: "collaboration_view", projectionKey: room.id, projectedAt: event.createdAt, message: { messageId: "m1", role: "assistant", createdAt: event.createdAt, authorAgentId: author.id } });
    const message = store.readProjectedCommunicationMessages(project.id, "collaboration_view", room.id)[0]!;
    expect(message.text).toBe("Concise review summary");
    expect(message.document).toMatchObject({ id: "doc-1", title: "Architecture Review", previewUrl: expect.any(String) });
    expect(message.document).not.toHaveProperty("content");
    expect(store.getCommunicationDocument(project.id, "doc-1")?.document.content).toContain("Private detail");
    expect(store.readContextClassifications(project.id)).toEqual([expect.objectContaining({ eventId: "doc-event", policy: "local_only" })]);
  });

  it("persists one fsynced project event and makes exact retries idempotent", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const event: CommunicationEvent = {
      eventId: "018f5f17-7c22-7b00-8000-000000000001",
      schemaVersion: 1,
      projectId: project.id,
      sender: { kind: "agent", agentId: "agent-a", executionId: "run-a" },
      intent: "collaboration",
      audience: { kind: "agents", agentIds: ["agent-b"] },
      text: "Review the routing contract.",
      createdAt: "2026-07-12T00:00:00.000Z",
      idempotencyKey: "review-routing",
    };

    expect(store.appendCommunicationEvent(event).replayed).toBe(false);
    expect(store.appendCommunicationEvent(event)).toEqual({ event, replayed: true });
    expect(store.appendCommunicationEvent({ ...event, eventId: "transport-retry", createdAt: "2026-07-12T00:00:01.000Z" }))
      .toEqual({ event, replayed: true });
    expect(store.readCommunicationEvents(project.id)).toEqual([event]);
    expect(store.readContextClassifications(project.id)).toEqual([expect.objectContaining({
      eventId: event.eventId, policy: "local_only",
    })]);
    expect(readFileSync(communicationEventsPath(dir, project.id), "utf8").trim().split("\n")).toHaveLength(1);
    expect(() => store.appendCommunicationEvent({ ...event, text: "Collision" })).toThrow("collision");
  });

  it("rejects unknown projects and runtime-empty collaboration audiences", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const base = {
      eventId: "event-1", schemaVersion: 1 as const, projectId: project.id,
      sender: { kind: "system" as const, component: "test" }, text: "Message",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    expect(() => store.appendCommunicationEvent({
      ...base, projectId: "missing", intent: "broadcast",
      audience: { kind: "organization", organizationId: "missing" },
    })).toThrow("project not found");
    expect(() => store.appendCommunicationEvent({
      ...base, intent: "collaboration",
      audience: { kind: "agents", agentIds: [] },
    } as unknown as CommunicationEvent)).toThrow("at least one recipient");
  });

  it("normalizes V2 collaboration recipients before persistence and idempotency comparison", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const sender = store.createAgent(project.id, { title: "Sender", engine: "codex", conversationId: room.id });
    const a = store.createAgent(project.id, { title: "A", engine: "codex", conversationId: room.id });
    const b = store.createAgent(project.id, { title: "B", engine: "codex", conversationId: room.id });
    const event: CommunicationEvent = {
      eventId: "normalized", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "agent", agentId: sender.id }, intent: "collaboration",
      audience: { kind: "agents", agentIds: [b.id, a.id, b.id] }, text: "Review",
      createdAt: "2026-07-12T00:00:00.000Z", idempotencyKey: "same-audience",
    };
    const first = store.appendCommunicationEvent(event).event;
    expect(first.intent === "collaboration" && first.audience.agentIds).toEqual([a.id, b.id].sort());
    expect(store.appendCommunicationEvent({ ...event, eventId: "retry", audience: { kind: "agents", agentIds: [a.id, b.id] } }).event.eventId)
      .toBe(first.eventId);
  });

  it("validates V2 audiences and enforces scope-to-surface placement", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const otherProject = store.createProject({ label: "Other", hostPath: "/other" });
    const room = store.createConversation(project.id, { title: "Room" });
    const otherRoom = store.createConversation(project.id, { title: "Other room" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: room.id });
    const foreign = store.createAgent(otherProject.id, { title: "Foreign", engine: "codex" });
    const dm: CommunicationEvent = {
      eventId: "dm", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
      text: "Private", createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(dm);
    expect(() => store.appendCommunicationProjection(project.id, {
      eventId: dm.eventId, surface: "collaboration_view", projectionKey: room.id, projectedAt: dm.createdAt,
    })).toThrow("scope cannot project");
    expect(() => store.appendCommunicationProjection(project.id, {
      eventId: dm.eventId, surface: "conversation", projectionKey: otherRoom.id, projectedAt: dm.createdAt,
    })).toThrow("scope cannot project");
    expect(() => store.appendCommunicationProjection(project.id, {
      eventId: dm.eventId, surface: "user_inbox", projectionKey: "another-user", projectedAt: dm.createdAt,
    })).toThrow("scope cannot project");
    expect(() => store.appendConversationMessage(
      room.id,
      { role: "user", text: dm.text },
      undefined,
      "collaboration",
      undefined,
      undefined,
      dm.eventId,
    )).toThrow("scope cannot project");
    expect(store.getConversationMessages(room.id, "collaboration")).toEqual([]);
    expect(existsSync(messageDispatchesPath(dir, project.id))).toBe(false);
    expect(() => store.appendCommunicationEvent({ ...dm, eventId: "unknown", audience: { ...dm.audience, agentId: "missing" } })).toThrow("active agent");
    expect(() => store.appendCommunicationEvent({ ...dm, eventId: "foreign", audience: { ...dm.audience, agentId: foreign.id } })).toThrow("active agent");
    expect(() => store.appendCommunicationEvent({ ...dm, eventId: "wrong-room", conversationId: otherRoom.id })).toThrow("belong to its conversation");
    store.updateAgent(agent.id, { archived: true });
    expect(() => store.appendCommunicationEvent({ ...dm, eventId: "archived" })).toThrow("active agent");
  });

  it("projects one bidirectional User DM identity into Main and Direct Agent timelines", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: room.id });
    const userDm: CommunicationEvent = {
      eventId: "user-to-agent", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
      text: "Please investigate", createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(userDm);
    store.appendConversationMessage(room.id, { role: "user", text: userDm.text }, undefined, "main", undefined, undefined, userDm.eventId);
    store.appendEvent(agent.id, { type: "user_message", text: userDm.text, communicationEventId: userDm.eventId });

    const agentDm: CommunicationEvent = {
      ...userDm, eventId: "agent-to-user", sender: { kind: "agent", agentId: agent.id },
      text: "Investigation complete", createdAt: "2026-07-12T00:01:00.000Z",
    };
    store.appendCommunicationEvent(agentDm);
    store.appendConversationMessage(room.id, { role: "assistant", text: agentDm.text }, agent.id, "main", undefined, undefined, agentDm.eventId);
    store.appendEvent(agent.id, { type: "communication_projection", text: agentDm.text, communicationEventId: agentDm.eventId });

    expect(store.readProjectedCommunicationMessages(project.id, "conversation", room.id).map((message) => message.eventId))
      .toEqual([userDm.eventId, agentDm.eventId]);
    expect(store.readProjectedCommunicationMessages(project.id, "direct_agent_audit", agent.id).map((message) => message.eventId))
      .toEqual([userDm.eventId, agentDm.eventId]);
    expect(store.readContextClassifications(project.id)).toEqual([
      expect.objectContaining({ eventId: userDm.eventId, policy: "local_only" }),
      expect.objectContaining({ eventId: agentDm.eventId, policy: "local_only" }),
    ]);
  });

  it("projects one user-authored group DM into each explicit agent audit", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const first = store.createAgent(project.id, { title: "First", engine: "codex", conversationId: room.id });
    const second = store.createAgent(project.id, { title: "Second", engine: "codex", conversationId: room.id });
    const groupDm: CommunicationEvent = {
      eventId: "group-dm", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agents", userId: "local-operator", agentIds: [second.id, first.id, second.id] },
      text: "One message", createdAt: "2026-07-12T00:00:00.000Z",
    };
    const recorded = store.appendCommunicationEvent(groupDm).event;
    expect(recorded.intent === "user_dm" && recorded.audience.kind === "user_agents" && recorded.audience.agentIds)
      .toEqual([first.id, second.id].sort());
    store.appendConversationMessage(room.id, { role: "user", text: groupDm.text }, undefined, "main", undefined, undefined, groupDm.eventId);
    store.appendEvent(first.id, { type: "user_message", text: groupDm.text, communicationEventId: groupDm.eventId });
    store.appendEvent(second.id, { type: "user_message", text: groupDm.text, communicationEventId: groupDm.eventId });
    expect(store.readProjectedCommunicationMessages(project.id, "conversation", room.id).map((message) => message.eventId)).toEqual([groupDm.eventId]);
    expect(store.readProjectedCommunicationMessages(project.id, "direct_agent_audit", first.id).map((message) => message.eventId)).toEqual([groupDm.eventId]);
    expect(store.readProjectedCommunicationMessages(project.id, "direct_agent_audit", second.id).map((message) => message.eventId)).toEqual([groupDm.eventId]);
    expect(() => store.appendCommunicationEvent({ ...groupDm, eventId: "agent-group", sender: { kind: "agent", agentId: first.id } }))
      .toThrow("target agent");
  });

  it("uses a durable RunTrigger—not message text—to link a Project request to its responsible agent", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const responsible = store.createAgent(project.id, { title: "Responsible", engine: "codex", conversationId: room.id });
    const other = store.createAgent(project.id, { title: "Other", engine: "codex", conversationId: room.id });
    const request: CommunicationEvent = {
      eventId: "project-request", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id }, text: "#Other fix the build",
      createdAt: "2026-07-13T00:00:00.000Z",
    };
    store.appendCommunicationEvent(request);

    expect(() => store.appendEvent(responsible.id, {
      type: "user_message", text: request.text, communicationEventId: request.eventId,
    })).toThrow("scope cannot project");
    const first = store.recordRunTrigger(project.id, request.eventId, responsible.id, request.createdAt);
    expect(first).toMatchObject({ replayed: false, trigger: { source: "project_request", agentId: responsible.id } });
    expect(store.recordRunTrigger(project.id, request.eventId, responsible.id, "later")).toEqual({
      trigger: first.trigger,
      replayed: true,
    });
    store.appendEvent(responsible.id, { type: "user_message", text: request.text, communicationEventId: request.eventId });
    expect(store.getProjectedAgentMessages(responsible.id)).toHaveLength(1);
    expect(store.getProjectedAgentMessages(other.id)).toHaveLength(0);
    expect(readFileSync(runTriggersPath(dir, project.id), "utf8").trim().split("\n")).toHaveLength(1);

    const { event: direct } = store.appendCommunicationEvent({
      eventId: "direct-trigger", schemaVersion: 2, projectId: project.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: responsible.id },
      text: "Follow up", createdAt: "2026-07-13T00:01:00.000Z",
    });
    const batch = store.recordRunTriggers(project.id, [request.eventId, direct.eventId], responsible.id, direct.createdAt);
    expect(batch).toEqual([
      { trigger: first.trigger, replayed: true },
      { trigger: expect.objectContaining({ communicationEventId: direct.eventId, source: "direct_message" }), replayed: false },
    ]);
    expect(readFileSync(runTriggersPath(dir, project.id), "utf8").trim().split("\n")).toHaveLength(2);

    store.close();
    store = new AgentStore(dir);
    expect(store.readRunTriggers(project.id, responsible.id)).toEqual([first.trigger, batch[1]!.trigger]);
    expect(store.hasRunTrigger(project.id, request.eventId, responsible.id)).toBe(true);
  });

  it("preserves an agent collaborator as the visible author in the recipient audit", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const child = store.createAgent(project.id, { title: "Child", engine: "codex", conversationId: room.id });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: room.id });
    const report: CommunicationEvent = {
      eventId: "child-report", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "agent", agentId: child.id }, intent: "collaboration",
      audience: { kind: "agents", agentIds: [manager.id] }, text: "Private finding",
      createdAt: "2026-07-13T00:00:00.000Z",
    };
    store.appendCommunicationEvent(report);
    store.appendConversationMessage(room.id, { role: "assistant", text: report.text }, child.id, "collaboration", undefined, undefined, report.eventId);
    store.appendEvent(child.id, { type: "communication_projection", text: report.text, communicationEventId: report.eventId });
    store.appendEvent(manager.id, { type: "user_message", text: report.text, communicationEventId: report.eventId });

    expect(store.getProjectedAgentMessages(manager.id)).toEqual([
      expect.objectContaining({
        communicationEventId: report.eventId,
        role: "assistant",
        authorAgentId: child.id,
        text: report.text,
      }),
    ]);
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({ ok: true });
  });

  it("rejects self-recipient collaboration before writing the canonical ledger", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const sender = store.createAgent(project.id, { title: "Sender", engine: "codex", conversationId: room.id });
    expect(() => store.appendCommunicationEvent({
      eventId: "self", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "agent", agentId: sender.id }, intent: "collaboration",
      audience: { kind: "agents", agentIds: [sender.id] }, text: "Loopback",
      createdAt: "2026-07-12T00:00:00.000Z",
    })).toThrow("cannot target its sender");
    expect(store.readCommunicationEvents(project.id)).toEqual([]);
  });

  it("rejects invalid V2 agent collaboration senders without writing canonical state", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const otherProject = store.createProject({ label: "Other", hostPath: "/other" });
    const room = store.createConversation(project.id, { title: "Room" });
    const otherRoom = store.createConversation(project.id, { title: "Other room" });
    const recipient = store.createAgent(project.id, { title: "Recipient", engine: "codex", conversationId: room.id });
    const wrongRoom = store.createAgent(project.id, { title: "Wrong room", engine: "codex", conversationId: otherRoom.id });
    const archived = store.createAgent(project.id, { title: "Archived", engine: "codex", conversationId: room.id });
    const foreign = store.createAgent(otherProject.id, { title: "Foreign", engine: "codex" });
    store.updateAgent(archived.id, { archived: true });
    const before = () => ({
      events: store.readCommunicationEvents(project.id),
      context: store.readContextClassifications(project.id),
      projections: store.readCommunicationProjections(project.id),
    });
    const initial = before();
    const send = (sender: CommunicationEvent["sender"], eventId: string) => () => store.appendCommunicationEvent({
      eventId, schemaVersion: 2, projectId: project.id, conversationId: room.id, sender,
      intent: "collaboration", audience: { kind: "agents", agentIds: [recipient.id] },
      text: "Review", createdAt: "2026-07-12T00:00:00.000Z",
    });
    expect(send({ kind: "agent", agentId: "missing" }, "missing")).toThrow("active agent");
    expect(send({ kind: "agent", agentId: archived.id }, "archived")).toThrow("active agent");
    expect(send({ kind: "agent", agentId: foreign.id }, "foreign")).toThrow("active agent");
    expect(send({ kind: "agent", agentId: wrongRoom.id }, "wrong-room")).toThrow("belong to its conversation");
    expect(before()).toEqual(initial);
  });

  it("repairs a torn tail before appending and rejects interior corruption", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const file = communicationEventsPath(dir, project.id);
    const event: CommunicationEvent = {
      eventId: "event-1", schemaVersion: 1, projectId: project.id,
      sender: { kind: "system", component: "test" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
      text: "First", createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(event);
    store.close();
    writeFileSync(file, `${readFileSync(file, "utf8")}{\"eventId\":\"torn`, "utf8");
    store = new AgentStore(dir);
    store.appendCommunicationEvent({ ...event, eventId: "event-2", text: "Second" });
    expect(store.readCommunicationEvents(project.id).map((item) => item.eventId)).toEqual(["event-1", "event-2"]);

    const valid = readFileSync(file, "utf8");
    store.close();
    writeFileSync(file, `{not-json}\n${JSON.stringify(event)}\n`, "utf8");
    expect(() => new AgentStore(dir)).toThrow("non-tail corruption");
    writeFileSync(file, valid, "utf8");
    store = new AgentStore(dir);
  });

  it("reconciles and rebuilds a direct-agent projection by canonical event ID", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex" });
    const event: CommunicationEvent = {
      eventId: "event-direct", schemaVersion: 1, projectId: project.id,
      sender: { kind: "agent", agentId: agent.id }, intent: "direct_to_user",
      audience: { kind: "user", userId: "local-operator" }, text: "Audit note",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(event);
    store.appendEvent(agent.id, { type: "communication_projection", communicationEventId: event.eventId, text: event.text });
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({ ok: true, canonicalEvents: 1, linkedProjections: 2 });
    expect(store.getMessages(agent.id)[0]).toMatchObject({ communicationEventId: event.eventId, text: event.text });

    store.rebuildProjections();
    expect(store.getMessages(agent.id)[0]).toMatchObject({ communicationEventId: event.eventId, text: event.text });
    expect(store.reconcileCommunicationEvents(project.id).ok).toBe(true);
  });

  it("keeps a communication event's scope immutable", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const event: CommunicationEvent = {
      eventId: "event-local", schemaVersion: 1, projectId: project.id,
      sender: { kind: "agent", agentId: "agent-a" }, intent: "direct_to_user",
      audience: { kind: "user", userId: "local-operator" }, text: "Local finding",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(event);
    expect(() => store.appendCommunicationEvent({
      ...event,
      intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
    })).toThrow("communication event ID collision");
    expect(store.readCommunicationEvents(project.id)).toEqual([event]);
    expect(store.readContextClassifications(project.id)).toEqual([
      expect.objectContaining({ eventId: event.eventId, policy: "local_only" }),
    ]);
  });

  it("accepts one event on multiple surfaces while deduplicating each projection tuple", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: room.id });
    const event: CommunicationEvent = {
      eventId: "event-multi", schemaVersion: 1, projectId: project.id, conversationId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "collaboration",
      audience: { kind: "agents", agentIds: [agent.id] }, text: "Review",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(event);
    store.appendConversationMessage(room.id, { text: event.text }, undefined, "collaboration", undefined, undefined, event.eventId);
    store.appendEvent(agent.id, { type: "user_message", text: event.text, communicationEventId: event.eventId });
    expect(store.appendCommunicationProjection(project.id, {
      eventId: event.eventId, surface: "direct_agent_audit", projectionKey: agent.id,
      projectedAt: "later retry timestamp",
    }).replayed).toBe(true);
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      canonicalEvents: 1, linkedProjections: 3, duplicateProjectionEventIds: [], ok: true,
    });
    expect(store.readProjectedCommunicationMessages(project.id, "collaboration_view", room.id))
      .toEqual([expect.objectContaining({ eventId: event.eventId, text: event.text, role: "user" })]);
    expect(store.readProjectedCommunicationMessages(project.id, "direct_agent_audit", agent.id))
      .toEqual([expect.objectContaining({ eventId: event.eventId, text: event.text, role: "user" })]);
  });

  it("append-only enriches placement-only migration records for authoritative reads", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const event: CommunicationEvent = {
      eventId: "event-enrich", schemaVersion: 1, projectId: project.id, conversationId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id }, text: "Canonical",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(event);
    store.appendCommunicationProjection(project.id, {
      eventId: event.eventId, surface: "conversation", projectionKey: room.id, projectedAt: event.createdAt,
    });
    store.appendConversationMessage(room.id, { text: event.text }, undefined, "main", undefined, undefined, event.eventId);
    expect(store.readCommunicationProjections(project.id)).toEqual([
      expect.objectContaining({ eventId: event.eventId, revision: 2, message: expect.objectContaining({ renderedText: event.text }) }),
    ]);
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      linkedProjections: 1, duplicateProjectionEventIds: [], missingProjectionMetadataEventIds: [], ok: true,
    });
  });

  it("rebuilds authoritative reply and attachment snapshots from the dispatch ledger", () => {
    const project = store.createProject({ label: "Snapshots", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const firstEvent: CommunicationEvent = {
      eventId: "snapshot-first", schemaVersion: 1, projectId: project.id, conversationId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id }, text: "First", createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(firstEvent);
    const first = store.appendConversationMessage(room.id, { text: "First" }, undefined, "main", undefined, undefined, firstEvent.eventId)!;
    const secondEvent = { ...firstEvent, eventId: "snapshot-second", text: "Reply", createdAt: "2026-07-12T00:01:00.000Z" };
    store.appendCommunicationEvent(secondEvent);
    store.appendConversationMessage(room.id, {
      text: "Reply", replyToMessageId: first.id,
      attachments: [{ id: "asset-1", agentId: "manager", name: "diagram.png", mediaType: "image/png", size: 42, url: "/api/assets/asset-1" }],
    }, undefined, "main", undefined, undefined, secondEvent.eventId);
    const expected = store.getConversationMessages(room.id);
    store.close();
    rmSync(communicationProjectionsPath(dir, project.id), { force: true });
    store = new AgentStore(dir);
    expect(store.getProjectedConversationMessages(room.id)).toEqual(expected);
  });

  it("recovers a durable execution start that has no terminal event after restart", () => {
    const project = store.createProject({ label: "Recovery", hostPath: "/repo" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex" });
    store.appendEvent(agent.id, {
      type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "execution-before-crash",
    });
    // Provider completion alone is not a canonical Run terminal.
    store.appendEvent(agent.id, { type: "turn_done" });
    store.close();
    store = new AgentStore(dir);

    expect(store.recoverInterruptedExecutions()).toEqual([agent.id]);
    expect(store.readEvents(agent.id).at(-1)?.event).toEqual({
      type: "agent_lifecycle", status: "failed", reason: "execution_interrupted", executionId: "execution-before-crash",
    });
    expect(store.recoverInterruptedExecutions()).toEqual([]);
  });

  it("indexes sustained canonical writes without rescanning prior history", () => {
    const project = store.createProject({ label: "Scale", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Scale room" });
    for (let index = 0; index < 500; index += 1) {
      const event: CommunicationEvent = {
        eventId: `scale-${index}`, schemaVersion: 1, projectId: project.id, conversationId: room.id,
        sender: { kind: "system", component: "scale-test" }, intent: "broadcast",
        audience: { kind: "organization", organizationId: project.id }, text: `Event ${index}`,
        createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      };
      store.appendCommunicationEvent(event);
      store.appendCommunicationProjection(project.id, {
        eventId: event.eventId, surface: "conversation", projectionKey: room.id, projectedAt: event.createdAt,
        message: { messageId: `message-${index}`, role: "system", createdAt: event.createdAt },
      });
    }
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      canonicalEvents: 500, linkedProjections: 500, ok: true,
    });
  }, 20_000);
});

describe("AgentStore — multi-conversation membership", () => {
  it("rebuilds membership and removes only a deleted room", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const first = store.createConversation(project.id, { title: "First" });
    const second = store.createConversation(project.id, { title: "Second" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: first.id });
    expect(store.updateAgentConversationMemberships(agent.id, { conversationIds: [first.id, second.id], primaryConversationId: second.id }))
      .toMatchObject({ conversationId: second.id, conversationIds: [first.id, second.id] });
    expect(store.getConversationDetail(first.id)?.agents.map((item) => item.id)).toEqual([agent.id]);
    expect(store.getConversationDetail(second.id)?.agents.map((item) => item.id)).toEqual([agent.id]);
    store.rebuildProjections();
    expect(store.getAgent(agent.id)?.conversationIds).toEqual([first.id, second.id]);
    store.deleteConversation(second.id);
    expect(store.getAgent(agent.id)).toMatchObject({ conversationId: first.id, conversationIds: [first.id] });
  });

  it("rejects cross-project membership", () => {
    const one = store.createProject({ label: "One", hostPath: "/one" });
    const two = store.createProject({ label: "Two", hostPath: "/two" });
    const agent = store.createAgent(one.id, { title: "Agent", engine: "codex" });
    const foreign = store.createConversation(two.id, { title: "Foreign" });
    expect(() => store.updateAgentConversationMemberships(agent.id, { conversationIds: [foreign.id], primaryConversationId: foreign.id })).toThrow("does not belong");
  });
});

const RUN: LogEvent[] = [
  { type: "user_message", text: "Refactor authentication" },
  { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-1", wakeCause: "wait_satisfied" },
  { type: "session", sessionId: "sess-abc" },
  { type: "text", delta: "I'll handle this.", executionId: "run-1" },
  { type: "command", command: "pnpm test", cwd: "/repo" },
  { type: "tool_result", id: "i0", output: "ok", isError: false },
  {
    type: "file_change",
    path: "auth.ts",
    kind: "edit",
    diff: "diff --git a/auth.ts b/auth.ts\n",
  },
  { type: "text", delta: "Done — auth refactor complete.", executionId: "run-1" },
  {
    type: "turn_done",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    providerRequestUsage: [
      { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
    ],
  },
  { type: "agent_output", executionId: "run-1", text: "I'll handle this.Done — auth refactor complete.", sourceSeqStart: 4, sourceSeqEnd: 8 },
  { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-1" },
];

describe("AgentStore — append + projection", () => {
  it("projects a full run into Chat, Work log, Runs, and Artifacts", () => {
    const { projectId, agentId } = seedAgent();
    for (const ev of RUN) store.appendEvent(agentId, ev);

    const detail = store.getAgentDetail(agentId)!;
    expect(detail.messages.map((m) => m.role)).toEqual(["user"]);
    expect(detail.runOutput).toEqual([expect.objectContaining({
      executionId: "run-1",
      kind: "response",
      completed: true,
      text: "I'll handle this.Done — auth refactor complete.",
      sourceSeqStart: 4,
      sourceSeqEnd: 8,
    })]);
    expect(detail.activity.map((item) => item.event.type)).toEqual(["command", "tool_result", "file_change"]);
    expect(detail.changedFiles).toEqual([expect.objectContaining({
      path: "auth.ts", kind: "edit", lastSeq: 7, diff: "diff --git a/auth.ts b/auth.ts\n",
    })]);
    expect(detail.runs).toEqual([expect.objectContaining({
      id: "run-1", status: "completed", reason: "turn_completed", title: "Refactor authentication", wakeCause: "wait_satisfied",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })]);
    expect(detail.workItems).toEqual([]);
    // Artifacts: command log + diff from the file_change
    expect(detail.artifacts).toHaveLength(2);
    expect(detail.artifacts.map((a) => a.kind)).toEqual(["log", "diff"]);
    expect(detail.artifacts.every((artifact) => artifact.executionId === "run-1")).toBe(true);
    expect(detail.artifacts[0]!.path).toBe("000005-command.md");
    expect(detail.artifacts[1]!.path).toBe("000007-diff.patch");
    const commandFile = artifactContentPath(
      dir,
      projectId,
      agentId,
      detail.artifacts[0]!.path,
    );
    expect(existsSync(commandFile)).toBe(true);
    expect(readFileSync(commandFile, "utf8")).toContain("pnpm test");
    // session id captured for resume
    expect(store.resumeSessionId(agentId)).toBe("sess-abc");
  });

  it("rebuilds usage per run and aggregates agent, project, and overall with honest coverage", () => {
    const { projectId, agentId } = seedAgent();
    const unmetered = store.createAgent(projectId, { title: "Legacy", engine: "codex" });
    const otherProject = store.createProject({ label: "Other", hostPath: "/other" });
    const other = store.createAgent(otherProject.id, { title: "Other", engine: "claude" });

    for (const event of RUN) store.appendEvent(agentId, event);
    store.appendEvent(unmetered.id, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "legacy-run" });
    store.appendEvent(unmetered.id, { type: "turn_done", executionId: "legacy-run" });
    store.appendEvent(unmetered.id, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "legacy-run" });
    store.appendEvent(other.id, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "other-run" });
    store.appendEvent(other.id, { type: "turn_done", executionId: "other-run", usage: { inputTokens: 20, cachedInputTokens: 8, outputTokens: 7, reasoningOutputTokens: 3, totalTokens: 27 } });
    store.appendEvent(other.id, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "other-run" });

    expect(store.getTokenUsage({ type: "agent", id: agentId })).toMatchObject({ totalTokens: 15, finalizedRuns: 1, reportedRuns: 1, coverage: 1 });
    expect(store.getTokenUsage({ type: "project", id: projectId })).toMatchObject({ totalTokens: 15, finalizedRuns: 2, reportedRuns: 1, unreportedRuns: 1, coverage: 0.5 });
    expect(store.getTokenUsage({ type: "overall" })).toMatchObject({ inputTokens: 30, cachedInputTokens: 8, outputTokens: 12, reasoningOutputTokens: 3, totalTokens: 42, finalizedRuns: 3, reportedRuns: 2 });
    expect(store.getMeteredRuns({ type: "agent", id: agentId })).toEqual([expect.objectContaining({
      providerRequestUsage: [
        { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
      ],
    })]);

    store.rebuildProjections();
    expect(store.getTokenUsage({ type: "overall" })).toMatchObject({ totalTokens: 42, finalizedRuns: 3, reportedRuns: 2, unreportedRuns: 1 });
    expect(store.getMeteredRuns({ type: "agent", id: agentId })[0]?.providerRequestUsage).toHaveLength(2);
  });

  it("does not manufacture durable Work log responses from transient deltas", () => {
    const { agentId } = seedAgent();
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-1" });
    store.appendEvent(agentId, { type: "text", delta: "transient response", executionId: "run-1" });
    store.appendEvent(agentId, { type: "turn_done" });
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-1" });

    store.close();
    store = new AgentStore(dir);
    const detail = store.getAgentDetail(agentId)!;
    expect(detail.messages).toEqual([]);
    expect(detail.runOutput).toEqual([]);
    expect(detail.runs).toEqual([expect.objectContaining({ id: "run-1", status: "completed" })]);
  });

  it("rebuilds chronological activity and per-file execution history after restart", () => {
    const { agentId } = seedAgent();
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-a" });
    store.appendEvent(agentId, { type: "command", command: "pnpm test", cwd: "/repo" });
    store.appendEvent(agentId, { type: "file_change", path: "src/a.ts", kind: "create", diff: "+first" });
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-a" });
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-b" });
    store.appendEvent(agentId, { type: "test_result", passed: true, summary: "unit tests" });
    store.appendEvent(agentId, { type: "file_change", path: "src/a.ts", kind: "edit", diff: "+second" });

    store.close();
    store = new AgentStore(dir);
    const detail = store.getAgentDetail(agentId)!;
    expect(detail.activity.map(({ executionId, event }) => [executionId, event.type])).toEqual([
      ["run-a", "command"], ["run-a", "file_change"], ["run-b", "test_result"], ["run-b", "file_change"],
    ]);
    expect(detail.changedFiles).toEqual([expect.objectContaining({
      path: "src/a.ts", kind: "edit", diff: "+second", executionIds: ["run-a", "run-b"],
    })]);
  });

  it("assigns monotonic per-agent seq and is append-only (readSince works)", () => {
    const { agentId } = seedAgent();
    const seqs = RUN.map((ev) => store.appendEvent(agentId, ev).seq);
    expect(seqs).toEqual(RUN.map((_, index) => index + 1));
    expect(store.readEvents(agentId)).toHaveLength(RUN.length);
    // SSE replay-from-seq
    expect(store.readEventsSince(agentId, 5).map((e) => e.seq)).toEqual(RUN.slice(5).map((_, index) => index + 6));
    // The public surface has no update/delete of events (append-only by design).
    expect((store as unknown as Record<string, unknown>)["deleteEvent"]).toBeUndefined();
  });

  it("clears only the resumable engine session for fresh-session rollover", () => {
    const { agentId } = seedAgent();
    store.appendEvent(agentId, { type: "session", sessionId: "stale-session" });
    const before = store.getAgent(agentId);
    const eventsBefore = store.readEvents(agentId);

    expect(store.clearResumeSession(agentId, "explicit_compaction")).toBe(true);
    expect(store.resumeSessionId(agentId)).toBeUndefined();
    expect(store.getAgent(agentId)).toMatchObject({
      id: before?.id,
      projectId: before?.projectId,
      conversationId: before?.conversationId,
      conversationIds: before?.conversationIds,
    });
    expect(store.readEvents(agentId).slice(0, -1)).toEqual(eventsBefore);
    expect(store.readEvents(agentId).at(-1)?.event).toEqual({
      type: "session_reset",
      reason: "explicit_compaction",
    });
    store.rebuildProjections();
    expect(store.resumeSessionId(agentId)).toBeUndefined();
    expect(store.clearResumeSession("missing-agent", "explicit_compaction")).toBe(false);
  });
});

describe("AgentStore — rebuild is byte-identical (the property)", () => {
  it("wiping SQLite and rebuilding from the logs yields identical rows", () => {
    // Two agents, two runs, to exercise multiple projects/agents.
    const p = store.createProject({ label: "Demo", hostPath: "/repo" });
    const t1 = store.createAgent(p.id, { title: "Auth", engine: "codex" });
    const t2 = store.createAgent(p.id, { title: "UI", engine: "codex" });
    for (const ev of RUN) store.appendEvent(t1.id, ev);
    for (const ev of RUN.slice(0, 5)) store.appendEvent(t2.id, ev);
    // a second run on t1
    store.appendEvent(t1.id, { type: "user_message", text: "Now fix mobile login" });
    store.appendEvent(t1.id, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-2" });
    store.appendEvent(t1.id, { type: "command", command: "pnpm build", cwd: "/repo" });
    store.appendEvent(t1.id, { type: "turn_done" });
    store.appendEvent(t1.id, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-2" });

    const before = snapshot(store);
    const commandFile = artifactContentPath(dir, p.id, t1.id, "000005-command.md");
    const staleFile = artifactContentPath(dir, p.id, t1.id, "stale.txt");
    writeFileSync(commandFile, "stale command content", "utf8");
    writeFileSync(staleFile, "old derived artifact", "utf8");

    store.rebuildProjections();
    const after = snapshot(store);

    expect(after).toEqual(before);
    expect(readFileSync(commandFile, "utf8")).toContain("pnpm test");
    expect(existsSync(staleFile)).toBe(false);
    // sanity: it actually contained data
    expect((before.messages as unknown[]).length).toBeGreaterThan(0);
    expect((before.runs as unknown[]).length).toBeGreaterThan(0);
    expect((before.events as unknown[]).length).toBeGreaterThan(0);
  });

  it("rebuild reconstructs projections after a total SQLite loss", () => {
    const { agentId } = seedAgent();
    for (const ev of RUN) store.appendEvent(agentId, ev);
    const before = snapshot(store);

    // Simulate SQLite loss: delete all projection rows, then rebuild from logs.
    const db = store.sqlite;
    for (const t of [
      "projects",
      "conversations",
      "agents",
      "messages",
      "runs",
      "work_items",
      "artifacts",
      "events",
    ]) {
      db.exec(`DELETE FROM ${t}`);
    }
    expect((snapshot(store).messages as unknown[]).length).toBe(0);

    store.rebuildProjections();
    expect(snapshot(store)).toEqual(before);
  });

  it("catches a stale SQLite projection up automatically on restart", () => {
    const { agentId } = seedAgent();
    for (const ev of RUN) store.appendEvent(agentId, ev);
    const before = snapshot(store);
    store.sqlite.exec("DELETE FROM events; DELETE FROM messages; DELETE FROM runs; DELETE FROM work_items; DELETE FROM artifacts;");
    store.close();

    store = new AgentStore(dir);
    expect(snapshot(store)).toEqual(before);
  });

  it("persists model-agnostic conversations and linked agents across rebuilds", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const conversation = store.createConversation(project.id, {
      title: "Release control room",
      defaultEngine: "codex",
      defaultModel: "gpt-5",
      defaultEffort: "high",
    });
    const message = appendCanonicalConversationMessage(conversation.id, {
      text: "Spin up one agent for API work and one for UI work.",
    });
    const agent = store.createAgent(project.id, {
      title: "API agent",
      engine: "codex",
      conversationId: conversation.id,
    });

    expect(message?.role).toBe("user");
    expect(agent.conversationId).toBe(conversation.id);

    const before = snapshot(store);
    store.rebuildProjections();

    expect(snapshot(store)).toEqual(before);
    expect(store.getConversationDetail(conversation.id)).toMatchObject({
      conversation: {
        id: conversation.id,
        title: "Release control room",
        defaultEngine: "codex",
      },
      messages: [{ text: "Spin up one agent for API work and one for UI work." }],
      agents: [{ id: agent.id, conversationId: conversation.id }],
    });
  });

  it("persists reply references canonically for agent and conversation messages", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const master = store.createConversation(project.id, { title: "Room" });
    const first = appendCanonicalConversationMessage(master.id, { text: "Original context" })!;
    appendCanonicalConversationMessage(master.id, { text: "Answer", replyToMessageId: first.id });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex" });
    store.appendEvent(agent.id, { type: "user_message", text: "Agent original" });
    const originalMessageId = store.getMessages(agent.id)[0]!.id;
    store.appendEvent(agent.id, {
      type: "user_message",
      text: "Agent answer",
      replyTo: { messageId: originalMessageId, text: "Agent original", role: "user" },
    });

    store.rebuildProjections();
    expect(store.getConversationMessages(master.id)[1]?.replyTo).toMatchObject({ messageId: first.id, text: "Original context" });
    expect(store.getMessages(agent.id)[1]?.replyTo).toMatchObject({ text: "Agent original" });
    expect(() => appendCanonicalConversationMessage(master.id, { text: "bad", replyToMessageId: "elsewhere" })).toThrow(/not found/);
  });

  it("records direct replies only for the referenced active agent author", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const master = store.createConversation(project.id, { title: "Room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const other = store.createAgent(project.id, { title: "Other", engine: "codex", conversationId: master.id });
    const report = appendCanonicalConversationMessage(master.id, { role: "assistant", text: "Done" }, author.id)!;
    const managerMessage = appendCanonicalConversationMessage(master.id, { text: "Manager note" })!;

    const direct = appendCanonicalConversationMessage(master.id, {
      text: "Please revise",
      replyToMessageId: report.id,
      directReplyToAuthorAgentId: author.id,
    }, undefined, "main", [{ targetAgentId: author.id, relayDepth: 0, mentionTrail: [], kind: "direct" }], "direct-receipt")!;
    expect(direct.replyTo?.authorAgentId).toBe(author.id);
    expect(store.getConversationMessageByReceiptKey(master.id, "direct-receipt")?.id).toBe(direct.id);
    expect(store.getConversationDeliveryIntents(master.id)).toMatchObject([{ message: { id: direct.id }, intent: { kind: "direct", targetAgentId: author.id }, messageReceiptKey: "direct-receipt" }]);
    expect(readFileSync(messageDispatchesPath(dir, project.id), "utf8"))
      .toContain(`"messageReceiptKey":"direct-receipt"`);
    expect(() => appendCanonicalConversationMessage(master.id, {
      text: "Spoofed",
      replyToMessageId: report.id,
      directReplyToAuthorAgentId: other.id,
    })).toThrow(/must be the author/);
    expect(() => appendCanonicalConversationMessage(master.id, {
      text: "No agent author",
      replyToMessageId: managerMessage.id,
      directReplyToAuthorAgentId: author.id,
    })).toThrow(/must be the author/);

    store.updateAgent(author.id, { archived: true });
    expect(() => appendCanonicalConversationMessage(master.id, {
      text: "Archived",
      replyToMessageId: report.id,
      directReplyToAuthorAgentId: author.id,
    })).toThrow(/not an active agent/);
  });

  it("reconstructs delivery intents from durable dispatch snapshots without rescanning room timelines", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const master = store.createConversation(project.id, { title: "Room" });
    const first = store.createAgent(project.id, { title: "First", engine: "codex", conversationId: master.id });
    const second = store.createAgent(project.id, { title: "Second", engine: "codex", conversationId: master.id });
    appendCanonicalConversationMessage(
      master.id,
      { text: "Direct" },
      undefined,
      "main",
      [{ targetAgentId: first.id, relayDepth: 0, mentionTrail: [], kind: "direct" }],
    );
    appendCanonicalConversationMessage(
      master.id,
      { text: "Collaborate" },
      undefined,
      "collaboration",
      [
        { targetAgentId: first.id, relayDepth: 0, mentionTrail: [], kind: "tag" },
        { targetAgentId: second.id, relayDepth: 0, mentionTrail: [], kind: "tag" },
      ],
    );
    const timelineReads = vi.spyOn(store, "getConversationMessages");

    expect(store.getConversationDeliveryIntents(master.id)).toHaveLength(3);
    expect(store.getConversationDeliveryIntents(master.id, "9999-01-01T00:00:00.000Z")).toEqual([]);
    expect(timelineReads).not.toHaveBeenCalled();
  });
});

describe("artifactContentPath", () => {
  it("keeps artifact reads and writes inside the agent artifacts directory", () => {
    const { projectId, agentId } = seedAgent();

    expect(artifactContentPath(dir, projectId, agentId, "000001-command.md")).toContain(
      "artifacts",
    );
    expect(() => artifactContentPath(dir, projectId, agentId, "../agent.json")).toThrow(
      /escapes/,
    );
    expect(() => artifactContentPath(dir, projectId, agentId, "/tmp/elsewhere")).toThrow(
      /escapes/,
    );
  });
});

describe("agent organizational hierarchy", () => {
  it("persists mutable reporting lines canonically without allowing invalid parents or cycles", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const otherProject = store.createProject({ label: "Other", hostPath: "/other" });
    const parent = store.createAgent(project.id, { title: "Parent", engine: "codex" });
    const child = store.createAgent(project.id, { title: "Child", engine: "codex" });
    const grandchild = store.createAgent(project.id, { title: "Grandchild", engine: "codex" });
    const foreign = store.createAgent(otherProject.id, { title: "Foreign", engine: "codex" });
    const archived = store.createAgent(project.id, { title: "Archived", engine: "codex" });
    store.updateAgent(archived.id, { archived: true });

    expect(store.updateAgentOrganization(child.id, { managerAgentId: parent.id }))
      .toMatchObject({ managerAgentId: parent.id });
    expect(store.updateAgentOrganization(grandchild.id, { managerAgentId: child.id }))
      .toMatchObject({ managerAgentId: child.id });
    expect(() => store.updateAgentOrganization(parent.id, { managerAgentId: grandchild.id })).toThrow(/cycle/);
    expect(() => store.updateAgentOrganization(parent.id, { managerAgentId: parent.id })).toThrow(/itself/);
    expect(() => store.updateAgentOrganization(child.id, { managerAgentId: foreign.id })).toThrow(/same project/);
    expect(() => store.updateAgentOrganization(child.id, { managerAgentId: archived.id })).toThrow(/active/);
    expect(store.readAgentOrganizationEvents(project.id)).toHaveLength(2);

    store.rebuildProjections();
    expect(store.getAgent(child.id)?.managerAgentId).toBe(parent.id);
    expect(store.getAgent(grandchild.id)?.managerAgentId).toBe(child.id);

    expect(store.updateAgentOrganization(child.id, { managerAgentId: null })?.managerAgentId).toBeUndefined();
    expect(store.readAgentOrganizationEvents(project.id).at(-1)).toMatchObject({ agentId: child.id, managerAgentId: null });
  });

  it("promotes children when archived and cascade-deletes descendants with a deleted manager", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const parent = store.createAgent(project.id, { title: "Parent", engine: "codex" });
    const child = store.createAgent(project.id, { title: "Child", engine: "codex" });
    store.updateAgentOrganization(child.id, { managerAgentId: parent.id });
    store.updateAgent(parent.id, { archived: true });
    expect(store.getAgent(child.id)?.managerAgentId).toBeUndefined();

    const replacement = store.createAgent(project.id, { title: "Replacement", engine: "codex" });
    store.updateAgentOrganization(child.id, { managerAgentId: replacement.id });
    const grandchild = store.createAgent(project.id, { title: "Grandchild", engine: "codex", managerAgentId: child.id });
    expect(store.deleteAgent(replacement.id)).toBe(true);
    expect(store.getAgent(child.id)).toBeUndefined();
    expect(store.getAgent(grandchild.id)).toBeUndefined();
    store.rebuildProjections();
    expect(store.getAgent(child.id)).toBeUndefined();
  });

  it("persists agent spawn provenance and replays it by execution idempotency", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex" });
    const child = store.createAgent(project.id, {
      title: "Researcher", engine: "codex", managerAgentId: manager.id,
    }, {
      agentId: manager.id, executionId: "execution-1", idempotencyKey: "spawn-1", prompt: "Study the evidence.",
    });
    expect(child).toMatchObject({
      managerAgentId: manager.id,
      spawnedByAgentId: manager.id,
      spawnedByExecutionId: "execution-1",
      spawnPrompt: "Study the evidence.",
    });
    expect(store.findAgentSpawn(manager.id, "execution-1", "spawn-1")?.id).toBe(child.id);
    store.rebuildProjections();
    expect(store.getAgent(child.id)).toMatchObject({ spawnedByAgentId: manager.id, spawnPrompt: "Study the evidence." });
  });

  it("persists and rebuilds durable agent model and effort defaults", () => {
    const project = store.createProject({ label: "Runtime defaults", hostPath: dir });
    const agent = store.createAgent(project.id, {
      title: "Specialist", engine: "codex", model: "gpt-specialist", effort: "medium",
    });
    expect(agent).toMatchObject({ model: "gpt-specialist", effort: "medium" });

    store.rebuildProjections();

    expect(store.getAgent(agent.id)).toMatchObject({ model: "gpt-specialist", effort: "medium" });
  });
});

describe("agent presets", () => {
  it("seeds editable suggestions, persists CRUD canonically, and snapshots guidance at spawn", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    expect(store.listAgentPresets(project.id).map((preset) => preset.name)).toEqual(["Documentation", "Frontend", "QA", "Security"]);
    const preset = store.createAgentPreset(project.id, { name: "Release", description: "Ship safely", guidance: "Verify every release gate before shipping.", engine: "codex", enabled: true });
    const agent = store.createAgent(project.id, { title: "Ship", engine: "codex", presetId: preset.id });
    store.updateAgentPreset(preset.id, { guidance: "Changed later and must not affect active agents." });
    expect(store.getAgent(agent.id)?.presetSnapshot?.guidance).toBe("Verify every release gate before shipping.");
    expect(store.deleteAgentPreset(preset.id)).toBe(true);
    store.rebuildProjections();
    expect(store.getAgentPreset(preset.id)).toBeUndefined();
    expect(store.getAgent(agent.id)?.presetSnapshot?.name).toBe("Release");
  });
});

describe("project lifecycle", () => {
  it("cleans an interrupted atomic-project staging directory instead of projecting it", () => {
    const stagingId = ".interrupted.creating";
    mkdirSync(projectDir(dir, stagingId), { recursive: true });
    writeFileSync(projectJsonPath(dir, stagingId), JSON.stringify({
      id: "interrupted",
      label: "Must not appear",
      hostPath: "/staged",
      createdAt: new Date().toISOString(),
      defaultEngine: "codex",
    }));
    store.rebuildProjections();
    expect(store.getProject("interrupted")).toBeUndefined();
    expect(existsSync(projectDir(dir, stagingId))).toBe(false);
  });

  it("renames canonically and rebuilds the renamed projection", () => {
    const project = store.createProject({ label: "Before", hostPath: "/repo" });
    expect(store.updateProject(project.id, { label: "After" })?.label).toBe("After");
    expect(JSON.parse(readFileSync(projectJsonPath(dir, project.id), "utf8"))).toMatchObject({ label: "After", hostPath: "/repo" });
    store.rebuildProjections();
    expect(store.getProject(project.id)?.label).toBe("After");
  });

  it("permanently deletes one canonical project tree and all of its projections", () => {
    const removed = store.createProject({ label: "Remove", hostPath: "/remove" });
    const room = store.createConversation(removed.id, { title: "Room" });
    const agent = store.createAgent(removed.id, { title: "Agent", engine: "codex", conversationId: room.id });
    store.appendEvent(agent.id, { type: "user_message", text: "work" });
    const retained = store.createProject({ label: "Keep", hostPath: "/keep" });
    const retainedAgent = store.createAgent(retained.id, { title: "Keeper", engine: "codex" });

    expect(store.deleteProject(removed.id)).toBe(true);
    expect(existsSync(projectDir(dir, removed.id))).toBe(false);
    expect(store.getProject(removed.id)).toBeUndefined();
    for (const table of ["conversations", "agents", "messages", "runs", "work_items", "artifacts", "events"]) {
      const projectRows = table === "conversations" || table === "agents"
        ? store.sqlite.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).all(removed.id)
        : [];
      expect(projectRows).toEqual([]);
    }
    expect(store.getProject(retained.id)).toBeDefined();
    expect(store.getAgent(retainedAgent.id)).toBeDefined();
    store.rebuildProjections();
    expect(store.getProject(removed.id)).toBeUndefined();
  });
});
