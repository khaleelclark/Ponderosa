import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { AllChatItemDto } from "@ponderosa/core";
import { api } from "../src/api";
import { AllChatView, allChatReplyUnavailableMessage, allChatSourceRoute, mergeAllChatItems } from "../src/components/AllChatView";

const item = (overrides: Partial<AllChatItemDto> = {}): AllChatItemDto => ({
  communicationEventId: "event-1",
  messageId: "message-1",
  project: { id: "project-1", label: "Project" },
  source: { kind: "project", conversationId: "conversation-1", title: "Planning" },
  author: { kind: "user", label: "User" },
  text: "Message",
  createdAt: "2026-07-19T12:00:00.000Z",
  ...overrides,
});

describe("All Chat view contract", () => {
  it("navigates every item back to its exact source surface", () => {
    expect(allChatSourceRoute(item())).toEqual({
      kind: "conversation", projectId: "project-1", conversationId: "conversation-1", focusMessageId: "event-1",
    });
    expect(allChatSourceRoute(item({ source: { kind: "team", conversationId: "conversation-1", title: "Planning" } }))).toEqual({
      kind: "conversation", projectId: "project-1", conversationId: "conversation-1", focusMessageId: "event-1", channel: "collaboration",
    });
    expect(allChatSourceRoute(item({ source: { kind: "agent", agentId: "agent-1", title: "Reviewer" } }))).toEqual({
      kind: "agent", projectId: "project-1", agentId: "agent-1", focusMessageId: "event-1",
    });
  });

  it("merges refreshed and historical pages by canonical identity in stable order", () => {
    const newer = item({ communicationEventId: "event-2", messageId: "message-2", createdAt: "2026-07-19T12:01:00.000Z" });
    const revised = item({ text: "Revised" });
    expect(mergeAllChatItems([newer, item()], [revised])).toEqual([revised, newer]);
  });

  it("explains that the user cannot reply privately to their own message", () => {
    expect(allChatReplyUnavailableMessage(item())).toBe("You cannot message yourself. Select an Agent-authored message to reply privately to that Agent.");
    expect(allChatReplyUnavailableMessage(item({
      author: { kind: "agent", agentId: "agent-1", label: "Reviewer" },
      directMessageAgent: { id: "agent-1", title: "Reviewer" },
    }))).toBeUndefined();
  });

  it("contains only a selected-source direct-message mutation, never a broadcast composer", () => {
    const source = readFileSync(new URL("../src/components/AllChatView.tsx", import.meta.url), "utf8");
    expect(source).toContain("selected.directMessageAgent.id");
    expect(source).not.toContain(">Open Source</Button>");
    expect(source).toContain('onNavigate({ kind: "project", projectId: item.project.id })');
    expect(source).toContain("{item.project.label}</ButtonBase>");
    expect(source).toContain("replyToMessageId: selected.messageId");
    expect(source).not.toContain("shareWithOrganization");
    expect(source).not.toContain("sendConversationMessage");
  });

  it("mounts a single-tab-stop radio group with unique names, wrapped arrow selection, and fixed direct-message routing", async () => {
    const first = item({
      author: { kind: "agent", agentId: "agent-1", label: "Reviewer" },
      directMessageAgent: { id: "agent-1", title: "Reviewer" },
      text: "First release note\n\n**Bold detail**",
    });
    const second = item({
      communicationEventId: "event-2",
      messageId: "message-2",
      author: { kind: "agent", agentId: "agent-2", label: "Verifier" },
      directMessageAgent: { id: "agent-2", title: "Verifier" },
      text: "Second release note with distinct context",
      createdAt: "2026-07-19T12:01:00.000Z",
    });
    vi.spyOn(api, "getAllChat").mockResolvedValue({
      items: [first, second],
      history: { limit: 50, hasMore: false },
    });
    const sendMessage = vi.spyOn(api, "sendMessage").mockResolvedValue({ queued: false, runId: "run-2", mode: "steer" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><AllChatView onNavigate={vi.fn()} /></QueryClientProvider>);
    });
    const radioControls = () => view.root.findAllByProps({ role: "radio" }).filter((node) => node.type === "article");
    await vi.waitFor(() => expect(radioControls()).toHaveLength(2));
    expect(view.root.findAllByType("strong").some((node) => node.children.join("") === "Bold detail")).toBe(true);
    expect(new Set(radioControls().map((choice) => choice.props["aria-label"])).size).toBe(2);
    expect(radioControls()[0]!.props["aria-label"]).toContain("First release note");
    expect(radioControls()[1]!.props["aria-label"]).toContain("Second release note");
    expect(radioControls().map((choice) => choice.props.tabIndex)).toEqual([0, -1]);

    const focus = [vi.fn(), vi.fn()];
    const group = { querySelectorAll: () => focus.map((focusItem) => ({ focus: focusItem })) };
    const arrow = (key: string) => ({ key, preventDefault: vi.fn(), currentTarget: { closest: () => group } });
    const wrapBackward = arrow("ArrowUp");
    act(() => radioControls()[0]!.props.onKeyDown(wrapBackward));
    expect(wrapBackward.preventDefault).toHaveBeenCalledOnce();
    expect(focus[1]).toHaveBeenCalledOnce();
    expect(radioControls().map((choice) => [choice.props["aria-checked"], choice.props.tabIndex])).toEqual([[false, -1], [true, 0]]);

    const composer = view.root.find((node) => node.props.guidance === "Recipient is fixed by the selected source. This is a private reply and cannot be broadcast from Messages.");
    await act(async () => { await composer.props.onSend("Private follow-up"); });
    expect(sendMessage).toHaveBeenCalledWith("agent-2", expect.objectContaining({
      text: "Private follow-up", replyToMessageId: "message-2", activeRunDelivery: "steer",
    }));

    const wrapForward = arrow("ArrowDown");
    act(() => radioControls()[1]!.props.onKeyDown(wrapForward));
    expect(focus[0]).toHaveBeenCalledOnce();
    expect(radioControls().map((choice) => [choice.props["aria-checked"], choice.props.tabIndex])).toEqual([[true, 0], [false, -1]]);
    const radioGroups = view.root.findAllByProps({ role: "radiogroup" }).filter((node) => node.type === "div");
    expect(radioGroups.some((node) => node.props["aria-label"] === "Source message for direct reply")).toBe(true);
    view.unmount();
    client.clear();
  });
});
