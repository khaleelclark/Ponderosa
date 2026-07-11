import type { MessageDto } from "@ponderosa/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatPane } from "../src/components/panes";

function message(id: string, role: MessageDto["role"], text: string): MessageDto {
  return {
    id,
    threadId: "agent-1",
    seq: Number(id),
    role,
    text,
    createdAt: "2026-07-11T00:00:00.000Z",
  };
}

describe("individual chat sender identity", () => {
  it("renders accessible, visible identities for both participants", () => {
    const html = renderToStaticMarkup(createElement(ChatPane, {
      agentName: "Great Smoky Mountains",
      messages: [message("1", "user", "Please review this."), message("2", "assistant", "Review complete.")],
    }));

    expect(html).toContain('aria-label="You message"');
    expect(html).toContain(">You</div>");
    expect(html).toContain('aria-label="Great Smoky Mountains message"');
    expect(html).toContain(">Great Smoky Mountains</div>");
  });

  it("escapes identity text instead of treating agent titles as markup", () => {
    const html = renderToStaticMarkup(createElement(ChatPane, {
      agentName: "Review <script>alert(1)</script> & QA",
      messages: [message("1", "assistant", "Safe content")],
    }));

    expect(html).toContain("Review &lt;script&gt;alert(1)&lt;/script&gt; &amp; QA");
    expect(html).not.toContain("<script>");
  });
});
