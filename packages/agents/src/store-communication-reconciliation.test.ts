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
  test("ignores send-time display identity but rejects authored payload drift", () => {
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

    store.sqlite.prepare(
      "UPDATE runtime_communications SET payload_json = ? WHERE id = ?",
    ).run(
      JSON.stringify({ communication: { ...runtimePayload, text: "Changed content" } }),
      "runtime-row",
    );
    const drifted = store.reconcileCommunicationEvents(project.id);
    expect(drifted.ok).toBe(false);
    expect(drifted.runtimePayloadConflicts.map((conflict) => conflict.eventId))
      .toEqual([eventId]);

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
});
