import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { ListItemButton, TextField } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { GlobalChatSearchResultDto } from "@ponderosa/core";
import { api } from "../src/api";
import {
  GlobalChatSearch,
  GlobalSearchResultItem,
  globalSearchKeyboardAction,
  highlightedSnippetSegments,
  isGlobalSearchShortcut,
  routeForGlobalSearchSelection,
} from "../src/components/GlobalChatSearch";
import { projectedMessageIdForFocus } from "../src/messageFocus";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  return { ...actual, Dialog: ({ children }: { children?: ReactNode }) => children ?? null };
});

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

  it("wraps arrow navigation and distinguishes Enter from modifier-open", () => {
    expect(globalSearchKeyboardAction({ key: "ArrowDown", metaKey: false, ctrlKey: false }, -1, 2)).toEqual({ activeIndex: 0 });
    expect(globalSearchKeyboardAction({ key: "ArrowUp", metaKey: false, ctrlKey: false }, 0, 2)).toEqual({ activeIndex: 1 });
    expect(globalSearchKeyboardAction({ key: "Enter", metaKey: false, ctrlKey: false }, 1, 2)).toEqual({ activeIndex: 1, openInNewTab: false });
    expect(globalSearchKeyboardAction({ key: "Enter", metaKey: true, ctrlKey: false }, 1, 2)).toEqual({ activeIndex: 1, openInNewTab: true });
    expect(globalSearchKeyboardAction({ key: "Enter", metaKey: true, ctrlKey: false }, -1, 2)).toBeUndefined();
  });

  it("publishes the active option state and modifier-click intent", () => {
    const onSelect = vi.fn();
    const view = create(<GlobalSearchResultItem result={result} active id="search-option" onSelect={onSelect} />);
    const option = view.root.findByType(ListItemButton);
    expect(option.props.role).toBe("option");
    expect(option.props["aria-selected"]).toBe(true);
    act(() => option.props.onClick({ metaKey: false, ctrlKey: true }));
    expect(onSelect).toHaveBeenCalledWith(true);
    view.unmount();
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
    expect(component).toContain('"aria-activedescendant"');
    expect(component).toContain("onOpenInNewTab");
    expect(stream).toContain("queryKeys.globalSearch.all");
  });

  it("keeps mounted combobox focus ownership while real key events wrap, reset, and route exact messages", async () => {
    const second = {
      ...result,
      chat: { kind: "agent" as const, id: "agent-two", title: "Verification Agent" },
      messageId: "message-second",
      snippet: "Verify the global search interaction",
      timestamp: "2026-07-16T12:01:00.000Z",
    };
    const response = (results: GlobalChatSearchResultDto[]) => ({
      query: "", results, recentChats: [], scannedMessages: results.length, truncated: false,
    });
    vi.spyOn(api, "searchGlobalChats").mockResolvedValue(response([result, second]));
    const onSelect = vi.fn();
    const onOpenInNewTab = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}>
        <GlobalChatSearch open onClose={vi.fn()} onSelect={onSelect} onOpenInNewTab={onOpenInNewTab} />
      </QueryClientProvider>);
    });
    await vi.waitFor(() => expect(view.root.findAllByType(ListItemButton)).toHaveLength(2));
    const searchField = () => view.root.findByType(TextField);
    const options = () => view.root.findAllByType(ListItemButton);
    const resultGroups = view.root.findAllByProps({ role: "group" }).filter((node) => node.type === "div");
    expect(resultGroups.map((group) => group.props["aria-label"])).toEqual(["Unread messages"]);
    expect(view.root.findAllByProps({ role: "listbox" }).some((node) => node.type === "div")).toBe(true);
    expect(options().map((option) => option.props.tabIndex)).toEqual([-1, -1]);
    const pointerDown = { preventDefault: vi.fn() };
    act(() => options()[0]!.props.onMouseDown(pointerDown));
    expect(pointerDown.preventDefault).toHaveBeenCalledOnce();

    const keyEvent = (key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) => ({
      key, ctrlKey: false, metaKey: false, preventDefault: vi.fn(), ...modifiers,
    });
    const up = keyEvent("ArrowUp");
    act(() => searchField().props.onKeyDown(up));
    expect(up.preventDefault).toHaveBeenCalledOnce();
    expect(searchField().props.inputProps["aria-activedescendant"]).toBe("global-search-option-1");
    expect(options()[1]!.props["aria-selected"]).toBe(true);

    const enter = keyEvent("Enter");
    act(() => searchField().props.onKeyDown(enter));
    expect(onSelect).toHaveBeenCalledWith({ projectId: "project-two", chat: second.chat, messageId: "message-second" });

    const down = keyEvent("ArrowDown");
    act(() => searchField().props.onKeyDown(down));
    expect(searchField().props.inputProps["aria-activedescendant"]).toBe("global-search-option-0");
    const modifierEnter = keyEvent("Enter", { ctrlKey: true });
    act(() => searchField().props.onKeyDown(modifierEnter));
    expect(onOpenInNewTab).toHaveBeenCalledWith({ projectId: "project-two", chat: result.chat, messageId: "message-exact" });

    const replacement = { ...result, messageId: "replacement-message", snippet: "Replacement at the same index" };
    await act(async () => { client.setQueryData(["global-search", ""], response([replacement, second])); });
    await vi.waitFor(() => expect(searchField().props.inputProps["aria-activedescendant"]).toBeUndefined());
    expect(options().every((option) => option.props["aria-selected"] === false)).toBe(true);
    view.unmount();
    client.clear();
  });
});
