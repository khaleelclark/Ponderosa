import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WorkspaceStore } from "./workspace-store.js";

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fixture(): WorkspaceStore {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-notifications-"));
  directories.push(directory);
  return new WorkspaceStore(directory);
}

describe("notification attention authority", () => {
  test("current notification switches preserve explicit disabled values", () => {
    const store = fixture();

    store.updatePreferences({
      notifications: { directResponses: false, broadcasts: false },
    });

    expect(store.getPreferences().notifications).toEqual({
      directResponses: false,
      broadcasts: false,
    });
  });

  test("bulk read applies to updates without hiding unresolved work", () => {
    const store = fixture();
    const update = store.createNotification({
      kind: "direct_responses",
      title: "Agent replied",
      body: "The requested work is complete.",
    });
    const issue = store.createNotification({
      kind: "operational",
      severity: "attention",
      title: "Provider unavailable",
      body: "Reconnect the provider to continue.",
    });

    expect(store.readAllNotifications()).toBe(1);
    expect(store.getNotification(update.id)?.readAt).toBeDefined();
    expect(store.getNotification(issue.id)?.readAt).toBeUndefined();
    expect(store.getNotification(issue.id)?.status).toBe("open");
  });

  test("retry attempt notices use their dedupe key even when they share a communication", () => {
    const store = fixture();
    const predecessor = store.createNotification({
      kind: "operational",
      category: "communication",
      severity: "urgent",
      status: "open",
      dedupeKey: "communication-delivery:activation-1:outcome_unknown",
      communicationEventId: "communication-1",
      title: "Message outcome needs your review",
      body: "The first attempt is uncertain.",
    });
    store.setNotificationStatus(predecessor.id, "resolved");

    const successor = store.createNotification({
      kind: "operational",
      category: "communication",
      severity: "urgent",
      status: "open",
      dedupeKey: "communication-delivery:activation-2:failed",
      communicationEventId: "communication-1",
      title: "Message delivery needs your help",
      body: "The retry failed.",
    });

    expect(successor.id).not.toBe(predecessor.id);
    expect(successor.status).toBe("open");
    expect(store.getNotification(predecessor.id)?.status).toBe("resolved");
    expect(store.getNotification(successor.id)?.dedupeKey).toBe(
      "communication-delivery:activation-2:failed",
    );
  });
});

describe("workspace resource recency", () => {
  test("bounds ordinary resources while retaining current and legacy stars", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const store = fixture();

    for (let index = 0; index < 150; index += 1) {
      store.markResourceUsed("agent", String(index));
      vi.advanceTimersByTime(1);
    }
    store.markResourceUsed("project", "legacy-star");
    vi.advanceTimersByTime(1);
    for (let index = 150; index < 160; index += 1) {
      store.markResourceUsed("agent", String(index));
      vi.advanceTimersByTime(1);
    }
    store.updatePreferences({
      starredResourceIds: ["agent:0"],
      starredProjectIds: ["legacy-star"],
    });

    const resources = store.listResourceRecency(10).resources;
    expect(store.listResourceRecency(10).truncated).toBe(true);
    expect(resources).toHaveLength(12);
    expect(resources.slice(0, 10).map(item => item.resourceKey)).toEqual(
      Array.from({ length: 10 }, (_, index) => `agent:${159 - index}`),
    );
    expect(resources.map(item => item.resourceKey)).toContain("agent:0");
    expect(resources.map(item => item.resourceKey)).toContain("project:legacy-star");
  });

  test.each([0, 99, 100, 101])(
    "reports truthful truncation for %i ordinary resources",
    count => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-12T01:00:00.000Z"));
      const store = fixture();
      for (let index = 0; index < count; index += 1) {
        store.markResourceUsed("agent", String(index));
        vi.advanceTimersByTime(1);
      }

      const result = store.listResourceRecency(100);
      expect(result.resources).toHaveLength(Math.min(count, 100));
      expect(result.truncated).toBe(count > 100 ? true : undefined);
    },
  );

  test("makes recent and old stars additive to the ordinary budget", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T02:00:00.000Z"));
    const store = fixture();
    for (let index = 0; index < 105; index += 1) {
      store.markResourceUsed("agent", String(index));
      vi.advanceTimersByTime(1);
    }
    store.updatePreferences({
      starredResourceIds: ["agent:104", "agent:0"],
    });

    const result = store.listResourceRecency(100);
    expect(result.resources).toHaveLength(102);
    expect(result.resources.map(item => item.resourceKey)).toEqual([
      "agent:104",
      ...Array.from({ length: 100 }, (_, index) => `agent:${103 - index}`),
      "agent:0",
    ]);
    expect(result.truncated).toBe(true);
  });

  test("does not report truncation when only stars exist beyond the budget", () => {
    const store = fixture();
    for (let index = 0; index < 5; index += 1) {
      store.markResourceUsed("agent", String(index));
    }
    store.updatePreferences({
      starredResourceIds: Array.from({ length: 5 }, (_, index) => `agent:${index}`),
    });

    expect(store.listResourceRecency(1)).toMatchObject({
      resources: expect.arrayContaining([
        expect.objectContaining({ resourceKey: "agent:0" }),
        expect.objectContaining({ resourceKey: "agent:4" }),
      ]),
    });
    expect(store.listResourceRecency(1).resources).toHaveLength(5);
    expect(store.listResourceRecency(1).truncated).toBeUndefined();
  });

  test("bounds lookup work and response size at the supported star limit", () => {
    const store = fixture();
    for (let index = 0; index < 101; index += 1) {
      store.markResourceUsed("agent", String(index));
    }
    store.updatePreferences({
      starredResourceIds: Array.from(
        { length: 10_000 },
        (_, index) => `agent:${index}`,
      ),
    });

    const result = store.listResourceRecency(100);
    expect(result.resources).toHaveLength(101);
    expect(result.resources.length).toBeLessThanOrEqual(10_100);
    expect(result.truncated).toBeUndefined();
  });

  test("removes deleted resources from both recency lookup and ordering", () => {
    const store = fixture();
    store.markResourceUsed("project", "deleted-project");
    store.markResourceUsed("conversation", "deleted-chat");
    store.markResourceUsed("trigger", "deleted-trigger");
    store.append({
      type: "project_changed",
      projectId: "deleted-project",
      action: "deleted",
    });
    store.append({
      type: "conversation_changed",
      projectId: "project-1",
      conversationId: "deleted-chat",
      action: "deleted",
    });
    store.append({
      type: "trigger_changed",
      projectId: "project-1",
      agentId: "agent-1",
      triggerId: "deleted-trigger",
      action: "deleted",
    });

    expect(store.listResourceRecency(100).resources).toEqual([]);
  });
});
