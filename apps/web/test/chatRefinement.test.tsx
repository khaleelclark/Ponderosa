import type { ConversationMessageDto } from "@ponderosa/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ConversationMessage } from "../src/components/ConversationView";
import { replyPreviewText } from "../src/components/panes";

const baseMessage: ConversationMessageDto = {
  id: "message-1",
  conversationId: "conversation-1",
  role: "assistant",
  authorAgentId: "agent-1",
  text: "Completed the requested change.",
  createdAt: "2026-07-15T00:00:00.000Z",
  fileActivity: [{ path: "src/app.ts", kind: "edit", status: "completed", additions: 12, deletions: 3 }],
};

describe("chat interaction refinement", () => {
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
    expect(html).toContain(">Review</button>");
  });

  it("focuses direct replies and supports hover/focus/touch action disclosure", () => {
    const composer = readFileSync(new URL("../src/components/panes.tsx", import.meta.url), "utf8");
    const actions = readFileSync(new URL("../src/global.css", import.meta.url), "utf8");
    expect(composer).toContain("focusReply");
    expect(composer).toContain("inputRef.current?.focus()");
    expect(actions).toContain(".chat-message:hover");
    expect(actions).toContain(".chat-message-actions.revealed");
  });
});
