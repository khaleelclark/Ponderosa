import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "../src/workspace-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "ponderosa-workspace-store-"));
  dirs.push(dir);
  return { dir, store: new WorkspaceStore(dir) };
}

describe("WorkspaceStore canonical replay", () => {
  it("persists synced preferences and revisioned drafts with deterministic conflicts", () => {
    const { dir, store } = fixture();
    store.updatePreferences({ projectSort: "custom", projectOrder: ["two", "one"], starredProjectIds: ["two"], sidebarWidth: 340, maxConcurrentAgentRuns: 5 });
    const first = store.putDraft("chat", { text: "first", attachmentIds: ["asset"], expectedRevision: 0, clientId: "tab-a" });
    expect(first.revision).toBe(1);
    let conflict: unknown;
    try { store.putDraft("chat", { text: "stale", attachmentIds: [], expectedRevision: 0, clientId: "tab-b" }); } catch (error) { conflict = error; }
    expect(conflict).toMatchObject({ code: "DRAFT_CONFLICT", current: first, displaced: { text: "stale", clientId: "tab-b" } });

    const restarted = new WorkspaceStore(dir);
    expect(restarted.instanceId()).toBe(store.instanceId());
    expect(restarted.getPreferences()).toMatchObject({ projectSort: "custom", projectOrder: ["two", "one"], starredProjectIds: ["two"], sidebarWidth: 340, maxConcurrentAgentRuns: 5 });
    expect(restarted.getDraft("chat")).toEqual(first);
    expect(restarted.listDraftConflicts("chat").conflicts).toEqual([expect.objectContaining({ current: first, displaced: expect.objectContaining({ text: "stale" }) })]);
    expect(restarted.readSince(0).map((item) => item.id)).toEqual(restarted.readSince(0).map((_, index) => index + 1));
  });

  it("defaults Agent Run concurrency when replaying a preferences event without the field", () => {
    const { dir, store } = fixture();
    store.updatePreferences({ projectSort: "custom" });
    const eventsFile = path.join(dir, "workspace-events.jsonl");
    const record = JSON.parse(readFileSync(eventsFile, "utf8")) as { event: { preferences: Record<string, unknown> } };
    delete record.event.preferences.maxConcurrentAgentRuns;
    writeFileSync(eventsFile, `${JSON.stringify(record)}\n`);

    expect(new WorkspaceStore(dir).getPreferences()).toMatchObject({
      projectSort: "custom",
      maxConcurrentAgentRuns: 8,
    });
  });

  it("deduplicates notifications and rotates/removes one device subscription", () => {
    const { dir, store } = fixture();
    const notification = store.createNotification({ projectId: "project", conversationId: "chat", communicationEventId: "event", kind: "mentions", title: "Agent", body: "Hello" });
    expect(store.createNotification({ projectId: "project", conversationId: "chat", communicationEventId: "event", kind: "mentions", title: "Agent", body: "Hello" })).toEqual(notification);
    store.readConversation("chat");
    expect(store.listNotifications()[0]?.readAt).toBeTruthy();

    store.putPushSubscription({ deviceId: "phone", endpoint: "https://push.example/one", expirationTime: null, keys: { p256dh: "one", auth: "auth" } });
    store.putPushSubscription({ deviceId: "phone", endpoint: "https://push.example/two", expirationTime: null, keys: { p256dh: "two", auth: "auth" } });
    expect(store.listPushSubscriptions()).toHaveLength(1);
    expect(store.listPushSubscriptions()[0]?.endpoint).toContain("/two");
    store.deletePushSubscription("phone");
    expect(new WorkspaceStore(dir).listPushSubscriptions()).toEqual([]);
  });

  it("persists one push delivery per subscribed endpoint and converges read state after restart", () => {
    const { dir, store } = fixture();
    const first = store.putPushSubscription({ deviceId: "tab-a", endpoint: "https://push.example/device", expirationTime: null, keys: { p256dh: "one", auth: "auth" } });
    expect(store.putPushSubscription({ deviceId: "tab-a", endpoint: first.endpoint, expirationTime: null, keys: first.keys })).toEqual(first);
    // Clearing local storage can create a new device ID, but the endpoint still
    // identifies one browser subscription and must not receive duplicates.
    store.putPushSubscription({ deviceId: "tab-b", endpoint: first.endpoint, expirationTime: null, keys: first.keys });
    expect(store.listPushSubscriptions().map((item) => item.deviceId)).toEqual(["tab-b"]);

    const notification = store.createNotification({ projectId: "project", conversationId: "chat", communicationEventId: "message", kind: "direct_responses", title: "Agent", body: "Done" }, true);
    expect(store.duePushDeliveries()).toHaveLength(1);
    store.updatePushDelivery({ notificationId: notification.id, deviceId: "tab-b", status: "delivered", deliveredAt: new Date().toISOString() });
    store.readConversation("chat");

    const restarted = new WorkspaceStore(dir);
    expect(restarted.duePushDeliveries()).toEqual([]);
    expect(restarted.listPushDeliveries()).toEqual([expect.objectContaining({ notificationId: notification.id, deviceId: "tab-b", status: "delivered", attempts: 1 })]);
    expect(restarted.listNotifications()[0]?.readAt).toBeTruthy();
  });

  it("marks and clears every notification canonically across restart", () => {
    const { dir, store } = fixture();
    store.createNotification({ projectId: "project", conversationId: "one", communicationEventId: "one", kind: "mentions", title: "One", body: "First" });
    store.createNotification({ projectId: "project", conversationId: "two", communicationEventId: "two", kind: "direct_responses", title: "Two", body: "Second" });

    expect(store.readAllNotifications()).toBe(2);
    expect(store.readAllNotifications()).toBe(0);
    expect(new WorkspaceStore(dir).listNotifications().every((item) => Boolean(item.readAt))).toBe(true);

    expect(store.clearNotifications()).toBe(2);
    expect(store.clearNotifications()).toBe(0);
    expect(new WorkspaceStore(dir).listNotifications()).toEqual([]);
  });

  it("clears only one Project notification group canonically across restart", () => {
    const { dir, store } = fixture();
    store.createNotification({ projectId: "alpha", conversationId: "one", communicationEventId: "one", kind: "mentions", title: "One", body: "First" });
    store.createNotification({ projectId: "alpha", conversationId: "two", communicationEventId: "two", kind: "direct_responses", title: "Two", body: "Second" });
    store.createNotification({ projectId: "beta", conversationId: "three", communicationEventId: "three", kind: "mentions", title: "Three", body: "Third" });

    expect(store.clearProjectNotifications("alpha")).toBe(2);
    expect(store.clearProjectNotifications("alpha")).toBe(0);
    expect(new WorkspaceStore(dir).listNotifications()).toEqual([
      expect.objectContaining({ projectId: "beta", communicationEventId: "three" }),
    ]);
  });

  it("persists provider switches, master rules, profile, urgent alerts, and Decisions", () => {
    const { dir, store } = fixture();
    store.updatePreferences({
      providerAvailability: { codex: true, claude: false },
      globalInstructions: "Never publish without a Decision.",
      profile: { displayName: "Patrick", handle: "patrick", avatarId: "pine" },
    });
    const notification = store.createNotification({
      kind: "operational", category: "provider", severity: "urgent", status: "open",
      dedupeKey: "provider:claude:denied", title: "Claude needs attention", body: "Subscription unavailable",
      action: { kind: "open_settings", targetId: "providers" },
    });
    expect(store.createNotification({
      kind: "operational", category: "provider", severity: "urgent", status: "open",
      dedupeKey: "provider:claude:denied", title: "Duplicate", body: "Duplicate",
    }).id).toBe(notification.id);
    const decision = store.createDecision({
      idempotencyKey: "publish-v1", projectId: "project", conversationId: "chat", agentId: "agent", runId: "run",
      mode: "approval", question: "Publish the release?", options: [{ id: "approve", label: "Approve" }, { id: "do_not_approve", label: "Do not approve" }],
      allowOther: true, blocking: true,
    });
    const decisionNotification = store.createNotification({
      projectId: "project", conversationId: "chat", kind: "decision", category: "decision", severity: "urgent", status: "open",
      dedupeKey: `decision:${decision.id}`, title: "Agent needs a decision", body: decision.question,
      action: { kind: "open_decision", targetId: decision.id },
      decision: { id: decision.id, mode: decision.mode, options: decision.options, allowOther: decision.allowOther, status: decision.status },
    });
    expect(store.createDecision({
      idempotencyKey: "publish-v1", projectId: "project", conversationId: "chat", agentId: "agent", runId: "run",
      mode: "approval", question: "Changed retry", options: [], allowOther: true, blocking: true,
    }).id).toBe(decision.id);
    const abandoned = store.createDecision({
      idempotencyKey: "abandoned", projectId: "project", conversationId: "chat", agentId: "deleted-agent", runId: "run",
      mode: "text", question: "Will this survive deletion?", options: [], allowOther: true, blocking: true,
    });
    expect(store.cancelDecisionsForAgent("deleted-agent")).toEqual([expect.objectContaining({ id: abandoned.id, status: "cancelled" })]);
    store.resolveDecision(decision.id, { optionId: "approve", respondedAt: "2026-07-16T00:00:00.000Z" });
    expect(store.getNotification(decisionNotification.id)?.decision?.status).toBe("resolved");
    store.setNotificationStatus(notification.id, "resolved");

    const restarted = new WorkspaceStore(dir);
    expect(restarted.getPreferences()).toMatchObject({
      providerAvailability: { codex: true, claude: false },
      globalInstructions: "Never publish without a Decision.",
      profile: { displayName: "Patrick", handle: "patrick", avatarId: "pine" },
    });
    expect(restarted.getDecision(decision.id)).toMatchObject({ status: "resolved", response: { optionId: "approve" } });
    expect(restarted.getNotification(decisionNotification.id)?.decision?.status).toBe("resolved");
    expect(restarted.getDecision(abandoned.id)).toMatchObject({ status: "cancelled" });
    expect(restarted.getNotification(notification.id)).toMatchObject({ status: "resolved", severity: "urgent" });
  });

  it("indexes bounded Decision pages and exact Run relationships across replay", () => {
    const { dir, store } = fixture();
    const decisions = Array.from({ length: 7 }, (_, index) => store.createDecision({
      idempotencyKey: `bounded-${index}`,
      projectId: "project",
      conversationId: index === 0 ? "other-chat" : "chat",
      agentId: index % 2 ? "agent-a" : "agent-b",
      runId: index < 2 ? "shared-run" : `run-${index}`,
      mode: "text",
      question: `Question ${index}`,
      options: [],
      allowOther: true,
      blocking: false,
    }));
    const first = store.listDecisionPage({ projectId: "project", conversationId: "chat", limit: 2 });
    expect(first.decisions).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const oldest = first.decisions.at(-1)!;
    const second = store.listDecisionPage({
      projectId: "project", conversationId: "chat", limit: 10,
      before: { createdAt: oldest.createdAt, id: oldest.id },
    });
    expect(new Set([...first.decisions, ...second.decisions].map((decision) => decision.id)).size).toBe(6);
    expect(store.decisionsForRuns(new Set(["shared-run"])).map((decision) => decision.id).sort())
      .toEqual(decisions.slice(0, 2).map((decision) => decision.id).sort());

    const restarted = new WorkspaceStore(dir);
    expect(restarted.listDecisionPage({
      projectId: "project", conversationId: "chat", agentId: "agent-a", limit: 10,
    }).decisions.every((decision) => decision.agentId === "agent-a")).toBe(true);
    expect(restarted.decisionsForRuns(new Set(["shared-run"]))).toHaveLength(2);
  });
});
