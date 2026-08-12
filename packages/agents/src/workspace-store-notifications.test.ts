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
});
