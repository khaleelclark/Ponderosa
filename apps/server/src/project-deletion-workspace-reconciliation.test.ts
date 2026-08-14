import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import type { WorkspaceEventEnvelope } from "@ponderosa/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  publishWorkspaceEvent,
  reconcileCommittedProjectDeletions,
} from "./project-deletion-workspace-reconciliation.js";

const stores: AgentStore[] = [];
const directories: string[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("committed Project deletion workspace recovery", () => {
  test("repairs a post-commit crash before readiness and remains idempotent across restart", () => {
    const root = mkdtempSync(join(tmpdir(), "ponderosa-project-deletion-repair-"));
    directories.push(root);
    const dataDir = join(root, "data");
    const hostPath = join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });

    const store = new AgentStore(dataDir);
    stores.push(store);
    const project = store.createProject({ label: "Deleted", hostPath, defaultEngine: "codex" });
    const workspace = new WorkspaceStore(dataDir);
    const deleted = workspace.createNotification({
      projectId: project.id,
      conversationId: "deleted-conversation",
      communicationEventId: "deleted-message",
      kind: "direct_responses",
      title: "Deleted Project reply",
      body: "Must be repaired from the receipt.",
    });
    const unaffected = workspace.createNotification({
      projectId: "unrelated-project",
      kind: "broadcasts",
      title: "Unrelated",
      body: "Must remain open.",
    });
    expect(store.commitProjectDeletion(project.id)).toBeDefined();
    const cursorBeforeCrash = workspace.cursor();
    store.close();
    stores.pop();

    const restartedStore = new AgentStore(dataDir);
    stores.push(restartedStore);
    const restartedWorkspace = new WorkspaceStore(dataDir);
    expect(restartedWorkspace.getNotification(deleted.id)?.readAt).toBeUndefined();
    const published: WorkspaceEventEnvelope[] = [];
    reconcileCommittedProjectDeletions(restartedStore, restartedWorkspace, event => published.push(event));

    expect(restartedWorkspace.cursor()).toBe(cursorBeforeCrash + 1);
    expect(restartedWorkspace.getNotification(deleted.id)).toMatchObject({
      status: "resolved",
      readAt: expect.any(String),
    });
    expect(restartedWorkspace.getNotification(unaffected.id)).toEqual(unaffected);
    expect(restartedWorkspace.notificationSearchState({
      communicationEventIds: ["deleted-message"],
      conversationIds: ["deleted-conversation"],
    })).toEqual({ unreadCommunicationEventIds: [], unreadConversationCounts: {} });

    reconcileCommittedProjectDeletions(restartedStore, restartedWorkspace, event => published.push(event));
    expect(restartedWorkspace.cursor()).toBe(cursorBeforeCrash + 1);
    expect(published).toHaveLength(2);
    expect(published[1]).toEqual(published[0]);

    const reloadedWorkspace = new WorkspaceStore(dataDir);
    expect(reloadedWorkspace.getNotification(deleted.id)).toMatchObject({ status: "resolved" });
    expect(reloadedWorkspace.getNotification(unaffected.id)).toEqual(unaffected);
  });

  test("one failed subscriber does not block other deletion subscribers", () => {
    const event = {
      id: 7,
      ts: "2026-08-14T00:00:00.000Z",
      event: { type: "project_changed", projectId: "project-1", action: "deleted" },
    } satisfies WorkspaceEventEnvelope;
    const received: WorkspaceEventEnvelope[] = [];
    const onError = vi.fn();
    publishWorkspaceEvent([
      () => { throw new Error("disconnected"); },
      item => received.push(item),
    ], event, onError);

    expect(onError).toHaveBeenCalledOnce();
    expect(received).toEqual([event]);
  });
});
