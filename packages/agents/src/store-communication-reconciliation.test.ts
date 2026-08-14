import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AgentStore } from "./store.js";

const stores: AgentStore[] = [];
const directories: string[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("communication reconciliation", () => {
  test("ignores display enrichment and recipient order but rejects authored payload drift", () => {
    const root = mkdtempSync(join(tmpdir(), "ponderosa-communication-reconciliation-"));
    directories.push(root);
    const dataDir = join(root, "data");
    const hostPath = join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const store = new AgentStore(dataDir);
    stores.push(store);
    const project = store.createProject({
      label: "Communication reconciliation",
      hostPath,
      defaultEngine: "codex",
    });
    const conversationId = project.lastConversationId!;
    const eventId = "runtime-communication-reconciliation";
    const createdAt = "2026-08-12T00:00:00.000Z";
    const runtimePayload = {
      schemaVersion: 2 as const,
      eventId,
      projectId: project.id,
      conversationId,
      sender: { kind: "user" as const, userId: "local-user" },
      intent: "broadcast" as const,
      audience: { kind: "organization" as const, organizationId: project.id },
      text: "Canonical communication content",
      createdAt,
    };
    store.appendCommunicationEvent({
      ...runtimePayload,
      identity: {
        senderLabel: "Patrick",
        conversationLabel: "New Chat",
      },
    });
    store.appendConversationMessage(
      conversationId,
      { role: "user", text: runtimePayload.text },
      undefined,
      "main",
      undefined,
      undefined,
      eventId,
    );
    store.sqlite.prepare(`
      INSERT INTO runtime_communications(
        id, project_id, sender_json, intent, audience_json, payload_json,
        payload_hash, actionable, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      "runtime-row",
      project.id,
      JSON.stringify(runtimePayload.sender),
      runtimePayload.intent,
      JSON.stringify(runtimePayload.audience),
      JSON.stringify({ communication: runtimePayload }),
      "test-hash",
      createdAt,
    );

    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      ok: true,
      runtimePayloadConflicts: [],
    });

    const assertConflict = (communication: Record<string, unknown>): void => {
      store.sqlite.prepare(
        "UPDATE runtime_communications SET payload_json = ? WHERE id = ?",
      ).run(JSON.stringify({ communication }), "runtime-row");
      const drifted = store.reconcileCommunicationEvents(project.id);
      expect(drifted.ok).toBe(false);
      expect(drifted.runtimePayloadConflicts.map((conflict) => conflict.eventId))
        .toEqual([eventId]);
    };

    assertConflict({ ...runtimePayload, text: "Changed content" });
    assertConflict({ ...runtimePayload, sender: { kind: "user", userId: "other-user" } });
    assertConflict({ ...runtimePayload, conversationId: "other-conversation" });
    assertConflict({ ...runtimePayload, intent: "user_dm" });
    assertConflict({ ...runtimePayload, audience: { kind: "organization", organizationId: "other-project" } });
    assertConflict({ ...runtimePayload, createdAt: "2026-08-12T00:00:01.000Z" });
    assertConflict({
      ...runtimePayload,
      document: {
        id: "document-a",
        title: "Changed document",
        mediaType: "text/markdown",
        content: "Changed content",
        byteLength: 15,
        createdAt,
      },
    });
    assertConflict({
      ...runtimePayload,
      attachments: [{
        id: "attachment-a",
        name: "changed.png",
        mediaType: "image/png",
        size: 1,
        url: "/api/assets/attachment-a",
      }],
    });

    store.sqlite.prepare(
      "UPDATE runtime_communications SET payload_json = ? WHERE id = ?",
    ).run(JSON.stringify({ communication: runtimePayload }), "runtime-row");
    expect(store.deleteConversation(conversationId)).toBe(true);
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      ok: true,
      orphanRuntimeCommunicationEventIds: [],
      runtimePayloadConflicts: [],
    });
  });

  test("treats collaboration recipients as a set while preserving authored audience", () => {
    const root = mkdtempSync(join(tmpdir(), "ponderosa-communication-recipients-"));
    directories.push(root);
    const dataDir = join(root, "data");
    const hostPath = join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const store = new AgentStore(dataDir);
    stores.push(store);
    const project = store.createProject({
      label: "Communication recipients",
      hostPath,
      defaultEngine: "codex",
    });
    const first = store.createAgent(project.id, { title: "First", engine: "codex" });
    const second = store.createAgent(project.id, { title: "Second", engine: "codex" });
    const eventId = "runtime-recipient-reconciliation";
    const createdAt = "2026-08-12T00:00:00.000Z";
    const canonical = {
      schemaVersion: 2 as const,
      eventId,
      projectId: project.id,
      sender: { kind: "user" as const, userId: "local-user" },
      intent: "collaboration" as const,
      audience: { kind: "agents" as const, agentIds: [first.id, second.id] as [string, ...string[]] },
      text: "Recipient ordering is set-like",
      createdAt,
    };
    store.appendCommunicationEvent(canonical);
    store.sqlite.prepare(`
      INSERT INTO runtime_communications(
        id, project_id, sender_json, intent, audience_json, payload_json,
        payload_hash, actionable, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      "runtime-recipient-row",
      project.id,
      JSON.stringify(canonical.sender),
      canonical.intent,
      JSON.stringify(canonical.audience),
      JSON.stringify({
        communication: {
          ...canonical,
          audience: { kind: "agents", agentIds: [second.id, first.id, second.id] },
        },
      }),
      "test-hash",
      createdAt,
    );
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      runtimePayloadConflicts: [],
    });

    store.sqlite.prepare(
      "UPDATE runtime_communications SET payload_json = ? WHERE id = ?",
    ).run(JSON.stringify({
      communication: {
        ...canonical,
        audience: { kind: "agents", agentIds: [first.id] },
      },
    }), "runtime-recipient-row");
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      runtimePayloadConflicts: [{ eventId }],
    });
  });
});
