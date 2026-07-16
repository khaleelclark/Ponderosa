import type { ConversationMessageDto } from "@ponderosa/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ConversationMessage, conversationComposerRuntime } from "../src/components/ConversationView";
import { replyPreviewText } from "../src/components/panes";

const baseMessage: ConversationMessageDto = {
  id: "message-1",
  conversationId: "conversation-1",
  role: "assistant",
  authorAgentId: "agent-1",
  text: "Completed the requested change.",
  createdAt: "2026-07-15T00:00:00.000Z",
  fileActivity: [{
    path: "src/app.ts", kind: "edit", status: "completed", sourceSeq: 12,
    artifactId: "agent-1:a:12:0", previewable: true, additions: 12, deletions: 3,
  }],
};

describe("chat interaction refinement", () => {
  it("shares selected authenticated runtime capabilities with Project and Team composer views", () => {
    const runtime = conversationComposerRuntime(
      { id: "runtime-a", authenticated: true, available: true },
      [{
        engineId: "runtime-a",
        steering: true,
        persistentSessions: true,
        commands: [{ name: "review", description: "Review", source: "skill", acceptsArguments: true }],
        mcpServers: [],
        composerCapabilities: [{ id: "skill:review", kind: "skill", label: "review", description: "Review", status: "available", insertText: "$review " }],
      }],
    );
    expect(runtime.commands.map((command) => command.name)).toEqual(["review"]);
    expect(runtime.capabilities.map((capability) => capability.id)).toEqual(["skill:review"]);
    expect(conversationComposerRuntime({ id: "runtime-a", authenticated: false, available: false }, []).capabilities).toEqual([]);

    const source = readFileSync(new URL("../src/components/ConversationView.tsx", import.meta.url), "utf8");
    expect(source).toContain("capabilities={composerRuntime.capabilities}");
    expect(source).toContain("onCapabilitiesOpen={onRefreshCapabilities}");
    expect(source).not.toContain('capabilities={activeView === "main"');
  });

  it("keeps direct-reply context bounded and exposes review/count metadata", () => {
    expect(replyPreviewText("long text ".repeat(100)).length).toBeLessThanOrEqual(240);
    const html = renderToStaticMarkup(
      <ConversationMessage
        message={baseMessage}
        conversation="main"
        agentTitle={() => "Agent One"}
        agentIdForHandle={() => undefined}
        onOpenAgent={vi.fn()}
        onOpenReview={vi.fn()}
        onReply={vi.fn()}
        onDirectReply={vi.fn()}
        onReact={vi.fn()}
      />,
    );
    expect(html).toContain("src/app.ts");
    expect(html).toContain("+12");
    expect(html).toContain("−3");
    expect(html).toContain("1 changed file");
    expect(html).toContain("Open focused diff for src/app.ts");
    expect(html).toContain(">Review all</button>");
  });

  it("focuses direct replies and supports hover/focus/touch action disclosure", () => {
    const composer = readFileSync(new URL("../src/components/panes.tsx", import.meta.url), "utf8");
    const actions = readFileSync(new URL("../src/global.css", import.meta.url), "utf8");
    expect(composer).toContain("focusReply");
    expect(composer).toContain("inputRef.current?.focus()");
    expect(actions).toContain(".chat-message:hover");
    expect(actions).toContain(".chat-message-actions.revealed");
  });

  it("keeps scrollbar geometry stable and reveals affordances for pointer, keyboard, and active scrolling", () => {
    const styles = readFileSync(new URL("../src/global.css", import.meta.url), "utf8");

    expect(styles).toContain("scrollbar-gutter: stable");
    expect(styles).toContain(".chat-scroll-region.is-scrolling");
    expect(styles).toContain(".chat-scroll-region:focus-within");
    expect(styles).toContain(".chat-scroll-region:focus-visible");
    expect(styles).not.toMatch(/\.chat-scroll-region::-[^{]+\{[^}]*width:\s*0/s);
  });

  it("uses one bounded document column and removes the nested Markdown preview scroller", () => {
    const conversation = readFileSync(new URL("../src/components/ConversationView.tsx", import.meta.url), "utf8");
    const panes = readFileSync(new URL("../src/components/panes.tsx", import.meta.url), "utf8");

    expect(conversation).toContain("data-chat-column");
    expect(conversation).toContain('width: "min(800px, 100%)"');
    expect(panes).not.toContain('maxHeight: "60vh", overflow: "auto"');
    expect(panes).toContain('tabIndex={0}');
  });
});
