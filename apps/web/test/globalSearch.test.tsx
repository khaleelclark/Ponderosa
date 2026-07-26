// @vitest-environment node

import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { ListItemButton, TextField } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { GlobalChatSearchResultDto } from "@ponderosa/core";
import { api } from "../src/api";
import { GlobalChatSearch } from "../src/components/GlobalChatSearch";

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
