import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GlobalChatSearchResultDto } from "@ponderosa/core";
import {
  GlobalSearchResultItem,
  highlightedSnippetSegments,
  isGlobalSearchShortcut,
  routeForGlobalSearchSelection,
} from "../src/components/GlobalChatSearch";
import { projectedMessageIdForFocus } from "../src/messageFocus";

const result: GlobalChatSearchResultDto = {
  project: { id: "project-two", label: "Second Project" },
  chat: { kind: "conversation", id: "chat-two", title: "Release chat" },
  messageId: "message-exact",
  author: { kind: "agent", label: "Search Agent", agentId: "agent-search" },
  timestamp: "2026-07-16T12:00:00.000Z",
  snippet: "Fix the global search route",
  highlights: [{ start: 8, length: 6 }],
  unread: true,
};

describe("global chat search", () => {
  it("opens only for Ctrl/Cmd+K", () => {
    expect(isGlobalSearchShortcut({ key: "k", ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isGlobalSearchShortcut({ key: "K", ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
    expect(isGlobalSearchShortcut({ key: "k", ctrlKey: true, metaKey: false, altKey: true })).toBe(false);
  });

  it("renders project, chat, author, timestamp, unread state, and highlighted snippet", () => {
    const html = renderToStaticMarkup(<GlobalSearchResultItem result={result} onSelect={vi.fn()} />);
    expect(html).toContain("Second Project");
    expect(html).toContain("Release chat");
    expect(html).toContain("Search Agent");
    expect(html).toContain("Unread");
    expect(html).toContain("<mark");
    expect(html).toContain("global</mark>");
  });

  it("navigates cross-project selections to exact message URLs", () => {
    const route = routeForGlobalSearchSelection({ projectId: result.project.id, chat: result.chat, messageId: result.messageId });
    expect(route).toEqual({ kind: "conversation", projectId: "project-two", conversationId: "chat-two", focusMessageId: "message-exact" });
    expect(highlightedSnippetSegments("abc def", [{ start: 4, length: 3 }])).toEqual([
      { text: "abc ", highlighted: false },
      { text: "def", highlighted: true },
    ]);
    const conversation = readFileSync(new URL("../src/components/ConversationView.tsx", import.meta.url), "utf8");
    const agent = readFileSync(new URL("../src/components/AgentDetail.tsx", import.meta.url), "utf8");
    expect(conversation).toContain("projectedMessageIdForFocus(focusedMessages, focusMessageId)");
    expect(agent).toContain("projectedMessageIdForFocus(detail?.messages ?? [], focusMessageId)");
    expect(conversation).toContain("api.getConversation(conversationId, 100, undefined, focusMessageId)");
    expect(agent).toContain("api.getAgent(agentId, 100, undefined, focusMessageId)");
    expect(conversation).toContain("target.focus({ preventScroll: true })");
  });

  it("normalizes projected search IDs and canonical notification IDs to one message", () => {
    const messages = [{ id: "agent-event-42", communicationEventId: "communication-42" }];
    expect(projectedMessageIdForFocus(messages, "agent-event-42")).toBe("agent-event-42");
    expect(projectedMessageIdForFocus(messages, "communication-42")).toBe("agent-event-42");
    expect(projectedMessageIdForFocus(messages, "foreign")).toBeUndefined();
  });

  it("keeps search debounced, responsive, and reconnect-aware", () => {
    const component = readFileSync(new URL("../src/components/GlobalChatSearch.tsx", import.meta.url), "utf8");
    const stream = readFileSync(new URL("../src/hooks/useWorkspaceStream.ts", import.meta.url), "utf8");
    expect(component).toContain("250");
    expect(component).toContain("fullScreen={fullScreen}");
    expect(component).toContain("refetchOnReconnect: true");
    expect(stream).toContain('["global-search"]');
  });
});
