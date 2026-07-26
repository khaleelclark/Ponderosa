// @vitest-environment node

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { AllChatItemDto } from "@ponderosa/core";
import { api } from "../src/api";
import { AllChatView } from "../src/components/AllChatView";

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
  it("renders messages with source navigation and shared message actions", async () => {
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
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><AllChatView onNavigate={vi.fn()} /></QueryClientProvider>);
    });
    const messages = () => view.root.findAll((node) => node.type === "article");
    await vi.waitFor(() => expect(messages()).toHaveLength(2));
    expect(view.root.findAllByType("strong").some((node) => node.children.join("") === "Bold detail")).toBe(true);
    expect(messages()[0]!.props["aria-label"]).toContain("First release note");
    expect(messages()[1]!.props["aria-label"]).toContain("Second release note");
    const buttons = (label: string) => view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === label);
    expect(buttons("Copy message")).toHaveLength(2);

    await act(async () => view.unmount());
    client.clear();
  });
});
