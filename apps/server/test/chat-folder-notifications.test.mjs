import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import { createServer } from "../dist/app.js";

test("folder summaries use exact canonical notification identities and Chat ownership across feed pages", () => {
  const root = mkdtempSync(join(tmpdir(), "folder-notification-store-"));
  try {
    const store = new WorkspaceStore(root);
    const add = input => store.createNotification({ projectId: "project", title: "Notice", body: "Test", ...input });
    const direct = add({ conversationId: "newleaf", kind: "direct_responses", agentId: "agent" });
    const ordinary = add({ conversationId: "glance", kind: "broadcasts" });
    const shared = add({ conversationIds: ["newleaf", "glance"], kind: "everyone" });
    const action = add({ conversationId: "newleaf", kind: "operational", severity: "urgent" });
    add({ conversationIds: ["newleaf", "glance"], kind: "operational", severity: "urgent" });
    add({ conversationId: "outside", kind: "direct_responses" });
    const oldRead = add({ conversationId: "newleaf", kind: "direct_responses" }); store.readNotification(oldRead.id);
    const oldDismissed = add({ conversationId: "newleaf", kind: "operational", severity: "attention" }); store.setNotificationStatus(oldDismissed.id, "dismissed");
    for (let i = 0; i < 110; i++) add({ conversationId: "newleaf", kind: "broadcasts" });
    const request = { projectIds: [], conversationIds: [], chatFolders: [
      { id: "apps", conversationIds: ["newleaf", "glance", "newleaf"] },
      { id: "empty", conversationIds: [] },
      { id: "other", conversationIds: ["outside"] },
    ] };
    const counts = () => store.notificationProjection(request).chatFolders;
    assert.deepEqual(counts().apps, { importantCount: 3, ordinaryCount: 111, totalCount: 114 });
    assert.equal(counts().empty.totalCount, 0);
    assert.equal(counts().other.totalCount, 1);
    assert.equal(store.listNotificationPage({ limit: 100 }).items.length, 100, "folder counts are not calculated from the feed page");
    store.readNotification(direct.id);
    store.setNotificationStatus(action.id, "dismissed");
    assert.deepEqual(counts().apps, { importantCount: 1, ordinaryCount: 111, totalCount: 112 });
    store.readNotification(shared.id);
    store.readNotification(ordinary.id);
    assert.deepEqual(counts().apps, { importantCount: 0, ordinaryCount: 110, totalCount: 110 });
    store.updatePreferences({ notificationScopes: { "conversation:newleaf": "muted" } });
    assert.equal(counts().apps.totalCount, 0, "muted Chat notifications do not create folder badges");
    assert.deepEqual(new WorkspaceStore(root).notificationProjection(request).chatFolders, counts(), "store reopening preserves counts");
    assert.equal(store.notificationProjection({ ...request, chatFolders: [{ id: "apps", conversationIds: ["outside"] }] }).chatFolders.apps.totalCount, 1, "membership changes replace rather than add old counts");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real projection route bounds folder groups and members while preserving legacy requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "folder-notification-route-"));
  const store = new AgentStore(root), workspace = new WorkspaceStore(root);
  const project = store.createProject({ label: "Notifications", hostPath: root, defaultEngine: "codex" });
  const chatId = project.lastConversationId;
  workspace.createNotification({ conversationId: chatId, kind: "direct_responses", title: "Notice", body: "Test" });
  const app = createServer({ dataDir: root, store, engines: [], logger: false, startDrained: true });
  try {
    await app.ready();
    const base = { projectIds: [], conversationIds: [] };
    const query = chatFolders => app.inject({ method: "POST", url: "/api/notifications/projection", payload: { ...base, ...(chatFolders === undefined ? {} : { chatFolders }) } });
    const legacy = await query(); assert.equal(legacy.statusCode, 200, legacy.body);
    const accepted = await query([{ id: "apps", conversationIds: [chatId] }]);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().chatFolders.apps.importantCount, 1);
    for (const invalid of [null, {}, [{ id: "a", conversationIds: chatId }], [{ id: "", conversationIds: [] }],
      [{ id: "a", conversationIds: [42] }], [{ id: "a", conversationIds: ["x".repeat(201)] }],
      [{ id: "a", conversationIds: [] }, { id: "a", conversationIds: [] }],
      Array.from({ length: 201 }, (_, i) => ({ id: String(i), conversationIds: [] })),
      [{ id: "a", conversationIds: Array(10_001).fill(chatId) }],
      [{ id: "a", conversationIds: Array(5001).fill(chatId) }, { id: "b", conversationIds: Array(5000).fill(chatId) }],
    ]) {
      const response = await query(invalid); assert.equal(response.statusCode, 400, response.body);
    }
    const boundary = await query([{ id: "a", conversationIds: Array(10_000).fill(chatId) }]);
    assert.equal(boundary.statusCode, 200, boundary.body);
    assert.equal(boundary.json().chatFolders.a.totalCount, 1);
    const groupBoundary = await query(Array.from({ length: 200 }, (_, i) => ({ id: `group-${i}`, conversationIds: [chatId] })));
    assert.equal(groupBoundary.statusCode, 200, groupBoundary.body);
    assert.equal(Object.keys(groupBoundary.json().chatFolders).length, 200);
    const proto = await query([{ id: "__proto__", conversationIds: [chatId] }]);
    assert.equal(proto.statusCode, 200); assert.equal(proto.json().chatFolders.__proto__.totalCount, 1);
  } finally { await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
