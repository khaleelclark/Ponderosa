import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WorkspaceStore } from "./workspace-store.js";

const directories: string[] = [];

afterEach(() => {
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
