import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { AllChatItemDto } from "@ponderosa/core";
import { api } from "../src/api";
import { AllChatView, allChatSourceRoute, mergeAllChatItems } from "../src/components/AllChatView";

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

  it("contains only a selected-source direct-message mutation, never a broadcast composer", () => {
    const source = readFileSync(new URL("../src/components/AllChatView.tsx", import.meta.url), "utf8");
    expect(source).toContain("selected.directMessageAgent.id");
    expect(source).toContain("replyToMessageId: selected.messageId");
    expect(source).not.toContain("shareWithOrganization");
    expect(source).not.toContain("sendConversationMessage");
  });

  it("exposes one named radio choice and a valid checked state for source selection", async () => {
    vi.spyOn(api, "getAllChat").mockResolvedValue({
      items: [item({ directMessageAgent: { id: "agent-1", title: "Reviewer" } })],
      history: { limit: 50, hasMore: false },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><AllChatView onNavigate={vi.fn()} /></QueryClientProvider>);
    });
    const radioControls = () => view.root.findAllByProps({ role: "radio" }).filter((node) => node.type === "button");
    await vi.waitFor(() => expect(radioControls()).toHaveLength(1));
    const choice = radioControls()[0]!;
    expect(choice.props["aria-label"]).toContain("Select message from User");
    expect(choice.props["aria-checked"]).toBe(false);
    act(() => choice.props.onClick());
    expect(radioControls()[0]!.props["aria-checked"]).toBe(true);
    const radioGroups = view.root.findAllByProps({ role: "radiogroup" }).filter((node) => node.type === "div");
    expect(radioGroups.some((node) => node.props["aria-label"] === "Source message for direct reply")).toBe(true);
    view.unmount();
    client.clear();
  });
});
