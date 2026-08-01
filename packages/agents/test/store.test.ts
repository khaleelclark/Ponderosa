import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDeletionConflictError, AgentStore } from "../src/store.js";
import { publishManagedArtifactContent } from "../src/managed-artifact-files.js";
import { EventLog } from "../src/eventlog.js";
import { CoordinationV3Store } from "../src/coordination-v3-store.js";
import type { CommunicationEvent, CommunicationRevisionEvent } from "@ponderosa/core";
import type { LogEvent } from "../src/log-event.js";
import { agentDir, agentPresetsPath, agentsDir, artifactContentPath, communicationEventsPath, communicationProjectionsPath, communicationRevisionsPath, eventsPath, importedAgentHistoryPath, managedArtifactContentPath, managedArtifactsLogPath, messageDispatchesPath, projectDir, projectJsonPath } from "../src/paths.js";

const itWithManagedArtifacts = process.platform === "linux" ? it : it.skip;

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
    "chat_search_messages",
    "runs",
    "work_items",
    "artifacts",
    "events",
    "imported_history_messages",
    "activity_projection",
    "changed_file_projection",
    "changed_file_execution_projection",
    "agent_event_head_projection",
    "agent_health_projection",
    "all_chat_feed_projection",
    "managed_artifact_projection",
    "continuation_handoffs",
  ];
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const order = t === "agent_conversation_memberships"
      ? "agent_id, position"
      : t === "runs"
        ? "agent_id, id"
        : t === "chat_search_messages"
          ? "row_key"
        : t === "imported_history_messages"
          ? "agent_id, message_id"
        : t === "activity_projection"
          ? "agent_id, seq"
        : t === "changed_file_projection"
          ? "agent_id, path"
        : t === "changed_file_execution_projection"
          ? "agent_id, path, execution_id"
        : t === "agent_event_head_projection" || t === "agent_health_projection"
          ? "agent_id"
        : t === "all_chat_feed_projection"
          ? "project_id, communication_event_id"
        : t === "managed_artifact_projection"
          ? "project_id, artifact_id"
        : t === "continuation_handoffs"
          ? "agent_id, source_execution_id"
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
  itWithManagedArtifacts("searches human-facing projections globally while excluding runtime detail", () => {
    const first = store.createProject({ label: "Alpha", hostPath: "/alpha" });
    const firstChat = store.getConversation(first.lastConversationId!)!;
    const firstAgent = store.createAgent(first.id, { title: "Alpha Agent", engine: "codex", conversationId: firstChat.id });
    const firstMessage = appendCanonicalConversationMessage(firstChat.id, { text: "Investigate the rare cache needle" });
    store.appendEvent(firstAgent.id, { type: "command", command: "echo secret-needle", cwd: "/alpha" });
    store.appendEvent(firstAgent.id, { type: "text", delta: "runtime-needle must stay out of Chat" });

    const second = store.createProject({ label: "Beta", hostPath: "/beta" });
    const secondChat = store.getConversation(second.lastConversationId!)!;
    appendCanonicalConversationMessage(secondChat.id, { text: "A second needle across projects" });

    const response = store.searchGlobalChats({
      query: "needle",
      notifications: [{ conversationId: firstChat.id, communicationEventId: firstMessage!.communicationEventId }],
    });
    expect(response.results.map((result) => result.project.label)).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
    expect(response.results.some((result) => result.snippet.includes("runtime-needle") || result.snippet.includes("secret-needle"))).toBe(false);
    expect(response.results.find((result) => result.messageId === firstMessage!.id)).toMatchObject({
      unread: true,
      chat: { kind: "conversation", id: firstChat.id, title: firstChat.title },
      author: { kind: "user", label: "User" },
    });

    const empty = store.searchGlobalChats({ notifications: [{ conversationId: firstChat.id, communicationEventId: firstMessage!.communicationEventId }] });
    expect(empty.results).toHaveLength(1);
    expect(empty.recentChats.map((item) => item.project.label)).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
  });

  it("bounds global search reads before timeline materialization on large histories", () => {
    const project = store.createProject({ label: "Bounded", hostPath: "/bounded" });
    const conversationId = project.lastConversationId!;
    const insert = store.sqlite.prepare(`
      INSERT INTO chat_search_messages (
        row_key, project_id, chat_kind, chat_id, message_id,
        communication_event_id, role, timestamp, order_key, text
      ) VALUES (?, ?, 'conversation', ?, ?, ?, 'user', ?, ?, ?)
    `);
    store.sqlite.transaction(() => {
      for (let index = 0; index < 500; index += 1) {
        const id = `bounded-${String(index).padStart(4, "0")}`;
        const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
        insert.run(id, project.id, conversationId, id, id, timestamp, timestamp, `bounded needle ${index}`);
      }
    })();
    const conversationRead = vi.spyOn(store, "getConversationMessages").mockImplementation(() => {
      throw new Error("search must not materialize conversation timelines");
    });
    const agentRead = vi.spyOn(store, "getProjectedAgentMessages").mockImplementation(() => {
      throw new Error("search must not materialize agent timelines");
    });

    const result = store.searchGlobalChats({ query: "needle", limit: 10, maxScannedMessages: 25 });

    expect(result.results).toHaveLength(10);
    expect(result.scannedMessages).toBe(25);
    expect(result.truncated).toBe(true);
    expect(conversationRead).not.toHaveBeenCalled();
    expect(agentRead).not.toHaveBeenCalled();
    const queryPlan = store.sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT search.row_key
      FROM chat_search_messages search
      JOIN projects project ON project.id = search.project_id
      LEFT JOIN conversations conversation
        ON search.chat_kind = 'conversation' AND conversation.id = search.chat_id AND conversation.archived = 0
      LEFT JOIN agents chat_agent
        ON search.chat_kind = 'agent' AND chat_agent.id = search.chat_id AND chat_agent.archived = 0
      WHERE (conversation.id IS NOT NULL OR chat_agent.id IS NOT NULL)
        AND NOT (
          search.chat_kind = 'agent' AND EXISTS (
            SELECT 1
            FROM chat_search_messages preferred
            JOIN conversations preferred_conversation
              ON preferred_conversation.id = preferred.chat_id AND preferred_conversation.archived = 0
            WHERE preferred.project_id = search.project_id
              AND preferred.communication_event_id = search.communication_event_id
              AND preferred.chat_kind = 'conversation'
          )
        )
      ORDER BY search.timestamp DESC, search.chat_kind DESC, search.row_key DESC
      LIMIT 26
    `).all() as Array<{ detail: string }>;
    expect(queryPlan.some((row) => row.detail.includes("idx_chat_search_newest"))).toBe(true);
    expect(queryPlan.some((row) => row.detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(false);
  });

  it("rebuilds the latest passive display text after reconnect without changing message identity", () => {
    const project = store.createProject({ label: "Edited", hostPath: "/edited" });
    const conversationId = project.lastConversationId!;
    const eventId = "passive-edit-event";
    const createdAt = "2026-07-16T12:00:00.000Z";
    store.appendCommunicationEvent({
      eventId,
      schemaVersion: 1,
      projectId: project.id,
      conversationId,
      sender: { kind: "user", userId: "local-operator" },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
      text: "Original display text",
      createdAt,
    });
    store.appendCommunicationProjection(project.id, {
      eventId,
      surface: "conversation",
      projectionKey: conversationId,
      projectedAt: createdAt,
      message: {
        messageId: "projected-passive-edit-message",
        role: "user",
        renderedText: "Latest passive edit text",
        createdAt,
      },
    });

    expect(store.searchGlobalChats({ query: "latest passive" }).results[0]).toMatchObject({
      messageId: "projected-passive-edit-message",
      communicationEventId: eventId,
      snippet: "Latest passive edit text",
    });

    store.close();
    store = new AgentStore(dir);
    expect(store.searchGlobalChats({ query: "latest passive" }).results[0]).toMatchObject({
      messageId: "projected-passive-edit-message",
      communicationEventId: eventId,
      snippet: "Latest passive edit text",
    });
  });

  it("enforces exclusive live ownership of a data directory", () => {
    expect(() => new AgentStore(dir)).toThrow("already owned");
    store.close();
    store = new AgentStore(dir);
    expect(store.listProjects()).toEqual([]);
  });

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
  itWithManagedArtifacts("projects managed artifact attachments on every chat read and preserves an unavailable tombstone", () => {
    const project = store.createProject({ label: "Artifact chat", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Artifact room" });
    const author = store.createAgent(project.id, {
      title: "Author",
      engine: "codex",
      conversationId: room.id,
    });
    const artifactId = "managed-chat-screenshot";
    const published = publishManagedArtifactContent(dir, project.id, artifactId, Buffer.from("png-bytes"));
    store.recordProjectArtifact({
      id: artifactId,
      projectId: project.id,
      agentId: author.id,
      originAgentId: author.id,
      executionId: "run-artifact-chat",
      kind: "screenshot",
      path: `browser/${artifactId}.png`,
      summary: "visual-pass.png",
      createdAt: "2026-07-12T00:00:00.000Z",
      mediaType: "image/png",
      visibility: "project",
      pinned: false,
      size: published.size,
      sha256: published.sha256,
    });
    const event: CommunicationEvent = {
      eventId: "artifact-only-event",
      schemaVersion: 2,
      projectId: project.id,
      conversationId: room.id,
      sender: { kind: "agent", agentId: author.id, executionId: "run-artifact-chat" },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
      text: "",
      artifactIds: [artifactId],
      createdAt: "2026-07-12T00:00:00.000Z",
      idempotencyKey: "artifact-only",
    };
    expect(store.appendCommunicationEvent(event).replayed).toBe(false);
    store.appendConversationMessage(
      room.id,
      { role: "assistant", text: "", artifactIds: [artifactId] },
      author.id,
      "main",
      undefined,
      undefined,
      event.eventId,
    );
    store.appendEvent(author.id, {
      type: "communication_projection",
      communicationEventId: event.eventId,
      text: "",
      role: "assistant",
    });

    const available = store.getConversationMessages(room.id, "main")[0]!;
    expect(available).toMatchObject({
      text: "",
      artifactIds: [artifactId],
      attachments: [{
        id: artifactId,
        name: "visual-pass.png",
        mediaType: "image/png",
        size: published.size,
        previewUrl: `/api/projects/${project.id}/artifacts/${artifactId}/preview`,
        downloadUrl: `/api/projects/${project.id}/artifacts/${artifactId}/download`,
      }],
    });
    const auditMessage = store.getProjectedAgentMessages(author.id)[0]!;
    expect(auditMessage).toMatchObject({
      artifactIds: [artifactId],
      attachments: [{ id: artifactId }],
    });
    expect(auditMessage.attachments![0]).not.toHaveProperty("unavailable");

    const managedPath = managedArtifactContentPath(dir, project.id, artifactId);
    writeFileSync(managedPath, "x");
    const corrupt = store.getConversationMessages(room.id, "main")[0]!;
    expect(corrupt.attachments).toEqual([expect.objectContaining({
      id: artifactId,
      unavailable: true,
    })]);
    expect(corrupt.attachments![0]).not.toHaveProperty("previewUrl");
    expect(corrupt.attachments![0]).not.toHaveProperty("downloadUrl");
    writeFileSync(managedPath, "png-bytes");

    expect(store.deleteProjectArtifact(project.id, artifactId, "qualification deletion")).toBe(true);
    const missing = store.getConversationMessages(room.id, "main")[0]!;
    expect(missing.attachments).toEqual([expect.objectContaining({
      id: artifactId,
      unavailable: true,
    })]);
    expect(missing.attachments![0]).not.toHaveProperty("previewUrl");
    expect(missing.attachments![0]).not.toHaveProperty("downloadUrl");
  });

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
    expect(store.readCommunicationEvents(project.id)[0]).not.toHaveProperty("artifactIds");
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

  it("preserves an agent collaborator as the visible author in the recipient audit", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const child = store.createAgent(project.id, { title: "Child", engine: "codex", conversationId: room.id });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: room.id });
    const report: CommunicationEvent = {
      eventId: "child-report", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "agent", agentId: child.id, executionId: "child-run" }, intent: "collaboration",
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
        executionId: "child-run",
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

  it("repairs a crash-torn delivery-order tail before allocating the next key", () => {
    expect(store.nextDeliveryOrderKey("2026-07-20T00:00:00.000Z")).toMatch(/0000000000000001$/);
    store.close();
    const file = join(dir, "delivery-order.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf8")}{"sequence":`, "utf8");
    store = new AgentStore(dir);
    expect(store.nextDeliveryOrderKey("2026-07-20T00:00:01.000Z")).toMatch(/0000000000000002$/);
    expect(readFileSync(file, "utf8")).toBe('{"sequence":1}\n{"sequence":2}\n');
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

  it("preserves a routing-prefixed direct-agent projection across restart replay", () => {
    const project = store.createProject({ label: "Projection replay", hostPath: "/repo" });
    const agent = store.createAgent(project.id, { title: "Audit Agent", engine: "codex" });
    const event: CommunicationEvent = {
      eventId: "event-prefixed-audit", schemaVersion: 1, projectId: project.id,
      sender: { kind: "agent", agentId: agent.id }, intent: "direct_to_user",
      audience: { kind: "user", userId: "local-operator" }, text: "Audit note",
      createdAt: "2026-07-12T00:00:00.000Z",
    };

    store.appendCommunicationEvent(event);
    store.appendCommunicationProjection(project.id, {
      eventId: event.eventId,
      surface: "direct_agent_audit",
      projectionKey: agent.id,
      projectedAt: event.createdAt,
      message: {
        messageId: "prefixed-audit-message",
        role: "assistant",
        renderedText: "#Audit-Agent Audit note",
        createdAt: event.createdAt,
      },
    });
    const stored = store.appendEvent(agent.id, {
      type: "communication_projection",
      communicationEventId: event.eventId,
      role: "assistant",
      text: event.text,
    });

    store.close();
    store = new AgentStore(dir);

    const projection = store.readCommunicationProjections(project.id).find((candidate) =>
      candidate.surface === "direct_agent_audit" && candidate.projectionKey === agent.id);
    expect(projection?.message?.renderedText).toBe("#Audit-Agent Audit note");
    expect(projection?.message?.sequence).toBe(stored.seq);

    expect(() => store.appendCommunicationProjection(project.id, {
      eventId: event.eventId,
      surface: "direct_agent_audit",
      projectionKey: agent.id,
      projectedAt: event.createdAt,
      message: {
        messageId: "conflicting-audit-message",
        role: "assistant",
        renderedText: "not-a-routing-prefix Audit note",
        createdAt: event.createdAt,
      },
    })).toThrow("communication projection metadata collision");
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

  it("fails reconciliation on runtime payload conflicts and orphan Request references", () => {
    const project = store.createProject({ label: "Integrity", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const requester = store.createAgent(project.id, { title: "Requester", engine: "codex", conversationId: room.id });
    const recipient = store.createAgent(project.id, { title: "Recipient", engine: "codex", conversationId: room.id });
    const event: CommunicationEvent = {
      eventId: "integrity-event", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "agent", agentId: requester.id, executionId: "run" }, intent: "collaboration",
      audience: { kind: "agents", agentIds: [recipient.id] }, text: "Canonical",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(event);
    store.appendConversationMessage(room.id, { text: "#recipient Canonical" }, requester.id, "collaboration", undefined, undefined, event.eventId);
    const coordination = new CoordinationV3Store(store.sqlite);
    coordination.recordRuntimeCommunication({
      id: "integrity-runtime", projectId: project.id, sender: event.sender,
      intent: event.intent, audience: event.audience, payload: event,
    });
    coordination.coordinate({
      projectId: project.id, conversationId: room.id, requesterAgentId: requester.id,
      actorScope: `agent:${requester.id}`, idempotencyKey: "integrity-request",
      requests: [{ requestId: "integrity-request", recipientAgentId: recipient.id, lifetime: { kind: "indefinite" } }],
    });
    coordination.attachRequestCommunication("integrity-request", "missing-event", project.id);
    store.sqlite.prepare(`UPDATE runtime_communications SET payload_json = ? WHERE id = 'integrity-runtime'`)
      .run(JSON.stringify({ ...event, text: "Conflicting" }));

    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      ok: false,
      orphanRequestCommunicationEventIds: ["missing-event"],
      runtimePayloadConflicts: [{
        eventId: event.eventId,
        canonicalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        runtimeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
    });
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

  it("rebuilds authoritative attachment snapshots from the dispatch ledger", () => {
    const project = store.createProject({ label: "Snapshots", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const firstEvent: CommunicationEvent = {
      eventId: "snapshot-first", schemaVersion: 1, projectId: project.id, conversationId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id }, text: "First", createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(firstEvent);
    store.appendConversationMessage(room.id, { text: "First" }, undefined, "main", undefined, undefined, firstEvent.eventId);
    const secondEvent = { ...firstEvent, eventId: "snapshot-second", text: "Second", createdAt: "2026-07-12T00:01:00.000Z" };
    store.appendCommunicationEvent(secondEvent);
    store.appendConversationMessage(room.id, {
      text: "Second",
      attachments: [{ id: "asset-1", agentId: "manager", name: "diagram.png", mediaType: "image/png", size: 42, url: "/api/assets/asset-1" }],
    }, undefined, "main", undefined, undefined, secondEvent.eventId);
    const expected = store.getConversationMessages(room.id);
    store.close();
    rmSync(communicationProjectionsPath(dir, project.id), { force: true });
    store = new AgentStore(dir);
    expect(store.getProjectedConversationMessages(room.id)).toEqual(expected);
  });

  it("keeps the original Broadcast immutable while projecting the latest append-only edit after restart", () => {
    const project = store.createProject({ label: "Revisions", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const original: CommunicationEvent = {
      eventId: "broadcast-original", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id }, text: "Original",
      createdAt: "2026-07-16T00:00:00.000Z",
    };
    store.appendCommunicationEvent(original);
    const message = store.appendConversationMessage(room.id, { text: "#broadcast Original" }, undefined, "main", undefined, undefined, original.eventId)!;
    const revisions: CommunicationRevisionEvent[] = [
      { eventId: "edit-1", schemaVersion: 1, kind: "edit", projectId: project.id, conversationId: room.id, targetEventId: original.eventId, sender: original.sender, text: "First edit", createdAt: "2026-07-16T00:01:00.000Z", idempotencyKey: "edit:1" },
      { eventId: "edit-2", schemaVersion: 1, kind: "edit", projectId: project.id, conversationId: room.id, targetEventId: original.eventId, sender: original.sender, text: "Latest edit", createdAt: "2026-07-16T00:02:00.000Z", idempotencyKey: "edit:2" },
    ];
    for (const revision of revisions) store.appendCommunicationRevision(revision);
    expect(store.getCommunicationEvent(project.id, original.eventId)).toEqual(original);
    expect(store.getConversationMessages(room.id)).toEqual([
      expect.objectContaining({ id: message.id, communicationEventId: original.eventId, text: "#broadcast Latest edit", editRevision: 2, editedAt: revisions[1]!.createdAt }),
    ]);
    expect(readFileSync(communicationRevisionsPath(dir, project.id), "utf8").trim().split("\n")).toHaveLength(2);

    store.close();
    store = new AgentStore(dir);
    expect(store.getCommunicationEvent(project.id, original.eventId)).toEqual(original);
    expect(store.getConversationMessages(room.id)[0]).toMatchObject({ id: message.id, text: "#broadcast Latest edit", editRevision: 2 });
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

  itWithManagedArtifacts("keeps bounded Team Chat pages independent of Agent file-history size", () => {
    const project = store.createProject({ label: "Team performance", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: room.id });
    const recipient = store.createAgent(project.id, { title: "Recipient", engine: "codex", conversationId: room.id });
    const executionId = "team-message-execution";
    store.appendEvent(author.id, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId });
    store.appendEvent(author.id, { type: "file_change", path: "src/large-history.ts", kind: "edit", diff: "+expensive" });
    const event: CommunicationEvent = {
      eventId: "team-performance-message", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "agent", agentId: author.id, executionId }, intent: "collaboration",
      audience: { kind: "agents", agentIds: [recipient.id] }, text: "Operational handoff",
      createdAt: "2026-07-15T02:19:10.342Z",
    };
    store.appendCommunicationEvent(event);
    store.appendConversationMessage(
      room.id,
      { role: "assistant", text: event.text },
      author.id,
      "collaboration",
      undefined,
      undefined,
      event.eventId,
    );

    expect(store.getProjectedConversationMessagePage(room.id, "collaboration", { limit: 100 }).messages)
      .toEqual([expect.objectContaining({ text: event.text, authorAgentId: author.id, executionId })]);
    expect(store.getProjectedConversationMessagePage(room.id, "collaboration", { limit: 100 }).messages[0])
      .not.toHaveProperty("fileActivity");
  });

  itWithManagedArtifacts("preserves historical messages after their agent author is deleted", () => {
    const project = store.createProject({ label: "History", hostPath: "/repo" });
    const room = store.createConversation(project.id, { title: "Room" });
    const author = store.createAgent(project.id, { title: "Former author", engine: "codex", conversationId: room.id });
    const executionId = "historical-execution";
    store.appendEvent(author.id, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId });
    store.appendEvent(author.id, { type: "file_change", path: "src/history.ts", kind: "edit", diff: "@@ -1 +1 @@\n-old\n+new\n+added" });
    const event: CommunicationEvent = {
      eventId: "historical-broadcast", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "agent", agentId: author.id, executionId }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id }, text: "Historical answer",
      createdAt: "2026-07-15T02:19:10.342Z",
    };
    store.appendCommunicationEvent(event);
    store.appendConversationMessage(room.id, { role: "assistant", text: event.text }, author.id, "main", undefined, undefined, event.eventId);
    expect(store.getProjectedConversationMessages(room.id)[0]?.fileActivity)
      .toEqual([expect.objectContaining({
        path: "src/history.ts", kind: "edit", status: "in_progress", sourceSeq: 2,
        artifactId: `${author.id}:a:2:0`, previewable: true, additions: 2, deletions: 1,
      })]);

    expect(store.deleteAgent(author.id)).toBe(true);
    expect(store.getProjectedConversationMessages(room.id)).toEqual([
      expect.objectContaining({ text: event.text, authorAgentId: author.id, executionId }),
    ]);
    expect(store.getProjectedConversationMessages(room.id)[0]).not.toHaveProperty("fileActivity");
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

describe("AgentStore — All Chat", () => {
  it("shows only messages to or from the user, deduplicates them, and pages by a stable workspace cursor", () => {
    const project = store.createProject({ label: "All Chat", hostPath: "/all-chat" });
    const room = store.createConversation(project.id, { title: "Planning" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: room.id });
    const recipient = store.createAgent(project.id, { title: "Recipient", engine: "codex", conversationId: room.id });
    const append = (event: CommunicationEvent, placements: Array<{ surface: "conversation" | "collaboration_view" | "direct_agent_audit"; key: string }>) => {
      store.appendCommunicationEvent(event);
      for (const placement of placements) store.appendCommunicationProjection(project.id, {
        eventId: event.eventId, surface: placement.surface, projectionKey: placement.key, projectedAt: event.createdAt,
        message: { messageId: `message-${event.eventId}`, role: event.sender.kind === "agent" ? "assistant" : "user", createdAt: event.createdAt },
      });
    };
    append({
      eventId: "broadcast", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id }, text: "Shared plan", createdAt: "2026-07-19T10:00:00.000Z",
    }, [{ surface: "conversation", key: room.id }]);
    append({
      eventId: "agent-update", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "agent", agentId: author.id, executionId: "run-author" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id }, text: "Agent update", createdAt: "2026-07-19T10:01:00.000Z",
    }, [{ surface: "conversation", key: room.id }, { surface: "direct_agent_audit", key: author.id }]);
    append({
      eventId: "team-note", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "agent", agentId: author.id, executionId: "run-team" }, intent: "collaboration",
      audience: { kind: "agents", agentIds: [recipient.id] }, text: "Team note", createdAt: "2026-07-19T10:02:00.000Z",
    }, [
      { surface: "collaboration_view", key: room.id },
      { surface: "direct_agent_audit", key: author.id },
      { surface: "direct_agent_audit", key: recipient.id },
    ]);
    append({
      eventId: "private-question", schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: recipient.id }, text: "Private question", createdAt: "2026-07-19T10:03:00.000Z",
    }, [{ surface: "conversation", key: room.id }, { surface: "direct_agent_audit", key: recipient.id }]);

    const recent = store.getAllChatPage({ limit: 2 });
    expect(recent.items.map((item) => item.communicationEventId)).toEqual(["agent-update", "private-question"]);
    expect(recent.items[0]).toMatchObject({
      source: { kind: "project", conversationId: room.id },
      directMessageAgent: { id: author.id, title: "Author" },
    });
    expect(recent.items[1]).toMatchObject({
      source: { kind: "project", conversationId: room.id },
      directMessageAgent: { id: recipient.id, title: "Recipient" },
    });
    expect(recent.history).toMatchObject({ limit: 2, hasMore: true, cursor: expect.any(String) });

    const older = store.getAllChatPage({ limit: 2, cursor: recent.history.cursor });
    expect(older.items.map((item) => item.communicationEventId)).toEqual(["broadcast"]);
    expect(older.items[0]?.directMessageAgent).toBeUndefined();
    expect(older.history).toEqual({ limit: 2, hasMore: false });
    expect([...recent.items, ...older.items].some((item) => item.communicationEventId === "team-note")).toBe(false);
    expect(() => store.getAllChatPage({ cursor: `${recent.history.cursor}x` })).toThrow("invalid history cursor");
  });
});

const RUN: LogEvent[] = [
  { type: "user_message", text: "Refactor authentication" },
  { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-1", wakeCause: "direct_message" },
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
  itWithManagedArtifacts("recovers artifact publication after a crash immediately following the canonical event append", () => {
    const { projectId, agentId } = seedAgent();
    store.close();
    const stored = new EventLog(eventsPath(dir, projectId, agentId)).append({
      type: "command", command: "crash-boundary", cwd: "/repo",
    });
    store = new AgentStore(dir);
    const artifactId = `${agentId}:a:${stored.seq}:0`;
    expect(store.getProjectArtifact(projectId, artifactId)).toMatchObject({
      id: artifactId, kind: "log", originAgentId: agentId, sha256: expect.any(String),
    });
    expect(readFileSync(managedArtifactContentPath(dir, projectId, artifactId), "utf8")).toContain("crash-boundary");
  });

  itWithManagedArtifacts("rebuilds a file-change artifact when the provider supplied an empty diff", () => {
    const { projectId, agentId } = seedAgent();
    store.close();
    const stored = new EventLog(eventsPath(dir, projectId, agentId)).append({
      type: "file_change", path: "unchanged.txt", kind: "edit", diff: "",
    });

    store = new AgentStore(dir);

    const artifactId = `${agentId}:a:${stored.seq}:0`;
    expect(store.getProjectArtifact(projectId, artifactId)).toMatchObject({
      id: artifactId, kind: "diff", originAgentId: agentId, sha256: expect.any(String),
    });
    expect(readFileSync(managedArtifactContentPath(dir, projectId, artifactId), "utf8"))
      .toContain("No diff text was provided by the engine.");
  });

  itWithManagedArtifacts("rebuilds every execution artifact association and retains deleted-Agent audit evidence", () => {
    const { projectId, agentId } = seedAgent();
    store.appendEvent(agentId, {
      type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-audit",
    });
    store.appendEvent(agentId, { type: "command", command: "inspect", cwd: "/repo" });
    store.appendEvent(agentId, { type: "file_change", path: "result.txt", kind: "edit", diff: "+result\n" });
    store.appendEvent(agentId, { type: "test_result", passed: true, summary: "verified" });
    store.appendEvent(agentId, { type: "tool_result", id: "tool-audit", output: "durable activity" });
    store.appendEvent(agentId, {
      type: "agent_output", executionId: "run-audit", text: "durable work log", sourceSeqStart: 2, sourceSeqEnd: 5,
    });
    const screenshot = publishManagedArtifactContent(dir, projectId, "screenshot-audit", Buffer.from("png-audit"));
    store.appendEvent(agentId, {
      type: "browser_screenshot", sessionId: "browser", executionId: "run-audit",
      artifactId: "screenshot-audit", path: "browser/screenshot-audit.png", width: 1280, height: 720,
      size: screenshot.size, sha256: screenshot.sha256,
    });
    const generated = publishManagedArtifactContent(dir, projectId, "generated-audit", Buffer.from("generated-audit"));
    store.appendEvent(agentId, {
      type: "generated_artifact", artifactId: "generated-audit", executionId: "run-audit",
      path: "generated/generated-audit.txt", sourcePath: "result.txt", name: "result.txt",
      mediaType: "text/plain", size: generated.size, sha256: generated.sha256, visibility: "project",
    });
    store.appendEvent(agentId, {
      type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-audit",
    });
    const now = new Date().toISOString();
    store.sqlite.prepare(`
      INSERT INTO provider_inputs (
        execution_id, scheduler_run_id, agent_id, project_id, provider_prompt,
        prompt_hash, source_manifest_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("run-audit", "scheduler-run-audit", agentId, projectId, "exact provider input", "a".repeat(64), "[]", now, now);

    const expectedIds = store.getProjectArtifacts(projectId).map((artifact) => artifact.id);
    store.updateProjectArtifactVisibility(projectId, "screenshot-audit", "published", true);
    expect(store.getProjectArtifacts(projectId).map((artifact) => artifact.kind).sort()).toEqual([
      "diff", "generated_file", "log", "screenshot", "test_report",
    ]);
    store.rebuildProjections();
    expect(store.getProjectArtifacts(projectId).map((artifact) => artifact.id).sort()).toEqual([...expectedIds].sort());
    expect(store.getProjectArtifact(projectId, "screenshot-audit")).toMatchObject({ visibility: "published", pinned: true });
    for (const artifact of store.getProjectArtifacts(projectId)) {
      expect(readFileSync(managedArtifactContentPath(dir, projectId, artifact.id))).toHaveLength(artifact.size!);
    }

    expect(store.deleteAgent(agentId)).toBe(true);
    expect(store.getAgent(agentId)).toBeUndefined();
    const audit = store.getAgentDetail(agentId)!;
    expect(audit.agent).toMatchObject({ id: agentId, archived: true, deletedAt: expect.any(String) });
    expect(audit.runOutput).toContainEqual(expect.objectContaining({ text: "durable work log" }));
    expect(audit.activity).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ id: "tool-audit" }) }));
    expect(audit.runs).toContainEqual(expect.objectContaining({ id: "run-audit", status: "completed" }));
    expect(store.getProviderInput("run-audit", true)).toMatchObject({ exactPrompt: "exact provider input" });
    expect(store.getProjectArtifacts(projectId).map((artifact) => artifact.id).sort()).toEqual([...expectedIds].sort());
    store.rebuildProjections();
    expect(store.getAgent(agentId)).toBeUndefined();
    expect(store.getAgentDetail(agentId)?.runOutput).toContainEqual(expect.objectContaining({ text: "durable work log" }));
  });

  it("keeps generated output under a stable artifact ID with visibility updates", () => {
    const { projectId, agentId } = seedAgent();
    const managedPath = "generated/image.png";
    const file = artifactContentPath(dir, projectId, agentId, managedPath);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "png");
    const captured = store.appendEvent(agentId, {
      type: "generated_artifact", executionId: "run-artifact", path: managedPath,
      sourcePath: "outputs/image.png", name: "image.png", mediaType: "image/png",
      size: 3, visibility: "project",
    });
    const id = `${agentId}:a:${captured.seq}:0`;
    expect(store.getArtifacts(agentId)).toContainEqual(expect.objectContaining({
      id, executionId: "run-artifact", kind: "generated_file", mediaType: "image/png",
      sourcePath: "outputs/image.png", size: 3, visibility: "project", pinned: false,
    }));
    store.appendEvent(agentId, { type: "artifact_visibility", artifactId: id, visibility: "published", pinned: true });
    expect(store.getArtifacts(agentId).find((artifact) => artifact.id === id)).toMatchObject({ visibility: "published", pinned: true });
  });

  itWithManagedArtifacts("links response file activity to the downloadable generated result instead of its diff", () => {
    const { agentId } = seedAgent();
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-generated" });
    store.appendEvent(agentId, { type: "file_change", path: "outputs/report.md", kind: "create", diff: "+report" });
    store.appendEvent(agentId, {
      type: "generated_artifact", artifactId: "generated-result", executionId: "run-generated",
      path: "generated/report.md", sourcePath: "outputs/report.md", name: "report.md",
      mediaType: "text/markdown", size: 7, visibility: "project",
    });

    expect(store.getResponseFileActivity(agentId, "run-generated", "completed")).toEqual([
      expect.objectContaining({
        path: "outputs/report.md",
        artifactId: "generated-result",
        artifactKind: "generated_file",
      }),
    ]);
  });

  itWithManagedArtifacts("projects a full run into Chat, Work log, Runs, and Artifacts", () => {
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
      fileActivity: [{
        path: "auth.ts", kind: "edit", status: "completed", sourceSeq: 7,
        artifactId: `${agentId}:a:7:0`, artifactKind: "diff", previewable: true,
      }],
    })]);
    expect(detail.activity.map((item) => item.event.type)).toEqual(["command", "tool_result", "file_change"]);
    expect(detail.changedFiles).toEqual([expect.objectContaining({
      path: "auth.ts", kind: "edit", lastSeq: 7, executionCount: 1, diffAvailable: true,
    })]);
    expect(store.getChangedFileDetail(agentId, "auth.ts")?.diff).toBe("diff --git a/auth.ts b/auth.ts\n");
    expect(detail.runs).toEqual([expect.objectContaining({
      id: "run-1", status: "completed", reason: "turn_completed", title: "Refactor authentication", wakeCause: "direct_message",
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

  it("aggregates finalized Run time without counting active or inter-Run idle wall time", () => {
    const { agentId } = seedAgent();
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-finalized-a" });
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-finalized-a" });
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-finalized-b" });
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-finalized-b" });
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-active" });
    store.sqlite.prepare("UPDATE runs SET started_at = ?, completed_at = ? WHERE id = ?")
      .run("2026-07-20T10:00:00.000Z", "2026-07-20T10:20:10.000Z", "run-finalized-a");
    store.sqlite.prepare("UPDATE runs SET started_at = ?, completed_at = ? WHERE id = ?")
      .run("2026-07-20T12:00:00.000Z", "2026-07-20T12:03:05.000Z", "run-finalized-b");
    store.sqlite.prepare("UPDATE runs SET started_at = ?, completed_at = NULL WHERE id = ?")
      .run("2026-07-20T13:00:00.000Z", "run-active");

    expect(store.getFinalizedWorkDurationMs(agentId)).toBe(23 * 60_000 + 15_000);
    expect(store.getAgentDetail(agentId, 1)?.finalizedWorkDurationMs).toBe(23 * 60_000 + 15_000);
  });

  it("returns a bounded Agent history window while retaining full canonical tool output", () => {
    const { agentId } = seedAgent();
    const largeOutput = `${"x".repeat(20_000)}-end-marker`;
    for (let index = 0; index < 3; index += 1) {
      store.appendEvent(agentId, { type: "user_message", text: `Message ${index}` });
      store.appendEvent(agentId, {
        type: "tool_result", id: `tool-${index}`, output: index === 2 ? largeOutput : `Output ${index}`,
      });
    }

    const detail = store.getAgentDetail(agentId, 2)!;
    expect(detail.history).toEqual({ limit: 2, hasMore: true });
    expect(detail.telemetryHistory?.activity).toMatchObject({ limit: 2, hasMore: true, cursor: expect.any(String) });
    expect(detail.messages.map((message) => message.text)).toEqual(["Message 1", "Message 2"]);
    expect(detail.activity).toHaveLength(2);
    expect(detail.activity.at(-1)?.event).toMatchObject({
      type: "tool_result",
      output: expect.not.stringContaining("end-marker"),
    });
    expect(detail.activity.at(-1)?.outputPreview).toMatchObject({
      truncated: true,
      totalUtf8Bytes: Buffer.byteLength(largeOutput),
      retrievalUrl: expect.stringContaining(`/activity/${detail.activity.at(-1)!.seq}/output`),
    });
    expect(store.getActivityOutput(agentId, detail.activity.at(-1)!.seq)).toMatchObject({
      output: largeOutput,
      sha256: detail.activity.at(-1)!.outputPreview!.sha256,
    });
    expect(Buffer.byteLength(JSON.stringify(detail), "utf8")).toBeLessThan(12_000);
    expect(store.readEvents(agentId).find((item) => item.event.type === "tool_result" && item.event.id === "tool-2")?.event)
      .toMatchObject({ output: largeOutput });

    const older = store.getActivityPage(agentId, { limit: 2, cursor: detail.telemetryHistory!.activity!.cursor });
    expect(older.items.map((item) => item.event.type === "tool_result" ? item.event.id : item.id)).toEqual(["tool-0"]);
    expect(older.history).toEqual({ limit: 2, hasMore: false });
    const focused = store.getActivityPage(agentId, { limit: 2, focusId: older.items[0]!.id });
    expect(focused.items.map((item) => item.event.type === "tool_result" ? item.event.id : item.id)).toEqual(["tool-0"]);
    expect(() => store.getActivityPage(agentId, { limit: 2, focusId: `${agentId}:runOutput:${older.items[0]!.seq}` }))
      .toThrow("invalid history focus");
    expect(() => store.getRunPage(agentId, { limit: 2, cursor: detail.telemetryHistory!.activity!.cursor }))
      .toThrow("invalid history cursor");
  });

  itWithManagedArtifacts("reads long-history context, activity, files, and managed artifacts from bounded projections", () => {
    const { projectId, agentId } = seedAgent();
    const tiedAt = "2026-07-19T00:00:00.000Z";
    store.setImportedHistory(agentId, "large import", Array.from({ length: 12 }, (_, index) => ({
      role: "system" as const,
      text: `import-${String(index).padStart(2, "0")}`,
      createdAt: tiedAt,
    })));
    const firstImported = store.getImportedHistoryMessagePage(agentId, { limit: 5 });
    expect(firstImported.items.map((message) => message.text)).toEqual([
      "[Imported private context]\nimport-11",
      "[Imported private context]\nimport-10",
      "[Imported private context]\nimport-09",
      "[Imported private context]\nimport-08",
      "[Imported private context]\nimport-07",
    ]);
    expect(firstImported.hasMore).toBe(true);
    const importedBoundary = firstImported.items.at(-1)!;
    expect(store.getImportedHistoryMessagePage(agentId, {
      limit: 5,
      before: { createdAt: importedBoundary.createdAt, id: importedBoundary.id },
    }).items[0]?.text).toContain("import-06");

    store.appendEvent(agentId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-long" });
    const tool = store.appendEvent(agentId, { type: "tool_result", id: "large-tool", output: `${"x".repeat(20_000)}-exact` });
    store.appendEvent(agentId, { type: "file_change", path: "src/large.ts", kind: "edit", diff: "+".repeat(20_000) });
    store.sqlite.prepare("UPDATE events SET payload_json = ? WHERE agent_id = ? AND seq = ?")
      .run('{"type":"tool_result","id":"poisoned","output":"poisoned"}', agentId, tool.seq);
    const activity = store.getActivityPage(agentId, { limit: 10 });
    expect(activity.items.find((item) => item.seq === tool.seq)).toMatchObject({
      event: { type: "tool_result", id: "large-tool", output: expect.not.stringContaining("exact") },
      outputPreview: { totalUtf8Bytes: 20_006, sha256: expect.any(String) },
    });
    expect(store.getChangedFilePage(agentId, { limit: 10 }).items).toEqual([expect.objectContaining({
      path: "src/large.ts", executionCount: 1, diffAvailable: true,
    })]);
    expect(store.getChangedFileDetail(agentId, "src/large.ts")).toMatchObject({
      executionIds: ["run-long"], diff: expect.not.stringContaining("+".repeat(5_000)),
    });

    const artifact = {
      id: "managed-long-history", projectId, agentId, originAgentId: agentId, executionId: "run-long",
      kind: "generated_file" as const, path: "generated/managed-long-history.txt", sourcePath: "managed.txt",
      summary: "managed.txt", createdAt: tiedAt, mediaType: "text/plain", visibility: "published" as const,
      pinned: true, size: 4, sha256: "a".repeat(64),
    };
    store.recordProjectArtifact(artifact);
    renameSync(managedArtifactsLogPath(dir, projectId), `${managedArtifactsLogPath(dir, projectId)}.offline`);
    expect(store.getProjectArtifactPage(projectId, { limit: 5 }).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: artifact.id, visibility: "published", pinned: true }),
    ]));
    expect(store.getProjectContextArtifacts(projectId)).toEqual([
      expect.objectContaining({ id: artifact.id }),
    ]);
    expect(existsSync(importedAgentHistoryPath(dir, projectId, agentId))).toBe(true);
  });

  it("preserves private managed-artifact identity and access across projection rebuilds", () => {
    const project = store.createProject({ label: "Private artifacts", hostPath: "/private-artifacts" });
    const sender = store.createAgent(project.id, { title: "Sender", engine: "codex" });
    const recipient = store.createAgent(project.id, { title: "Recipient", engine: "codex" });
    const unrelated = store.createAgent(project.id, { title: "Unrelated", engine: "codex" });
    const otherProject = store.createProject({ label: "Other", hostPath: "/other" });
    const outsider = store.createAgent(otherProject.id, { title: "Outsider", engine: "codex" });
    const artifact = {
      id: "private-managed-artifact",
      projectId: project.id,
      agentId: sender.id,
      originAgentId: sender.id,
      executionId: "run-private",
      kind: "generated_file" as const,
      path: "generated/private.txt",
      sourcePath: "private.txt",
      summary: "private.txt",
      createdAt: "2026-07-26T12:00:00.000Z",
      mediaType: "text/plain",
      visibility: "project" as const,
      pinned: false,
      size: 7,
      sha256: "b".repeat(64),
    };
    const access = {
      ownerKind: "communication" as const,
      ownerId: "communication-private",
      audience: {
        kind: "user_agent" as const,
        userId: "local-operator",
        agentId: recipient.id,
      },
      senderAgentId: sender.id,
    };

    store.recordProjectArtifact(artifact, access);
    store.recordProjectArtifact(artifact, access);

    const assertPrivateAccess = () => {
      expect(store.getProjectArtifactAccess(project.id, artifact.id)).toEqual(access);
      expect(store.projectArtifactIsOrganizationVisible(project.id, artifact.id)).toBe(false);
      expect(store.operatorCanReadProjectArtifact(project.id, artifact.id)).toBe(true);
      expect(store.agentCanReadProjectArtifact(project.id, artifact.id, sender.id)).toBe(true);
      expect(store.agentCanReadProjectArtifact(project.id, artifact.id, recipient.id)).toBe(true);
      expect(store.agentCanReadProjectArtifact(project.id, artifact.id, unrelated.id)).toBe(false);
      expect(store.agentCanReadProjectArtifact(project.id, artifact.id, outsider.id)).toBe(false);
      expect(store.getProjectContextArtifacts(project.id)).toEqual([]);
    };

    assertPrivateAccess();
    expect(() => store.recordProjectArtifact({ ...artifact, summary: "changed.txt" }, access))
      .toThrow("managed artifact identity and provenance are immutable");
    expect(() => store.recordProjectArtifact(artifact, { ...access, ownerId: "changed-owner" }))
      .toThrow("managed artifact identity and provenance are immutable");

    store.rebuildProjections();
    assertPrivateAccess();
  });

  it("serves 50-Agent health heads and reconnect tails without reopening canonical JSONL", () => {
    const project = store.createProject({ label: "Large team", hostPath: "/large-team" });
    const team = Array.from({ length: 50 }, (_, index) =>
      store.createAgent(project.id, { title: `Agent ${index}`, engine: "codex" }));
    for (const [index, agent] of team.entries()) {
      for (let seq = 0; seq < 20; seq += 1) {
        store.appendEvent(agent.id, { type: "session", sessionId: `session-${index}-${seq}` });
      }
      store.appendEvent(agent.id, {
        type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: `run-${index}`,
      });
      renameSync(eventsPath(dir, project.id, agent.id), `${eventsPath(dir, project.id, agent.id)}.offline`);
    }

    for (const [index, agent] of team.entries()) {
      expect(store.lastSeqOf(agent.id)).toBe(21);
      expect(store.latestHealthObservation(agent.id)).toMatchObject({ status: "idle", reason: "turn_completed" });
      expect(store.readEventsSince(agent.id, 20)).toEqual([
        expect.objectContaining({ seq: 21, event: expect.objectContaining({ executionId: `run-${index}` }) }),
      ]);
    }
  }, 20_000);

  itWithManagedArtifacts("keyset-pages page N of many files and bounds normalized execution provenance", () => {
    const { agentId } = seedAgent();
    for (let index = 0; index < 240; index += 1) {
      store.appendEvent(agentId, { type: "file_change", path: `src/file-${String(index).padStart(3, "0")}.ts`, kind: "edit", diff: `+${index}` });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = store.getChangedFilePage(agentId, { limit: 17, cursor });
      seen.push(...page.items.map((file) => file.path));
      cursor = page.history.cursor;
    } while (cursor);
    expect(seen).toHaveLength(240);
    expect(new Set(seen).size).toBe(240);

    for (let index = 0; index < 150; index += 1) {
      store.appendEvent(agentId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: `provenance-${index}` });
      store.appendEvent(agentId, { type: "file_change", path: "src/shared.ts", kind: "edit", diff: `+${index}` });
    }
    expect(store.getChangedFileDetail(agentId, "src/shared.ts")).toMatchObject({
      executionCount: 150,
      provenanceTruncated: true,
      executionIds: expect.arrayContaining(["provenance-149"]),
    });
    expect(store.getChangedFileDetail(agentId, "src/shared.ts")?.executionIds).toHaveLength(100);
  }, 20_000);

  it("uses the deduplicated All Chat keyset index without window ranking or a temp sort", () => {
    const project = store.createProject({ label: "Feed plan", hostPath: "/feed-plan" });
    const room = store.createConversation(project.id, { title: "Feed" });
    const plan = store.sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT search.row_key
      FROM all_chat_feed_projection feed
      JOIN chat_search_messages search ON search.row_key = feed.row_key
      WHERE feed.order_key < ? OR (feed.order_key = ? AND feed.row_key < ?)
      ORDER BY feed.order_key DESC, feed.row_key DESC
      LIMIT ?
    `).all("z", "z", "z", 51) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("idx_all_chat_feed_keyset");
    expect(details).not.toContain("TEMP B-TREE");
    expect(details).not.toContain("CO-ROUTINE");
    expect(room.id).toBeTruthy();
  });

  itWithManagedArtifacts("resolves stable focused items across every Agent telemetry stream", () => {
    const { agentId } = seedAgent();
    for (const event of RUN) store.appendEvent(agentId, event);
    store.appendEvent(agentId, {
      type: "work_item_update", workItemId: "review", status: "in_progress",
      title: "Review the result", executionId: "run-1",
    });
    const detail = store.getAgentDetail(agentId)!;

    expect(store.getRunOutputPage(agentId, { limit: 1, focusId: detail.runOutput[0]!.id }).items[0]?.id)
      .toBe(detail.runOutput[0]!.id);
    expect(store.getActivityPage(agentId, { limit: 1, focusId: detail.activity[0]!.id }).items[0]?.id)
      .toBe(detail.activity[0]!.id);
    expect(store.getRunPage(agentId, { limit: 1, focusId: detail.runs[0]!.id }).items[0]?.id)
      .toBe(detail.runs[0]!.id);
    expect(store.getWorkItemPage(agentId, { limit: 1, focusId: detail.workItems[0]!.id }).items[0]?.id)
      .toBe(detail.workItems[0]!.id);
    expect(store.getArtifactPage(agentId, { limit: 1, focusId: detail.artifacts[0]!.id }).items[0]?.id)
      .toBe(detail.artifacts[0]!.id);
  });

  itWithManagedArtifacts("rebuilds usage per run and aggregates agent, project, and overall with honest coverage", () => {
    const { projectId, agentId } = seedAgent();
    const unmetered = store.createAgent(projectId, { title: "Legacy", engine: "codex" });
    const otherProject = store.createProject({ label: "Other", hostPath: "/other" });
    const other = store.createAgent(otherProject.id, { title: "Other", engine: "claude" });

    for (const event of RUN) store.appendEvent(agentId, event);
    const now = "2026-07-19T12:00:00.000Z";
    store.sqlite.prepare(`
      INSERT INTO scheduler_runs (
        id, project_id, agent_id, status, lease_owner, lease_expires_at, fencing_token,
        prompt_injection_state, heartbeat_at, created_at, updated_at, started_at, terminal_at
      ) VALUES (?, ?, ?, 'completed', 'test-worker', ?, 1, 'injected', ?, ?, ?, ?, ?)
    `).run("run-1", projectId, agentId, now, now, now, now, now, now);
    for (const [id, kind] of [["activation-human-1", "human_message"], ["activation-human-2", "human_message"], ["activation-outcome", "coordination_outcome"]] as const) {
      store.sqlite.prepare(`
        INSERT INTO agent_activations (
          id, project_id, agent_id, kind, priority, dispatch_policy, prompt_class, state,
          dedupe_key, payload_json, available_at, created_at, updated_at, consumed_at
        ) VALUES (?, ?, ?, ?, 1, 'next_run', 'ordinary', 'consumed', ?, '{}', ?, ?, ?, ?)
      `).run(id, projectId, agentId, kind, id, now, now, now, now);
      store.sqlite.prepare(`
        INSERT INTO scheduler_run_activations (run_id, activation_id, attached_at, consumed_at)
        VALUES ('run-1', ?, ?, ?)
      `).run(id, now, now);
    }
    store.appendEvent(unmetered.id, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "legacy-run" });
    store.appendEvent(unmetered.id, { type: "turn_done", executionId: "legacy-run" });
    store.appendEvent(unmetered.id, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "legacy-run" });
    store.appendEvent(other.id, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "other-run" });
    store.appendEvent(other.id, { type: "turn_done", executionId: "other-run", usage: { inputTokens: 20, cachedInputTokens: 8, outputTokens: 7, reasoningOutputTokens: 3, totalTokens: 27 } });
    store.appendEvent(other.id, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "other-run" });

    expect(store.getTokenUsage({ type: "agent", id: agentId })).toMatchObject({
      totalTokens: 15, finalizedRuns: 1, reportedRuns: 1, coverage: 1,
      wakeCauses: [
        { cause: "human_message", runs: 1, activations: 2 },
        { cause: "coordination_outcome", runs: 1, activations: 1 },
      ],
    });
    expect(store.getTokenUsage({ type: "project", id: projectId })).toMatchObject({ totalTokens: 15, finalizedRuns: 2, reportedRuns: 1, unreportedRuns: 1, coverage: 0.5 });
    expect(store.getTokenUsage({ type: "overall" })).toMatchObject({
      inputTokens: 30, cachedInputTokens: 8, outputTokens: 12, reasoningOutputTokens: 3,
      totalTokens: 42, finalizedRuns: 3, reportedRuns: 2,
      wakeCauses: expect.arrayContaining([
        { cause: "human_message", runs: 1, activations: 2 },
        { cause: "coordination_outcome", runs: 1, activations: 1 },
        { cause: "other", runs: 2, activations: 2 },
      ]),
    });
    expect(store.getTokenUsage({ type: "overall" }).wakeCauses).toHaveLength(3);
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

  it("rebuilds durable Run output from canonical text deltas without publishing Chat messages", () => {
    const { agentId } = seedAgent();
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-1" });
    store.appendEvent(agentId, { type: "text", delta: "transient response", executionId: "run-1" });
    store.appendEvent(agentId, { type: "turn_done" });
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-1" });

    store.close();
    store = new AgentStore(dir);
    const detail = store.getAgentDetail(agentId)!;
    expect(detail.messages).toEqual([]);
    expect(detail.runOutput).toEqual([
      expect.objectContaining({
        agentId,
        executionId: "run-1",
        kind: "response",
        text: "transient response",
        completed: true,
      }),
    ]);
    expect(detail.runs).toEqual([expect.objectContaining({ id: "run-1", status: "completed" })]);
  });

  it("returns complete Run output text when the bounded timeline preview is truncated", () => {
    const { agentId } = seedAgent();
    const text = `${"response block ".repeat(3_000)}tail`;
    store.appendEvent(agentId, {
      type: "text",
      delta: text,
      executionId: "run-large-output",
    });

    const output = store.getRunOutputs(agentId)[0]!;
    expect(output.textPreview).toMatchObject({
      truncated: true,
      previewUtf8Bytes: 32 * 1_024,
      totalUtf8Bytes: Buffer.byteLength(text),
    });
    expect(output.text).toHaveLength(32 * 1_024);
    expect(store.getRunOutputText(agentId, output.seq)).toEqual({
      agentId,
      runOutputId: output.id,
      seq: output.seq,
      text,
      totalUtf8Bytes: Buffer.byteLength(text),
    });
  });

  it("rejects Run output retrieval above the canonical 8 MiB boundary", () => {
    const { agentId } = seedAgent();
    store.appendEvent(agentId, {
      type: "text",
      delta: "x".repeat(8 * 1_024 * 1_024 + 1),
      executionId: "run-output-over-limit",
    });

    const output = store.getRunOutputs(agentId)[0]!;
    expect(() => store.getRunOutputText(agentId, output.seq)).toThrowError(
      "run output segment exceeds the 8 MiB retrieval limit",
    );
  });

  itWithManagedArtifacts("rebuilds chronological activity and per-file execution history after restart", () => {
    const { agentId } = seedAgent();
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-a" });
    store.appendEvent(agentId, { type: "command", command: "pnpm test", cwd: "/repo" });
    store.appendEvent(agentId, { type: "file_change", path: "src/a.ts", kind: "create", diff: "+first" });
    store.appendEvent(agentId, { type: "agent_output", executionId: "run-a", text: "First", sourceSeqStart: 2, sourceSeqEnd: 3 });
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-a" });
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-b" });
    store.appendEvent(agentId, { type: "test_result", passed: true, summary: "unit tests" });
    store.appendEvent(agentId, { type: "file_change", path: "src/a.ts", kind: "edit", diff: "+second" });
    store.appendEvent(agentId, { type: "agent_output", executionId: "run-b", text: "Second", sourceSeqStart: 6, sourceSeqEnd: 7 });
    store.appendEvent(agentId, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-b" });

    store.close();
    store = new AgentStore(dir);
    const detail = store.getAgentDetail(agentId)!;
    expect(detail.activity.map(({ executionId, event }) => [executionId, event.type])).toEqual([
      ["run-a", "command"], ["run-a", "file_change"], ["run-b", "test_result"], ["run-b", "file_change"],
    ]);
    expect(detail.changedFiles).toEqual([expect.objectContaining({
      path: "src/a.ts", kind: "edit", executionCount: 2, diffAvailable: true,
    })]);
    expect(store.getChangedFileDetail(agentId, "src/a.ts")).toMatchObject({
      diff: "+second", executionIds: ["run-b", "run-a"], provenanceTruncated: false,
    });
    expect(detail.runOutput.map((entry) => entry.fileActivity)).toEqual([
      [expect.objectContaining({ path: "src/a.ts", kind: "create", sourceSeq: 3, additions: 1 })],
      [expect.objectContaining({ path: "src/a.ts", kind: "edit", sourceSeq: 8, additions: 1 })],
    ]);
  });

  itWithManagedArtifacts("assigns monotonic per-agent seq and is append-only (readSince works)", () => {
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
    expect(store.resumeSessionState(agentId)).toEqual({
      sessionId: "stale-session", artifactIds: [],
    });
    store.appendEvent(agentId, {
      type: "session_snapshot",
      sessionId: "stale-session",
      toolContractHash: "contract-a",
      artifactIds: ["artifact-b", "artifact-a", "artifact-b"],
    });
    expect(store.resumeSessionState(agentId)).toEqual({
      sessionId: "stale-session",
      toolContractHash: "contract-a",
      artifactIds: ["artifact-a", "artifact-b"],
    });
    store.rebuildProjections();
    expect(store.resumeSessionState(agentId)).toEqual({
      sessionId: "stale-session",
      toolContractHash: "contract-a",
      artifactIds: ["artifact-a", "artifact-b"],
    });
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

  it("rebuilds and consumes one bounded continuation handoff from canonical events", () => {
    const { agentId } = seedAgent();
    store.appendEvent(agentId, {
      type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-before-rollover",
    });
    store.appendEvent(agentId, {
      type: "continuation_handoff",
      handoffId: "handoff-1",
      executionId: "run-before-rollover",
      text: "Continue from the verified state.",
    });
    expect(store.continuationHandoffForRun(agentId, "run-before-rollover")).toMatchObject({
      id: "handoff-1", text: "Continue from the verified state.",
    });
    expect(store.pendingContinuationHandoff(agentId)).toBeUndefined();
    store.appendEvent(agentId, {
      type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-before-rollover",
    });
    expect(store.pendingContinuationHandoff(agentId)?.id).toBe("handoff-1");

    store.rebuildProjections();
    expect(store.pendingContinuationHandoff(agentId)?.id).toBe("handoff-1");
    expect(store.consumeContinuationHandoff(agentId, "handoff-1", "run-after-rollover")).toBe(true);
    expect(store.pendingContinuationHandoff(agentId)).toBeUndefined();
    expect(store.consumeContinuationHandoff(agentId, "handoff-1", "run-after-rollover")).toBe(false);

    store.rebuildProjections();
    expect(store.pendingContinuationHandoff(agentId)).toBeUndefined();
    expect(store.continuationHandoffForRun(agentId, "run-before-rollover")?.consumedAt).toBeTruthy();

    store.appendEvent(agentId, {
      type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "failed-rollover-run",
    });
    store.appendEvent(agentId, {
      type: "continuation_handoff",
      handoffId: "handoff-from-failed-run",
      executionId: "failed-rollover-run",
      text: "This must never seed a successor.",
    });
    store.appendEvent(agentId, {
      type: "agent_lifecycle", status: "failed", reason: "runtime_error", executionId: "failed-rollover-run",
    });
    expect(store.pendingContinuationHandoff(agentId)).toBeUndefined();
    store.rebuildProjections();
    expect(store.pendingContinuationHandoff(agentId)).toBeUndefined();
  });
});

describe("AgentStore — rebuild is byte-identical (the property)", () => {
  itWithManagedArtifacts("wiping SQLite and rebuilding from the logs yields identical rows", () => {
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

  itWithManagedArtifacts("rebuild reconstructs projections after a total SQLite loss", () => {
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

  itWithManagedArtifacts("catches a stale SQLite projection up automatically on restart", () => {
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

  it("persists explicit descendant-management permissions through projection rebuild", () => {
    const project = store.createProject({ label: "Permissions", hostPath: "/repo" });
    const manager = store.createAgent(project.id, {
      title: "Manager",
      engine: "codex",
      managementPermissions: {
        allowAutomaticDescendantDeletion: true,
        allowAutomaticDescendantReorganization: true,
      },
    });
    expect(manager.managementPermissions).toEqual({
      allowAutomaticDescendantDeletion: true,
      allowAutomaticDescendantReorganization: true,
    });
    store.rebuildProjections();
    expect(store.getAgent(manager.id)?.managementPermissions).toEqual(manager.managementPermissions);
    store.updateAgent(manager.id, { managementPermissions: {
      allowAutomaticDescendantDeletion: false,
      allowAutomaticDescendantReorganization: false,
    } });
    expect(JSON.parse(readFileSync(join(agentDir(dir, project.id, manager.id), "agent.json"), "utf8")).managementPermissions)
      .toEqual({ allowAutomaticDescendantDeletion: false, allowAutomaticDescendantReorganization: false });
    expect(() => store.updateAgent(manager.id, { managementPermissions: {
      allowAutomaticDescendantDeletion: "false",
      allowAutomaticDescendantReorganization: false,
    } as unknown as import("@ponderosa/core").AgentManagementPermissionsDto })).toThrow("exact boolean");
    expect(store.getAgent(manager.id)?.managementPermissions.allowAutomaticDescendantDeletion).toBe(false);
    expect(readdirSync(agentDir(dir, project.id, manager.id)).some((name) => name.endsWith(".json.tmp"))).toBe(false);
    store.rebuildProjections();
    expect(store.getAgent(manager.id)?.managementPermissions.allowAutomaticDescendantDeletion).toBe(false);
  });

  it("rejects stale deletion previews after spawn or reparent without deleting any Agent", () => {
    const project = store.createProject({ label: "Atomic deletion", hostPath: "/repo" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex" });
    const child = store.createAgent(project.id, { title: "Child", engine: "codex", managerAgentId: manager.id });
    const outside = store.createAgent(project.id, { title: "Outside", engine: "codex" });

    const beforeSpawn = store.previewAgentDeletion([manager.id]);
    const lateChild = store.createAgent(project.id, { title: "Late child", engine: "codex", managerAgentId: child.id });
    expect(() => store.deleteAgentSubtrees(beforeSpawn.rootAgentIds, beforeSpawn.previewHash))
      .toThrow(AgentDeletionConflictError);
    expect(store.getAgent(manager.id)).toBeDefined();
    expect(store.getAgent(child.id)).toBeDefined();
    expect(store.getAgent(lateChild.id)).toBeDefined();

    const beforeReparent = store.previewAgentDeletion([manager.id]);
    store.updateAgentOrganization(child.id, { managerAgentId: outside.id });
    expect(() => store.deleteAgentSubtrees(beforeReparent.rootAgentIds, beforeReparent.previewHash))
      .toThrow(AgentDeletionConflictError);
    expect(store.getAgent(manager.id)).toBeDefined();
    expect(store.getAgent(child.id)?.managerAgentId).toBe(outside.id);

    const current = store.previewAgentDeletion([manager.id]);
    expect(store.deleteAgentSubtrees(current.rootAgentIds, current.previewHash).affectedAgents.map((agent) => agent.id))
      .toEqual([manager.id]);
    expect(store.getAgent(manager.id)).toBeUndefined();
    expect(store.getAgent(child.id)).toBeDefined();
  });

  it("restores pre-commit deletion renames and finishes committed deletion journals after restart", () => {
    const project = store.createProject({ label: "Deletion recovery", hostPath: "/repo" });
    const restored = store.createAgent(project.id, { title: "Restore me", engine: "codex" });
    const restoredName = `.${restored.id}.deleting-before-commit`;
    const restoredTombstone = join(agentsDir(dir, project.id), restoredName);
    renameSync(agentDir(dir, project.id, restored.id), restoredTombstone);
    store.close();

    store = new AgentStore(dir);
    expect(store.getAgent(restored.id)).toBeDefined();
    expect(existsSync(agentDir(dir, project.id, restored.id))).toBe(true);
    expect(existsSync(restoredTombstone)).toBe(false);

    const deleted = store.createAgent(project.id, { title: "Finish deletion", engine: "codex" });
    const deletedName = `.${deleted.id}.deleting-after-commit`;
    const deletedTombstone = join(agentsDir(dir, project.id), deletedName);
    renameSync(agentDir(dir, project.id, deleted.id), deletedTombstone);
    store.sqlite.transaction(() => {
      store.sqlite.prepare(`INSERT INTO agent_deletion_tombstones (agent_id, project_id, tombstone_name, created_at) VALUES (?, ?, ?, ?)`)
        .run(deleted.id, project.id, deletedName, new Date().toISOString());
      store.sqlite.prepare(`DELETE FROM agents WHERE id = ?`).run(deleted.id);
    })();
    store.close();

    store = new AgentStore(dir);
    expect(store.getAgent(deleted.id)).toBeUndefined();
    expect(store.getAgentDetail(deleted.id)?.agent).toMatchObject({
      id: deleted.id, archived: true, deletedAt: expect.any(String),
    });
    expect(existsSync(agentDir(dir, project.id, deleted.id))).toBe(true);
    expect(existsSync(deletedTombstone)).toBe(false);
    expect(store.sqlite.prepare(`SELECT COUNT(*) AS count FROM agent_deletion_tombstones`).get()).toEqual({ count: 0 });
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

    expect(store.updateAgent(agent.id, {
      activeEngine: "claude",
      model: "claude-sonnet",
      effort: "high",
    })).toMatchObject({
      activeEngine: "claude",
      model: "claude-sonnet",
      effort: "high",
    });
    expect(JSON.parse(readFileSync(join(agentDir(dir, project.id, agent.id), "agent.json"), "utf8"))).toMatchObject({
      activeEngine: "claude",
      model: "claude-sonnet",
      effort: "high",
    });
    store.rebuildProjections();

    expect(store.getAgent(agent.id)).toMatchObject({
      activeEngine: "claude",
      model: "claude-sonnet",
      effort: "high",
    });
    expect(store.updateAgent(agent.id, { model: null, effort: null })).toMatchObject({
      activeEngine: "claude",
      model: undefined,
      effort: undefined,
    });
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

  it("repairs a crash-torn preset tail on restart and accepts a later durable update", () => {
    const project = store.createProject({ label: "Preset recovery", hostPath: "/repo" });
    const file = agentPresetsPath(dir, project.id);
    store.close();
    writeFileSync(file, `${readFileSync(file, "utf8")}{"type":"upsert","preset":`, "utf8");

    store = new AgentStore(dir);
    expect(store.listAgentPresets(project.id)).toHaveLength(4);
    const added = store.createAgentPreset(project.id, {
      name: "Recovered", description: "Recovered safely", guidance: "Continue after restart.", engine: "codex",
    });
    store.rebuildProjections();
    expect(store.getAgentPreset(added.id)?.name).toBe("Recovered");
    expect(readFileSync(file, "utf8")).not.toContain('"preset":\n');
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
    expect(store.updateProject(project.id, { label: "After", instructions: "Project rule" })).toMatchObject({ label: "After", instructions: "Project rule" });
    expect(store.updateProject(project.id, { instructions: "" })).not.toHaveProperty("instructions");
    expect(JSON.parse(readFileSync(projectJsonPath(dir, project.id), "utf8"))).toMatchObject({ label: "After", hostPath: "/repo" });
    store.rebuildProjections();
    expect(store.getProject(project.id)?.label).toBe("After");
  });

  it("persists Project deletion quarantine until the Project purge commits", () => {
    const project = store.createProject({ label: "Pending deletion", hostPath: "/repo" });
    store.markProjectDeletionPending(project.id, "2026-07-20T00:00:00.000Z");
    store.recordProjectDeletionCleanupError(project.id, "browser cleanup pending");
    store.close();
    store = new AgentStore(dir);

    expect(store.listPendingProjectDeletions()).toEqual([{
      projectId: project.id,
      createdAt: "2026-07-20T00:00:00.000Z",
      lastError: "browser cleanup pending",
    }]);
    expect(store.deleteProject(project.id)).toBe(true);
    expect(store.listPendingProjectDeletions()).toEqual([]);
  });

  it("recovers a rename-before-purge crash and purges V3 state only on the successful retry", () => {
    const project = store.createProject({ label: "Crash-safe deletion", hostPath: "/repo" });
    const conversation = store.getConversation(project.lastConversationId!)!;
    const agent = store.createAgent(project.id, {
      title: "Trigger owner", engine: "codex", conversationId: conversation.id,
    });
    const coordination = new CoordinationV3Store(store.sqlite);
    coordination.createTriggerDefinition({
      id: "deletion-crash-trigger", projectId: project.id, conversationId: conversation.id,
      agentId: agent.id, name: "Retained until commit", instructions: "Run later",
      sourceKind: "webhook", sourceConfig: { replayWindowSeconds: 300 }, enabled: false,
    });
    store.markProjectDeletionPending(project.id, "2026-07-20T01:00:00.000Z");
    const tombstoneName = `.${project.id}.deleting-crash-window`;
    store.sqlite.prepare(`UPDATE project_deletion_pending SET tombstone_name = ? WHERE project_id = ?`)
      .run(tombstoneName, project.id);
    renameSync(projectDir(dir, project.id), join(dir, "projects", tombstoneName));
    const committedCleanup = join(dir, "projects", ".already-committed.deleting-cleanup");
    mkdirSync(committedCleanup);
    writeFileSync(join(committedCleanup, "stale"), "committed");
    store.close();

    store = new AgentStore(dir);
    expect(existsSync(projectDir(dir, project.id))).toBe(true);
    expect(existsSync(join(dir, "projects", tombstoneName))).toBe(false);
    expect(existsSync(committedCleanup)).toBe(false);
    expect(store.listPendingProjectDeletions()).toEqual([{
      projectId: project.id, createdAt: "2026-07-20T01:00:00.000Z",
    }]);
    expect(new CoordinationV3Store(store.sqlite).getTriggerDefinition("deletion-crash-trigger")).toBeDefined();

    const restartedCoordination = new CoordinationV3Store(store.sqlite);
    expect(store.deleteProject(project.id, (projectId) => restartedCoordination.purgeProject(projectId))).toBe(true);
    expect(store.listPendingProjectDeletions()).toEqual([]);
    expect(restartedCoordination.getTriggerDefinition("deletion-crash-trigger")).toBeUndefined();
    expect(existsSync(projectDir(dir, project.id))).toBe(false);
  });

  it("retains a committed Project deletion receipt across restart and finishes its tombstone cleanup", () => {
    const project = store.createProject({ label: "Committed receipt", hostPath: "/repo" });
    const receipt = store.commitProjectDeletion(project.id)!;

    expect(store.getProject(project.id)).toBeUndefined();
    expect(store.getProjectDeletionReceipt(project.id)).toMatchObject({
      projectId: project.id,
      tombstoneName: receipt.tombstoneName,
      storageCleanupCompleted: false,
    });
    expect(existsSync(join(dir, "projects", receipt.tombstoneName))).toBe(true);
    store.close();

    store = new AgentStore(dir);
    expect(store.getProject(project.id)).toBeUndefined();
    expect(store.getProjectDeletionReceipt(project.id)).toMatchObject({
      projectId: project.id,
      tombstoneName: receipt.tombstoneName,
      storageCleanupCompleted: true,
      completedAt: expect.any(String),
    });
    expect(existsSync(join(dir, "projects", receipt.tombstoneName))).toBe(false);
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
