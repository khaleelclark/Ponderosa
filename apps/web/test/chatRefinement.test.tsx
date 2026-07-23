import type { ConversationMessageDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ConversationMessage, conversationComposerRuntime } from "../src/components/ConversationView";
import { ChatMarkdown } from "../src/components/chat/ChatMessages";
import { Composer } from "../src/components/chat/Composer";
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
        commands: [{ name: "review", description: "Review", source: "skill", acceptsArguments: true, insertText: "$review ", status: "available", invocation: "prompt" }],
        mcpServers: [],
        composerCapabilities: [{ id: "skill:review", kind: "skill", label: "review", description: "Review", status: "available", insertText: "$review " }],
      }],
    );
    expect(runtime.commands.map((command) => command.name)).toEqual(["review"]);
    expect(runtime.capabilities.map((capability) => capability.id)).toEqual(["skill:review"]);
    expect(conversationComposerRuntime({ id: "runtime-a", authenticated: false, available: false }, []).capabilities).toEqual([]);

    const source = readFileSync(new URL("../src/components/ConversationView.tsx", import.meta.url), "utf8");
    expect(source).toContain("capabilities={directReplyAgent ? directReplyEngineCapabilities?.composerCapabilities ?? [] : composerRuntime.capabilities}");
    expect(source).toContain("onCommand={activeEngine ?");
    expect(source).toContain("api.invokeProjectProviderCommand(conversation.projectId");
    expect(source).not.toContain('capabilities={activeView === "main"');
  });

  it("changes slash choices by provider/model/session and excludes Ponderosa control aliases", () => {
    const command = (name: string, status: "available" | "unavailable" = "available") => ({
      name, description: name, source: "built-in" as const, acceptsArguments: false,
      insertText: `/${name}`, status, invocation: "runtime" as const,
      ...(status === "unavailable" ? { unavailableReason: "Selected model is unavailable." } : {}),
    });
    const codex = conversationComposerRuntime(
      { id: "codex", authenticated: true, available: true },
      [{ engineId: "codex", steering: true, persistentSessions: true, model: "model-a", sessionId: "thread-a", commands: [command("compact")], mcpServers: [], composerCapabilities: [] }],
    );
    const changedModel = conversationComposerRuntime(
      { id: "codex", authenticated: true, available: true },
      [{ engineId: "codex", steering: true, persistentSessions: true, model: "model-b", sessionId: "thread-a", commands: [command("compact", "unavailable")], mcpServers: [], composerCapabilities: [] }],
    );
    const claude = conversationComposerRuntime(
      { id: "claude", authenticated: true, available: true },
      [{ engineId: "claude", steering: true, persistentSessions: true, model: "sonnet", sessionId: "claude-b", commands: [{ ...command("plugin:review"), source: "plugin", invocation: "prompt" }], mcpServers: [], composerCapabilities: [] }],
    );
    expect(codex.commands).toMatchObject([{ name: "compact", status: "available" }]);
    expect(changedModel.commands).toMatchObject([{ name: "compact", status: "unavailable" }]);
    expect(claude.commands.map((item) => item.name)).toEqual(["plugin:review"]);
    expect([...codex.commands, ...changedModel.commands, ...claude.commands].some((item) => ["cancel", "fresh", "status"].includes(item.name))).toBe(false);

    const agentDetail = readFileSync(new URL("../src/components/AgentDetail.tsx", import.meta.url), "utf8");
    expect(agentDetail).toContain("Start Fresh Provider Session");
    expect(agentDetail).toContain("inventory ${inventoriedMcps.length}/${configuredMcps.length}");
    expect(agentDetail).not.toMatch(/name:\s*["'](?:cancel|fresh|status)["']/);
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
        projectId="project-1"
      />,
    );
    expect(html).toContain("src/app.ts");
    expect(html).toContain("+12");
    expect(html).toContain("−3");
    expect(html).toContain("1 changed file");
    expect(html).toContain("Open focused diff for src/app.ts");
    expect(html).toContain(">Review All</button>");
    expect(html).toContain("Open agent Agent One from profile image");
    expect(html).toContain("Open agent Agent One from name");
  });

  it("focuses direct replies and supports hover/focus/touch action disclosure", () => {
    const actions = readFileSync(new URL("../src/global.css", import.meta.url), "utf8");
    const composer = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
      <Composer disabled={false} running={false} focusReply onSend={() => undefined} />
    </QueryClientProvider>);
    expect(composer).toContain('aria-label="Message"');
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
    const documentCard = readFileSync(new URL("../src/components/chat/ChatDocumentCard.tsx", import.meta.url), "utf8");
    const html = renderToStaticMarkup(
      <ConversationMessage
        message={baseMessage}
        conversation="main"
        agentTitle={() => "Agent One"}
        agentIdForHandle={() => undefined}
        onOpenAgent={vi.fn()}
        projectId="project-1"
      />,
    );

    expect(conversation).toContain("data-chat-column");
    expect(conversation).toContain('width: "min(1180px, 100%)"');
    expect(html).toContain("width:min(1120px, 100%)");
    expect(documentCard).not.toContain('maxHeight: "60vh", overflow: "auto"');
    expect(documentCard).toContain('className="ponderosa-scroll"');
  });

  it("renders Markdown soft newlines as paragraph whitespace while preserving block and fenced-code structure", () => {
    const html = renderToStaticMarkup(<ChatMarkdown compact>{
      "First line\nsecond line\n\nThird paragraph\n\n- One\n- Two\n\n> Quoted first\n> quoted second\n\n```text\nalpha\n  beta\n```"
    }</ChatMarkdown>);

    expect(html).toContain("<p>First line\nsecond line</p>");
    expect(html).not.toContain("<br");
    expect(html.match(/<p>/gu)).toHaveLength(3);
    expect(html).toContain("<ul>");
    expect(html.match(/<li>/gu)).toHaveLength(2);
    expect(html).toMatch(/<ul>\s*<li>One<\/li>\s*<li>Two<\/li>\s*<\/ul>/u);
    expect(html).toMatch(/<blockquote>\s*<p>Quoted first\nquoted second<\/p>\s*<\/blockquote>/u);
    expect(html).not.toContain("white-space:pre-wrap");
    expect(html).toContain("white-space:pre");
    expect(html).toContain("alpha\n  beta");
  });
});
