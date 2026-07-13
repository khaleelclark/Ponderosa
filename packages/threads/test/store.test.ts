import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadStore } from "../src/store.js";
import type { CommunicationEvent } from "@ponderosa/core";
import type { LogEvent } from "../src/log-event.js";
import { artifactContentPath, collaborationChatMessagesPath, communicationEventsPath, masterChatMessagesPath, projectDir, projectJsonPath } from "../src/paths.js";

let dir: string;
let store: ThreadStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pond-store-"));
  store = new ThreadStore(dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Read every projection table as plain sorted rows (for equality snapshots). */
function snapshot(s: ThreadStore): Record<string, unknown[]> {
  const db = s.sqlite;
  const tables = [
    "projects",
    "agent_presets",
    "master_chats",
    "master_chat_messages",
    "thread_master_chat_memberships",
    "threads",
    "messages",
    "tasks",
    "artifacts",
    "events",
  ];
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const order = t === "thread_master_chat_memberships" ? "thread_id, position" : "id";
    const rows = db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all() as unknown[];
    out[t] = rows;
  }
  return out;
}

function seedThread(): { projectId: string; threadId: string } {
  const project = store.createProject({ label: "Demo", hostPath: "/repo" });
  const thread = store.createThread(project.id, { title: "Auth", engine: "codex" });
  return { projectId: project.id, threadId: thread.id };
}

describe("ThreadStore — canonical communication events", () => {
  it("keeps long-form documents canonical, scoped, and out of projected summary text", () => {
    const project = store.createProject({ label: "Docs", hostPath: "/repo" });
    const room = store.createMasterChat(project.id, { title: "Room" });
    const author = store.createThread(project.id, { title: "Author", engine: "codex", masterChatId: room.id });
    const recipient = store.createThread(project.id, { title: "Recipient", engine: "codex", masterChatId: room.id });
    const event: CommunicationEvent = {
      eventId: "doc-event", schemaVersion: 2, projectId: project.id, masterChatId: room.id,
      sender: { kind: "agent", agentId: author.id, executionId: "run-1" },
      intent: "collaboration", audience: { kind: "agents", agentIds: [recipient.id] },
      text: "Concise review summary", createdAt: "2026-07-12T00:00:00.000Z",
      document: { id: "doc-1", title: "Architecture Review", mediaType: "text/markdown", content: "# Full review\n\nPrivate detail.", byteLength: 30, authorAgentId: author.id, executionId: "run-1", assignmentId: "assignment-1", createdAt: "2026-07-12T00:00:00.000Z" },
    };
    event.document!.byteLength = Buffer.byteLength(event.document!.content, "utf8");
    store.appendCommunicationEvent(event);
    store.appendCommunicationProjection(project.id, { eventId: event.eventId, surface: "collaboration_chat", projectionKey: room.id, projectedAt: event.createdAt, message: { messageId: "m1", role: "assistant", createdAt: event.createdAt, authorAgentId: author.id } });
    const message = store.readProjectedCommunicationMessages(project.id, "collaboration_chat", room.id)[0]!;
    expect(message.text).toBe("Concise review summary");
    expect(message.document).toMatchObject({ id: "doc-1", title: "Architecture Review", assignmentId: "assignment-1", previewUrl: expect.any(String) });
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
    const room = store.createMasterChat(project.id, { title: "Room" });
    const sender = store.createThread(project.id, { title: "Sender", engine: "codex", masterChatId: room.id });
    const a = store.createThread(project.id, { title: "A", engine: "codex", masterChatId: room.id });
    const b = store.createThread(project.id, { title: "B", engine: "codex", masterChatId: room.id });
    const event: CommunicationEvent = {
      eventId: "normalized", schemaVersion: 2, projectId: project.id, masterChatId: room.id,
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
    const room = store.createMasterChat(project.id, { title: "Room" });
    const otherRoom = store.createMasterChat(project.id, { title: "Other room" });
    const agent = store.createThread(project.id, { title: "Agent", engine: "codex", masterChatId: room.id });
    const foreign = store.createThread(otherProject.id, { title: "Foreign", engine: "codex" });
    const dm: CommunicationEvent = {
      eventId: "dm", schemaVersion: 2, projectId: project.id, masterChatId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
      text: "Private", createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(dm);
    expect(() => store.appendCommunicationProjection(project.id, {
      eventId: dm.eventId, surface: "collaboration_chat", projectionKey: room.id, projectedAt: dm.createdAt,
    })).toThrow("scope cannot project");
    expect(() => store.appendCommunicationProjection(project.id, {
      eventId: dm.eventId, surface: "master_chat", projectionKey: otherRoom.id, projectedAt: dm.createdAt,
    })).toThrow("scope cannot project");
    expect(() => store.appendCommunicationProjection(project.id, {
      eventId: dm.eventId, surface: "user_inbox", projectionKey: "another-user", projectedAt: dm.createdAt,
    })).toThrow("scope cannot project");
    expect(() => store.appendMasterChatMessage(
      room.id,
      { role: "user", text: dm.text },
      undefined,
      "collaboration",
      undefined,
      undefined,
      dm.eventId,
    )).toThrow("scope cannot project");
    expect(store.getMasterChatMessages(room.id, "collaboration")).toEqual([]);
    expect(existsSync(collaborationChatMessagesPath(dir, project.id, room.id))).toBe(false);
    expect(() => store.appendCommunicationEvent({ ...dm, eventId: "unknown", audience: { ...dm.audience, agentId: "missing" } })).toThrow("active agent");
    expect(() => store.appendCommunicationEvent({ ...dm, eventId: "foreign", audience: { ...dm.audience, agentId: foreign.id } })).toThrow("active agent");
    expect(() => store.appendCommunicationEvent({ ...dm, eventId: "wrong-room", masterChatId: otherRoom.id })).toThrow("belong to its master chat");
    store.updateThread(agent.id, { archived: true });
    expect(() => store.appendCommunicationEvent({ ...dm, eventId: "archived" })).toThrow("active agent");
  });

  it("projects one bidirectional User DM identity into Main and Direct Agent timelines", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const room = store.createMasterChat(project.id, { title: "Room" });
    const agent = store.createThread(project.id, { title: "Agent", engine: "codex", masterChatId: room.id });
    const userDm: CommunicationEvent = {
      eventId: "user-to-agent", schemaVersion: 2, projectId: project.id, masterChatId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
      text: "Please investigate", createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(userDm);
    store.appendMasterChatMessage(room.id, { role: "user", text: userDm.text }, undefined, "main", undefined, undefined, userDm.eventId);
    store.appendEvent(agent.id, { type: "user_message", text: userDm.text, communicationEventId: userDm.eventId });

    const agentDm: CommunicationEvent = {
      ...userDm, eventId: "agent-to-user", sender: { kind: "agent", agentId: agent.id },
      text: "Investigation complete", createdAt: "2026-07-12T00:01:00.000Z",
    };
    store.appendCommunicationEvent(agentDm);
    store.appendMasterChatMessage(room.id, { role: "assistant", text: agentDm.text }, agent.id, "main", undefined, undefined, agentDm.eventId);
    store.appendEvent(agent.id, { type: "communication_projection", text: agentDm.text, communicationEventId: agentDm.eventId });

    expect(store.readProjectedCommunicationMessages(project.id, "master_chat", room.id).map((message) => message.eventId))
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
    const room = store.createMasterChat(project.id, { title: "Room" });
    const first = store.createThread(project.id, { title: "First", engine: "codex", masterChatId: room.id });
    const second = store.createThread(project.id, { title: "Second", engine: "codex", masterChatId: room.id });
    const groupDm: CommunicationEvent = {
      eventId: "group-dm", schemaVersion: 2, projectId: project.id, masterChatId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agents", userId: "local-operator", agentIds: [second.id, first.id, second.id] },
      text: "One message", createdAt: "2026-07-12T00:00:00.000Z",
    };
    const recorded = store.appendCommunicationEvent(groupDm).event;
    expect(recorded.intent === "user_dm" && recorded.audience.kind === "user_agents" && recorded.audience.agentIds)
      .toEqual([first.id, second.id].sort());
    store.appendMasterChatMessage(room.id, { role: "user", text: groupDm.text }, undefined, "main", undefined, undefined, groupDm.eventId);
    store.appendEvent(first.id, { type: "user_message", text: groupDm.text, communicationEventId: groupDm.eventId });
    store.appendEvent(second.id, { type: "user_message", text: groupDm.text, communicationEventId: groupDm.eventId });
    expect(store.readProjectedCommunicationMessages(project.id, "master_chat", room.id).map((message) => message.eventId)).toEqual([groupDm.eventId]);
    expect(store.readProjectedCommunicationMessages(project.id, "direct_agent_audit", first.id).map((message) => message.eventId)).toEqual([groupDm.eventId]);
    expect(store.readProjectedCommunicationMessages(project.id, "direct_agent_audit", second.id).map((message) => message.eventId)).toEqual([groupDm.eventId]);
    expect(() => store.appendCommunicationEvent({ ...groupDm, eventId: "agent-group", sender: { kind: "agent", agentId: first.id } }))
      .toThrow("target agent");
  });

  it("rejects self-recipient collaboration before writing the canonical ledger", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const room = store.createMasterChat(project.id, { title: "Room" });
    const sender = store.createThread(project.id, { title: "Sender", engine: "codex", masterChatId: room.id });
    expect(() => store.appendCommunicationEvent({
      eventId: "self", schemaVersion: 2, projectId: project.id, masterChatId: room.id,
      sender: { kind: "agent", agentId: sender.id }, intent: "collaboration",
      audience: { kind: "agents", agentIds: [sender.id] }, text: "Loopback",
      createdAt: "2026-07-12T00:00:00.000Z",
    })).toThrow("cannot target its sender");
    expect(store.readCommunicationEvents(project.id)).toEqual([]);
  });

  it("rejects invalid V2 agent collaboration senders without writing canonical state", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const otherProject = store.createProject({ label: "Other", hostPath: "/other" });
    const room = store.createMasterChat(project.id, { title: "Room" });
    const otherRoom = store.createMasterChat(project.id, { title: "Other room" });
    const recipient = store.createThread(project.id, { title: "Recipient", engine: "codex", masterChatId: room.id });
    const wrongRoom = store.createThread(project.id, { title: "Wrong room", engine: "codex", masterChatId: otherRoom.id });
    const archived = store.createThread(project.id, { title: "Archived", engine: "codex", masterChatId: room.id });
    const foreign = store.createThread(otherProject.id, { title: "Foreign", engine: "codex" });
    store.updateThread(archived.id, { archived: true });
    const before = () => ({
      events: store.readCommunicationEvents(project.id),
      context: store.readContextClassifications(project.id),
      projections: store.readCommunicationProjections(project.id),
    });
    const initial = before();
    const send = (sender: CommunicationEvent["sender"], eventId: string) => () => store.appendCommunicationEvent({
      eventId, schemaVersion: 2, projectId: project.id, masterChatId: room.id, sender,
      intent: "collaboration", audience: { kind: "agents", agentIds: [recipient.id] },
      text: "Review", createdAt: "2026-07-12T00:00:00.000Z",
    });
    expect(send({ kind: "agent", agentId: "missing" }, "missing")).toThrow("active agent");
    expect(send({ kind: "agent", agentId: archived.id }, "archived")).toThrow("active agent");
    expect(send({ kind: "agent", agentId: foreign.id }, "foreign")).toThrow("active agent");
    expect(send({ kind: "agent", agentId: wrongRoom.id }, "wrong-room")).toThrow("belong to its master chat");
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
    store = new ThreadStore(dir);
    store.appendCommunicationEvent({ ...event, eventId: "event-2", text: "Second" });
    expect(store.readCommunicationEvents(project.id).map((item) => item.eventId)).toEqual(["event-1", "event-2"]);

    const valid = readFileSync(file, "utf8");
    store.close();
    writeFileSync(file, `{not-json}\n${JSON.stringify(event)}\n`, "utf8");
    expect(() => new ThreadStore(dir)).toThrow("non-tail corruption");
    writeFileSync(file, valid, "utf8");
    store = new ThreadStore(dir);
  });

  it("reconciles and rebuilds a direct-agent projection by canonical event ID", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const thread = store.createThread(project.id, { title: "Agent", engine: "codex" });
    const event: CommunicationEvent = {
      eventId: "event-direct", schemaVersion: 1, projectId: project.id,
      sender: { kind: "agent", agentId: thread.id }, intent: "direct_to_user",
      audience: { kind: "user", userId: "local-operator" }, text: "Audit note",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(event);
    store.appendEvent(thread.id, { type: "communication_projection", communicationEventId: event.eventId, text: event.text });
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({ ok: true, canonicalEvents: 1, linkedProjections: 1 });
    expect(store.getMessages(thread.id)[0]).toMatchObject({ communicationEventId: event.eventId, text: event.text });

    store.rebuildProjections();
    expect(store.getMessages(thread.id)[0]).toMatchObject({ communicationEventId: event.eventId, text: event.text });
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
    const room = store.createMasterChat(project.id, { title: "Room" });
    const thread = store.createThread(project.id, { title: "Agent", engine: "codex", masterChatId: room.id });
    const event: CommunicationEvent = {
      eventId: "event-multi", schemaVersion: 1, projectId: project.id, masterChatId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "collaboration",
      audience: { kind: "agents", agentIds: [thread.id] }, text: "Review",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(event);
    store.appendMasterChatMessage(room.id, { text: event.text }, undefined, "collaboration", undefined, undefined, event.eventId);
    store.appendEvent(thread.id, { type: "user_message", text: event.text, communicationEventId: event.eventId });
    expect(store.appendCommunicationProjection(project.id, {
      eventId: event.eventId, surface: "direct_agent_audit", projectionKey: thread.id,
      projectedAt: "later retry timestamp",
    }).replayed).toBe(true);
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      canonicalEvents: 1, linkedProjections: 2, duplicateProjectionEventIds: [], ok: true,
    });
    expect(store.readProjectedCommunicationMessages(project.id, "collaboration_chat", room.id))
      .toEqual([expect.objectContaining({ eventId: event.eventId, text: event.text, role: "user" })]);
    expect(store.readProjectedCommunicationMessages(project.id, "direct_agent_audit", thread.id))
      .toEqual([expect.objectContaining({ eventId: event.eventId, text: event.text, role: "user" })]);
  });

  it("append-only enriches placement-only migration records for authoritative reads", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const room = store.createMasterChat(project.id, { title: "Room" });
    const event: CommunicationEvent = {
      eventId: "event-enrich", schemaVersion: 1, projectId: project.id, masterChatId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id }, text: "Canonical",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(event);
    store.appendCommunicationProjection(project.id, {
      eventId: event.eventId, surface: "master_chat", projectionKey: room.id, projectedAt: event.createdAt,
    });
    store.appendMasterChatMessage(room.id, { text: event.text }, undefined, "main", undefined, undefined, event.eventId);
    expect(store.readCommunicationProjections(project.id)).toEqual([
      expect.objectContaining({ eventId: event.eventId, revision: 2, message: expect.objectContaining({ renderedText: event.text }) }),
    ]);
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      linkedProjections: 1, duplicateProjectionEventIds: [], missingProjectionMetadataEventIds: [], ok: true,
    });
  });

  it("serves authoritative reply and attachment snapshots without reading the legacy room log", () => {
    const project = store.createProject({ label: "Snapshots", hostPath: "/repo" });
    const room = store.createMasterChat(project.id, { title: "Room" });
    const firstEvent: CommunicationEvent = {
      eventId: "snapshot-first", schemaVersion: 1, projectId: project.id, masterChatId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id }, text: "First", createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(firstEvent);
    const first = store.appendMasterChatMessage(room.id, { text: "First" }, undefined, "main", undefined, undefined, firstEvent.eventId)!;
    const secondEvent = { ...firstEvent, eventId: "snapshot-second", text: "Reply", createdAt: "2026-07-12T00:01:00.000Z" };
    store.appendCommunicationEvent(secondEvent);
    store.appendMasterChatMessage(room.id, {
      text: "Reply", replyToMessageId: first.id,
      attachments: [{ id: "asset-1", threadId: "manager", name: "diagram.png", mediaType: "image/png", size: 42, url: "/api/assets/asset-1" }],
    }, undefined, "main", undefined, undefined, secondEvent.eventId);
    const expected = store.getMasterChatMessages(room.id);
    writeFileSync(masterChatMessagesPath(dir, project.id, room.id), "", "utf8");
    expect(store.getProjectedMasterChatMessages(room.id)).toEqual(expected);
  });

  it("recovers a durable execution start that has no terminal event after restart", () => {
    const project = store.createProject({ label: "Recovery", hostPath: "/repo" });
    const thread = store.createThread(project.id, { title: "Agent", engine: "codex" });
    store.appendEvent(thread.id, {
      type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "execution-before-crash",
    });
    store.close();
    store = new ThreadStore(dir);

    expect(store.recoverInterruptedExecutions()).toEqual([thread.id]);
    expect(store.readEvents(thread.id).at(-1)?.event).toEqual({
      type: "agent_lifecycle", status: "failed", reason: "execution_interrupted", executionId: "execution-before-crash",
    });
    expect(store.recoverInterruptedExecutions()).toEqual([]);
  });

  it("indexes sustained canonical writes without rescanning prior history", () => {
    const project = store.createProject({ label: "Scale", hostPath: "/repo" });
    const room = store.createMasterChat(project.id, { title: "Scale room" });
    for (let index = 0; index < 500; index += 1) {
      const event: CommunicationEvent = {
        eventId: `scale-${index}`, schemaVersion: 1, projectId: project.id, masterChatId: room.id,
        sender: { kind: "system", component: "scale-test" }, intent: "broadcast",
        audience: { kind: "organization", organizationId: project.id }, text: `Event ${index}`,
        createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      };
      store.appendCommunicationEvent(event);
      store.appendCommunicationProjection(project.id, {
        eventId: event.eventId, surface: "master_chat", projectionKey: room.id, projectedAt: event.createdAt,
        message: { messageId: `message-${index}`, role: "system", createdAt: event.createdAt },
      });
    }
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      canonicalEvents: 500, linkedProjections: 500, ok: true,
    });
  }, 20_000);
});

describe("ThreadStore — multi-master-chat membership", () => {
  it("rebuilds membership and removes only a deleted room", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const first = store.createMasterChat(project.id, { title: "First" });
    const second = store.createMasterChat(project.id, { title: "Second" });
    const thread = store.createThread(project.id, { title: "Agent", engine: "codex", masterChatId: first.id });
    expect(store.updateThreadMasterChatMemberships(thread.id, { masterChatIds: [first.id, second.id], primaryMasterChatId: second.id }))
      .toMatchObject({ masterChatId: second.id, masterChatIds: [first.id, second.id] });
    expect(store.getMasterChatDetail(first.id)?.threads.map((item) => item.id)).toEqual([thread.id]);
    expect(store.getMasterChatDetail(second.id)?.threads.map((item) => item.id)).toEqual([thread.id]);
    store.rebuildProjections();
    expect(store.getThread(thread.id)?.masterChatIds).toEqual([first.id, second.id]);
    store.deleteMasterChat(second.id);
    expect(store.getThread(thread.id)).toMatchObject({ masterChatId: first.id, masterChatIds: [first.id] });
  });

  it("rejects cross-project membership", () => {
    const one = store.createProject({ label: "One", hostPath: "/one" });
    const two = store.createProject({ label: "Two", hostPath: "/two" });
    const thread = store.createThread(one.id, { title: "Agent", engine: "codex" });
    const foreign = store.createMasterChat(two.id, { title: "Foreign" });
    expect(() => store.updateThreadMasterChatMemberships(thread.id, { masterChatIds: [foreign.id], primaryMasterChatId: foreign.id })).toThrow("does not belong");
  });
});

const RUN: LogEvent[] = [
  { type: "user_message", text: "Refactor authentication" },
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
  { type: "turn_done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  { type: "agent_output", executionId: "run-1", text: "I'll handle this.Done — auth refactor complete.", sourceSeqStart: 3, sourceSeqEnd: 7 },
];

describe("ThreadStore — append + projection", () => {
  it("projects a full run into Chat, Thinking, Tasks, and Artifacts", () => {
    const { projectId, threadId } = seedThread();
    for (const ev of RUN) store.appendEvent(threadId, ev);

    const detail = store.getThreadDetail(threadId)!;
    expect(detail.messages.map((m) => m.role)).toEqual(["user"]);
    expect(detail.thinking).toEqual([expect.objectContaining({
      executionId: "run-1",
      kind: "response",
      completed: true,
      text: "I'll handle this.Done — auth refactor complete.",
      sourceSeqStart: 3,
      sourceSeqEnd: 7,
    })]);
    expect(detail.activity.map((item) => item.event.type)).toEqual(["command", "tool_result", "file_change"]);
    expect(detail.changedFiles).toEqual([expect.objectContaining({
      path: "auth.ts", kind: "edit", lastSeq: 6, diff: "diff --git a/auth.ts b/auth.ts\n",
    })]);
    // Tasks: one task, closed done by turn_done
    expect(detail.tasks).toHaveLength(1);
    expect(detail.tasks[0]!.status).toBe("done");
    expect(detail.tasks[0]!.title).toBe("Refactor authentication");
    // Artifacts: command log + diff from the file_change
    expect(detail.artifacts).toHaveLength(2);
    expect(detail.artifacts.map((a) => a.kind)).toEqual(["log", "diff"]);
    expect(detail.artifacts[0]!.path).toBe("000004-command.md");
    expect(detail.artifacts[1]!.path).toBe("000006-diff.patch");
    const commandFile = artifactContentPath(
      dir,
      projectId,
      threadId,
      detail.artifacts[0]!.path,
    );
    expect(existsSync(commandFile)).toBe(true);
    expect(readFileSync(commandFile, "utf8")).toContain("pnpm test");
    // session id captured for resume
    expect(store.resumeSessionId(threadId)).toBe("sess-abc");
  });

  it("recovers legacy text into ordered execution-scoped Thinking entries after restart", () => {
    const { threadId } = seedThread();
    store.appendEvent(threadId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "legacy-run-1" });
    store.appendEvent(threadId, { type: "text", delta: "first legacy response" });
    store.appendEvent(threadId, { type: "turn_done" });
    store.appendEvent(threadId, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "legacy-run-1" });
    store.appendEvent(threadId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "legacy-run-2" });
    store.appendEvent(threadId, { type: "text", delta: "second legacy response" });
    store.appendEvent(threadId, { type: "turn_done" });
    store.appendEvent(threadId, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "legacy-run-2" });

    store.close();
    store = new ThreadStore(dir);
    const detail = store.getThreadDetail(threadId)!;
    expect(detail.messages).toEqual([]);
    expect(detail.thinking.map(({ executionId, text, completed }) => ({ executionId, text, completed }))).toEqual([
      { executionId: "legacy-run-1", text: "first legacy response", completed: true },
      { executionId: "legacy-run-2", text: "second legacy response", completed: true },
    ]);
  });

  it("rebuilds chronological activity and per-file execution history after restart", () => {
    const { threadId } = seedThread();
    store.appendEvent(threadId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-a" });
    store.appendEvent(threadId, { type: "command", command: "pnpm test", cwd: "/repo" });
    store.appendEvent(threadId, { type: "file_change", path: "src/a.ts", kind: "create", diff: "+first" });
    store.appendEvent(threadId, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-a" });
    store.appendEvent(threadId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-b" });
    store.appendEvent(threadId, { type: "test_result", passed: true, summary: "unit tests" });
    store.appendEvent(threadId, { type: "file_change", path: "src/a.ts", kind: "edit", diff: "+second" });

    store.close();
    store = new ThreadStore(dir);
    const detail = store.getThreadDetail(threadId)!;
    expect(detail.activity.map(({ executionId, event }) => [executionId, event.type])).toEqual([
      ["run-a", "command"], ["run-a", "file_change"], ["run-b", "test_result"], ["run-b", "file_change"],
    ]);
    expect(detail.changedFiles).toEqual([expect.objectContaining({
      path: "src/a.ts", kind: "edit", diff: "+second", executionIds: ["run-a", "run-b"],
    })]);
  });

  it("assigns monotonic per-thread seq and is append-only (readSince works)", () => {
    const { threadId } = seedThread();
    const seqs = RUN.map((ev) => store.appendEvent(threadId, ev).seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(store.readEvents(threadId)).toHaveLength(9);
    // SSE replay-from-seq
    expect(store.readEventsSince(threadId, 5).map((e) => e.seq)).toEqual([6, 7, 8, 9]);
    // The public surface has no update/delete of events (append-only by design).
    expect((store as unknown as Record<string, unknown>)["deleteEvent"]).toBeUndefined();
  });

  it("clears only the resumable engine session for fresh-session rollover", () => {
    const { threadId } = seedThread();
    store.appendEvent(threadId, { type: "session", sessionId: "stale-session" });
    const before = store.getThread(threadId);
    const eventsBefore = store.readEvents(threadId);

    expect(store.clearResumeSession(threadId, "explicit_compaction")).toBe(true);
    expect(store.resumeSessionId(threadId)).toBeUndefined();
    expect(store.getThread(threadId)).toMatchObject({
      id: before?.id,
      projectId: before?.projectId,
      masterChatId: before?.masterChatId,
      masterChatIds: before?.masterChatIds,
    });
    expect(store.readEvents(threadId).slice(0, -1)).toEqual(eventsBefore);
    expect(store.readEvents(threadId).at(-1)?.event).toEqual({
      type: "session_reset",
      reason: "explicit_compaction",
    });
    store.rebuildProjections();
    expect(store.resumeSessionId(threadId)).toBeUndefined();
    expect(store.clearResumeSession("missing-thread", "explicit_compaction")).toBe(false);
  });
});

describe("ThreadStore — rebuild is byte-identical (the property)", () => {
  it("wiping SQLite and rebuilding from the logs yields identical rows", () => {
    // Two threads, two runs, to exercise multiple projects/threads.
    const p = store.createProject({ label: "Demo", hostPath: "/repo" });
    const t1 = store.createThread(p.id, { title: "Auth", engine: "codex" });
    const t2 = store.createThread(p.id, { title: "UI", engine: "codex" });
    for (const ev of RUN) store.appendEvent(t1.id, ev);
    for (const ev of RUN.slice(0, 5)) store.appendEvent(t2.id, ev);
    // a second run on t1
    store.appendEvent(t1.id, { type: "user_message", text: "Now fix mobile login" });
    store.appendEvent(t1.id, { type: "command", command: "pnpm build", cwd: "/repo" });
    store.appendEvent(t1.id, { type: "turn_done" });

    const before = snapshot(store);
    const commandFile = artifactContentPath(dir, p.id, t1.id, "000004-command.md");
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
    expect((before.tasks as unknown[]).length).toBeGreaterThan(0);
    expect((before.events as unknown[]).length).toBeGreaterThan(0);
  });

  it("rebuild reconstructs projections after a total SQLite loss", () => {
    const { threadId } = seedThread();
    for (const ev of RUN) store.appendEvent(threadId, ev);
    const before = snapshot(store);

    // Simulate SQLite loss: delete all projection rows, then rebuild from logs.
    const db = store.sqlite;
    for (const t of [
      "projects",
      "master_chats",
      "master_chat_messages",
      "threads",
      "messages",
      "tasks",
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
    const { threadId } = seedThread();
    for (const ev of RUN) store.appendEvent(threadId, ev);
    const before = snapshot(store);
    store.sqlite.exec("DELETE FROM events; DELETE FROM messages; DELETE FROM tasks; DELETE FROM artifacts;");
    store.close();

    store = new ThreadStore(dir);
    expect(snapshot(store)).toEqual(before);
  });

  it("persists model-agnostic master chats and linked agent threads across rebuilds", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const masterChat = store.createMasterChat(project.id, {
      title: "Release control room",
      defaultEngine: "codex",
      defaultModel: "gpt-5",
      defaultEffort: "high",
    });
    const message = store.appendMasterChatMessage(masterChat.id, {
      text: "Spin up one agent for API work and one for UI work.",
    });
    const thread = store.createThread(project.id, {
      title: "API agent",
      engine: "codex",
      masterChatId: masterChat.id,
    });

    expect(message?.role).toBe("user");
    expect(thread.masterChatId).toBe(masterChat.id);

    const before = snapshot(store);
    store.rebuildProjections();

    expect(snapshot(store)).toEqual(before);
    expect(store.getMasterChatDetail(masterChat.id)).toMatchObject({
      masterChat: {
        id: masterChat.id,
        title: "Release control room",
        defaultEngine: "codex",
      },
      messages: [{ text: "Spin up one agent for API work and one for UI work." }],
      threads: [{ id: thread.id, masterChatId: masterChat.id }],
    });
  });

  it("persists reply references canonically for thread and master-chat messages", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const master = store.createMasterChat(project.id, { title: "Room" });
    const first = store.appendMasterChatMessage(master.id, { text: "Original context" })!;
    store.appendMasterChatMessage(master.id, { text: "Answer", replyToMessageId: first.id });
    const thread = store.createThread(project.id, { title: "Agent", engine: "codex" });
    store.appendEvent(thread.id, { type: "user_message", text: "Thread original" });
    const originalMessageId = store.getMessages(thread.id)[0]!.id;
    store.appendEvent(thread.id, {
      type: "user_message",
      text: "Thread answer",
      replyTo: { messageId: originalMessageId, text: "Thread original", role: "user" },
    });

    store.rebuildProjections();
    expect(store.getMasterChatMessages(master.id)[1]?.replyTo).toMatchObject({ messageId: first.id, text: "Original context" });
    expect(store.getMessages(thread.id)[1]?.replyTo).toMatchObject({ text: "Thread original" });
    expect(() => store.appendMasterChatMessage(master.id, { text: "bad", replyToMessageId: "elsewhere" })).toThrow(/not found/);
  });

  it("records direct replies only for the referenced active agent author", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const master = store.createMasterChat(project.id, { title: "Room" });
    const author = store.createThread(project.id, { title: "Author", engine: "codex", masterChatId: master.id });
    const other = store.createThread(project.id, { title: "Other", engine: "codex", masterChatId: master.id });
    const report = store.appendMasterChatMessage(master.id, { role: "assistant", text: "Done" }, author.id)!;
    const managerMessage = store.appendMasterChatMessage(master.id, { text: "Manager note" })!;

    const direct = store.appendMasterChatMessage(master.id, {
      text: "Please revise",
      replyToMessageId: report.id,
      directReplyToAuthorThreadId: author.id,
    }, undefined, "main", [{ targetThreadId: author.id, relayDepth: 0, mentionTrail: [], kind: "direct" }], "direct-receipt")!;
    expect(direct.replyTo?.authorThreadId).toBe(author.id);
    expect(store.getMasterChatMessageByReceiptKey(master.id, "direct-receipt")?.id).toBe(direct.id);
    expect(store.getMasterChatDeliveryIntents(master.id)).toMatchObject([{ message: { id: direct.id }, intent: { kind: "direct", targetThreadId: author.id }, messageReceiptKey: "direct-receipt" }]);
    expect(readFileSync(masterChatMessagesPath(dir, project.id, master.id), "utf8"))
      .toContain(`"directReplyToAuthorThreadId":"${author.id}"`);
    expect(() => store.appendMasterChatMessage(master.id, {
      text: "Spoofed",
      replyToMessageId: report.id,
      directReplyToAuthorThreadId: other.id,
    })).toThrow(/must be the author/);
    expect(() => store.appendMasterChatMessage(master.id, {
      text: "No agent author",
      replyToMessageId: managerMessage.id,
      directReplyToAuthorThreadId: author.id,
    })).toThrow(/must be the author/);

    store.updateThread(author.id, { archived: true });
    expect(() => store.appendMasterChatMessage(master.id, {
      text: "Archived",
      replyToMessageId: report.id,
      directReplyToAuthorThreadId: author.id,
    })).toThrow(/not an active agent/);
  });
});

describe("artifactContentPath", () => {
  it("keeps artifact reads and writes inside the thread artifacts directory", () => {
    const { projectId, threadId } = seedThread();

    expect(artifactContentPath(dir, projectId, threadId, "000001-command.md")).toContain(
      "artifacts",
    );
    expect(() => artifactContentPath(dir, projectId, threadId, "../thread.json")).toThrow(
      /escapes/,
    );
    expect(() => artifactContentPath(dir, projectId, threadId, "/tmp/elsewhere")).toThrow(
      /escapes/,
    );
  });
});

describe("agent organizational hierarchy", () => {
  it("persists mutable reporting lines canonically without allowing invalid parents or cycles", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const otherProject = store.createProject({ label: "Other", hostPath: "/other" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex" });
    const child = store.createThread(project.id, { title: "Child", engine: "codex" });
    const grandchild = store.createThread(project.id, { title: "Grandchild", engine: "codex" });
    const foreign = store.createThread(otherProject.id, { title: "Foreign", engine: "codex" });
    const archived = store.createThread(project.id, { title: "Archived", engine: "codex" });
    store.updateThread(archived.id, { archived: true });

    expect(store.updateAgentOrganization(child.id, { parentAgentId: parent.id }))
      .toMatchObject({ organizationalParentAgentId: parent.id });
    expect(store.updateAgentOrganization(grandchild.id, { parentAgentId: child.id }))
      .toMatchObject({ organizationalParentAgentId: child.id });
    expect(() => store.updateAgentOrganization(parent.id, { parentAgentId: grandchild.id })).toThrow(/cycle/);
    expect(() => store.updateAgentOrganization(parent.id, { parentAgentId: parent.id })).toThrow(/itself/);
    expect(() => store.updateAgentOrganization(child.id, { parentAgentId: foreign.id })).toThrow(/same project/);
    expect(() => store.updateAgentOrganization(child.id, { parentAgentId: archived.id })).toThrow(/active/);
    expect(store.readAgentOrganizationEvents(project.id)).toHaveLength(2);

    store.rebuildProjections();
    expect(store.getThread(child.id)?.organizationalParentAgentId).toBe(parent.id);
    expect(store.getThread(grandchild.id)?.organizationalParentAgentId).toBe(child.id);

    expect(store.updateAgentOrganization(child.id, { parentAgentId: null })?.organizationalParentAgentId).toBeUndefined();
    expect(store.readAgentOrganizationEvents(project.id).at(-1)).toMatchObject({ agentId: child.id, parentAgentId: null });
  });

  it("promotes organizational children when a parent is archived or deleted", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex" });
    const child = store.createThread(project.id, { title: "Child", engine: "codex" });
    store.updateAgentOrganization(child.id, { parentAgentId: parent.id });
    store.updateThread(parent.id, { archived: true });
    expect(store.getThread(child.id)?.organizationalParentAgentId).toBeUndefined();

    const replacement = store.createThread(project.id, { title: "Replacement", engine: "codex" });
    store.updateAgentOrganization(child.id, { parentAgentId: replacement.id });
    expect(store.deleteThread(replacement.id)).toBe(true);
    expect(store.getThread(child.id)?.organizationalParentAgentId).toBeUndefined();
    store.rebuildProjections();
    expect(store.getThread(child.id)?.organizationalParentAgentId).toBeUndefined();
  });
});

describe("agent presets", () => {
  it("seeds editable suggestions, persists CRUD canonically, and snapshots guidance at spawn", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    expect(store.listAgentPresets(project.id).map((preset) => preset.name)).toEqual(["Documentation", "Frontend", "QA", "Security"]);
    const preset = store.createAgentPreset(project.id, { name: "Release", description: "Ship safely", guidance: "Verify every release gate before shipping.", engine: "codex", enabled: true });
    const thread = store.createThread(project.id, { title: "Ship", engine: "codex", presetId: preset.id });
    store.updateAgentPreset(preset.id, { guidance: "Changed later and must not affect active agents." });
    expect(store.getThread(thread.id)?.presetSnapshot?.guidance).toBe("Verify every release gate before shipping.");
    expect(store.deleteAgentPreset(preset.id)).toBe(true);
    store.rebuildProjections();
    expect(store.getAgentPreset(preset.id)).toBeUndefined();
    expect(store.getThread(thread.id)?.presetSnapshot?.name).toBe("Release");
  });
});

describe("project lifecycle", () => {
  it("renames canonically and rebuilds the renamed projection", () => {
    const project = store.createProject({ label: "Before", hostPath: "/repo" });
    expect(store.updateProject(project.id, { label: "After" })?.label).toBe("After");
    expect(JSON.parse(readFileSync(projectJsonPath(dir, project.id), "utf8"))).toMatchObject({ label: "After", hostPath: "/repo" });
    store.rebuildProjections();
    expect(store.getProject(project.id)?.label).toBe("After");
  });

  it("permanently deletes one canonical project tree and all of its projections", () => {
    const removed = store.createProject({ label: "Remove", hostPath: "/remove" });
    const room = store.createMasterChat(removed.id, { title: "Room" });
    const thread = store.createThread(removed.id, { title: "Agent", engine: "codex", masterChatId: room.id });
    store.appendEvent(thread.id, { type: "user_message", text: "work" });
    const retained = store.createProject({ label: "Keep", hostPath: "/keep" });
    const retainedThread = store.createThread(retained.id, { title: "Keeper", engine: "codex" });

    expect(store.deleteProject(removed.id)).toBe(true);
    expect(existsSync(projectDir(dir, removed.id))).toBe(false);
    expect(store.getProject(removed.id)).toBeUndefined();
    for (const table of ["master_chats", "master_chat_messages", "threads", "messages", "tasks", "artifacts", "events"]) {
      const projectRows = table === "master_chats" || table === "threads"
        ? store.sqlite.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).all(removed.id)
        : [];
      expect(projectRows).toEqual([]);
    }
    expect(store.getProject(retained.id)).toBeDefined();
    expect(store.getThread(retainedThread.id)).toBeDefined();
    store.rebuildProjections();
    expect(store.getProject(removed.id)).toBeUndefined();
  });
});
