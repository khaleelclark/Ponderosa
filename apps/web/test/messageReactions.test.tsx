import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { MasterChatMessage } from "../src/components/MasterChatView";

describe("message reaction controls", () => {
  it("renders aggregate counts and pressed state without changing message semantics", () => {
    const html = renderToStaticMarkup(<ThemeProvider theme={createTheme()}><MasterChatMessage
      message={{ id: "m1", masterChatId: "room", role: "assistant", text: "Result", createdAt: "2026-07-12T00:00:00.000Z", authorThreadId: "agent", reactions: [{ emoji: "👍", count: 2, reactedByCurrentActor: true }] }}
      conversation="main"
      agentTitle={() => "Agent"}
      onOpenAgent={vi.fn()}
      onReply={vi.fn()}
      onDirectReply={vi.fn()}
      onReact={vi.fn()}
    /></ThemeProvider>);
    expect(html).toContain('aria-label="Remove 👍 reaction"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("👍 2");
    expect(html).toContain('aria-label="Agent message"');
  });
});
