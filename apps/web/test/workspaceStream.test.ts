import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { WorkspaceEvent } from "@ponderosa/core";
import { conversationChangedQueryKeys, createAgentListInvalidator, createAgentWorkInvalidator, createCollaborationChatInvalidator, fileActivityConversationQueryKeys, invalidateWorkspaceCapabilities, reconcileWorkspaceCursor, workspaceEventInvalidatesAllChat, workspaceEventInvalidatesGlobalSearch, workspaceReconnectRequiresRefresh } from "../src/hooks/useWorkspaceStream";

afterEach(() => vi.useRealTimers());

describe("workspace stream cursor recovery", () => {
  it("invalidates only the changed project's runtime discovery cache", async () => {
    const client = new QueryClient();
    client.setQueryData(["engine-capabilities", "project-a"], ["old-a"]);
    client.setQueryData(["engine-capabilities", "project-b"], ["old-b"]);

    await invalidateWorkspaceCapabilities(client, { kind: "runtime-change", projectId: "project-a" });

    expect(client.getQueryState(["engine-capabilities", "project-a"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["engine-capabilities", "project-b"])?.isInvalidated).toBe(false);
  });

  it("keeps runtime discovery cached across an ordinary reconnect", async () => {
    const client = new QueryClient();
    client.setQueryData(["engine-capabilities", "project-a"], ["old-a"]);
    client.setQueryData(["engine-capabilities", "project-b"], ["old-b"]);

    await invalidateWorkspaceCapabilities(client, { kind: "reconnect" });

    expect(client.getQueryState(["engine-capabilities", "project-a"])?.isInvalidated).toBe(false);
    expect(client.getQueryState(["engine-capabilities", "project-b"])?.isInvalidated).toBe(false);
  });

  it("coalesces coordination bursts into one Agent work refresh per Project", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    client.setQueryData(["agent-work", "project-a"], { old: true });
    client.setQueryData(["agent-work", "project-b"], { old: true });
    const invalidator = createAgentWorkInvalidator(client, 350);

    invalidator.schedule("project-a");
    invalidator.schedule("project-a");
    invalidator.schedule("project-b");
    expect(client.getQueryState(["agent-work", "project-a"])?.isInvalidated).toBe(false);
    await vi.advanceTimersByTimeAsync(350);

    expect(client.getQueryState(["agent-work", "project-a"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["agent-work", "project-b"])?.isInvalidated).toBe(true);
    invalidator.dispose();
  });

  it("does not starve Agent work refreshes during sustained coordination", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    client.setQueryData(["agent-work", "project-a"], { old: true });
    const invalidator = createAgentWorkInvalidator(client, 350);

    invalidator.schedule("project-a");
    await vi.advanceTimersByTimeAsync(200);
    invalidator.schedule("project-a");
    await vi.advanceTimersByTimeAsync(150);

    expect(client.getQueryState(["agent-work", "project-a"])?.isInvalidated).toBe(true);
    invalidator.dispose();
  });

  it("traces a 90-event lifecycle storm as one timely project agent-list refresh", async () => {
    vi.useFakeTimers();
    const invalidateQueries = vi.fn(() => Promise.resolve());
    const invalidator = createAgentListInvalidator({ invalidateQueries }, 350);

    for (let event = 0; event < 90; event += 1) invalidator.schedule("project-a");
    expect(invalidateQueries).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(349);
    expect(invalidateQueries).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "project-a"] });
    invalidator.dispose();
  });

  it("coalesces Team Chat refreshes by conversation without touching unrelated chats", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    client.setQueryData(["collaboration-chat", "chat-a"], { old: true });
    client.setQueryData(["collaboration-chat", "chat-b"], { old: true });
    client.setQueryData(["collaboration-chat", "chat-c"], { old: true });
    const invalidator = createCollaborationChatInvalidator(client, 750);

    invalidator.schedule([]);
    await vi.advanceTimersByTimeAsync(750);
    expect(client.getQueryState(["collaboration-chat", "chat-a"])?.isInvalidated).toBe(false);

    for (let event = 0; event < 90; event += 1) invalidator.schedule(["chat-a", "chat-b"]);
    await vi.advanceTimersByTimeAsync(749);
    expect(client.getQueryState(["collaboration-chat", "chat-a"])?.isInvalidated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(client.getQueryState(["collaboration-chat", "chat-a"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["collaboration-chat", "chat-b"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["collaboration-chat", "chat-c"])?.isInvalidated).toBe(false);
    invalidator.dispose();
  });

  it("falls back to one global Team Chat refresh for legacy unscoped events", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    client.setQueryData(["collaboration-chat", "chat-a"], { old: true });
    client.setQueryData(["collaboration-chat", "chat-b"], { old: true });
    const invalidator = createCollaborationChatInvalidator(client, 1);

    invalidator.schedule();
    await vi.advanceTimersByTimeAsync(1);

    expect(client.getQueryState(["collaboration-chat", "chat-a"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["collaboration-chat", "chat-b"])?.isInvalidated).toBe(true);
    invalidator.dispose();
  });

  it("treats a legacy unscoped delivery event as a safe global refresh", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    client.setQueryData(["agent-work", "project-a"], { old: true });
    client.setQueryData(["agent-work", "project-b"], { old: true });
    const invalidator = createAgentWorkInvalidator(client, 1);
    const legacyEvent: Extract<WorkspaceEvent, { type: "message_delivery_changed" }> = {
      type: "message_delivery_changed", agentId: "agent",
    };

    invalidator.schedule(legacyEvent.projectId);
    await vi.advanceTimersByTimeAsync(1);

    expect(client.getQueryState(["agent-work", "project-a"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["agent-work", "project-b"])?.isInvalidated).toBe(true);
    invalidator.dispose();
  });

  it("converges capability cache boundaries independently in multiple tabs", async () => {
    const tabs = [new QueryClient(), new QueryClient()];
    for (const tab of tabs) tab.setQueryData(["engine-capabilities", "project-a"], ["old"]);

    await Promise.all(tabs.map((tab) => invalidateWorkspaceCapabilities(tab, { kind: "runtime-change", projectId: "project-a" })));

    expect(tabs.map((tab) => tab.getQueryState(["engine-capabilities", "project-a"])?.isInvalidated)).toEqual([true, true]);
  });

  it("converges independent tabs after sleep/reconnect and ignores duplicate replay", () => {
    let phone = 0;
    let desktop = 0;
    const events = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

    // Desktop remained connected; the phone wakes with a stale cursor and gets
    // a live event before the server's resumable backfill arrives.
    desktop = reconcileWorkspaceCursor(desktop, events[0]!).cursor;
    desktop = reconcileWorkspaceCursor(desktop, events[1]!).cursor;
    phone = reconcileWorkspaceCursor(phone, events[0]!).cursor;
    const outOfOrder = reconcileWorkspaceCursor(phone, events[2]!);
    expect(outOfOrder.gap).toBe(true);
    phone = outOfOrder.cursor;

    // Backfill is idempotent: the already-applied event is ignored, then both
    // tabs consume the remaining canonical tail.
    expect(reconcileWorkspaceCursor(phone, events[1]!).duplicate).toBe(true);
    phone = reconcileWorkspaceCursor(phone, events[3]!).cursor;
    desktop = reconcileWorkspaceCursor(desktop, events[2]!).cursor;
    desktop = reconcileWorkspaceCursor(desktop, events[3]!).cursor;
    expect(phone).toBe(desktop);
    expect(reconcileWorkspaceCursor(phone, events[3]!).duplicate).toBe(true);
  });

  it("invalidates Project and Team chat in every tab for a canonical message or edit", () => {
    const event = {
      type: "conversation_changed" as const,
      projectId: "project-1",
      conversationId: "conversation-1",
      action: "updated" as const,
    };
    const desktop = conversationChangedQueryKeys(event);
    const phoneAfterReconnect = conversationChangedQueryKeys(event);

    expect(desktop).toEqual([
      ["conversations", "project-1"],
      ["conversation", "conversation-1"],
      ["collaboration-chat", "conversation-1"],
    ]);
    expect(phoneAfterReconnect).toEqual(desktop);
  });

  it("refetches every owning conversation for replayed canonical file activity", () => {
    expect(fileActivityConversationQueryKeys({
      type: "agent_event", projectId: "project", agentId: "agent", conversationIds: ["one", "two"],
      seq: 9, eventType: "file_change", category: "file", executionId: "run",
    })).toEqual([["conversation", "one"], ["conversation", "two"]]);
    expect(fileActivityConversationQueryKeys({
      type: "agent_event", projectId: "project", agentId: "agent", conversationIds: ["one"],
      seq: 10, eventType: "command", category: "task",
    })).toEqual([]);
    expect(fileActivityConversationQueryKeys({
      type: "agent_event", projectId: "project", agentId: "agent", conversationIds: ["one"],
      seq: 11, eventType: "agent_lifecycle", category: "lifecycle", executionId: "run",
    })).toEqual([["conversation", "one"]]);
  });

  it("refetches latest passive edits and unread state after mutations or reconnect", () => {
    expect(workspaceEventInvalidatesGlobalSearch({
      type: "conversation_changed",
      projectId: "project",
      conversationId: "chat",
      action: "updated",
    })).toBe(true);
    expect(workspaceEventInvalidatesGlobalSearch({
      type: "notification_changed",
      action: "created",
      notificationId: "notification",
    })).toBe(true);
    expect(workspaceReconnectRequiresRefresh(12, "old-instance", {
      cursor: 3,
      instanceId: "new-instance",
      reset: false,
    })).toBe(true);
  });

  it("refreshes All Chat for Project communication and agent-only message audit events", () => {
    expect(workspaceEventInvalidatesAllChat({
      type: "conversation_changed",
      projectId: "project",
      conversationId: "chat",
      action: "message",
    })).toBe(true);
    expect(workspaceEventInvalidatesAllChat({
      type: "message_delivery_changed",
      projectId: "project",
      agentId: "agent",
    })).toBe(true);
    expect(workspaceEventInvalidatesAllChat({
      type: "agent_event",
      projectId: "project",
      agentId: "agent",
      conversationIds: [],
      seq: 12,
      eventType: "communication",
      category: "message",
    })).toBe(true);
  });

  it("does not refresh All Chat for unrelated execution telemetry", () => {
    expect(workspaceEventInvalidatesAllChat({
      type: "agent_event",
      projectId: "project",
      agentId: "agent",
      conversationIds: ["chat"],
      seq: 13,
      eventType: "file_change",
      category: "file",
      executionId: "run",
    })).toBe(false);
    expect(workspaceEventInvalidatesAllChat({
      type: "usage_changed",
      projectId: "project",
      agentId: "agent",
      conversationIds: ["chat"],
      seq: 14,
      executionId: "run",
    })).toBe(false);
  });
});
