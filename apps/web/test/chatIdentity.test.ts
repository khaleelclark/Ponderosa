import type { MessageDto } from "@ponderosa/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatPane } from "../src/components/panes";

function message(id: string, role: MessageDto["role"], text: string): MessageDto {
  return {
    id,
    agentId: "agent-1",
    seq: Number(id),
    role,
    text,
    createdAt: "2026-07-11T00:00:00.000Z",
  };
}

describe("individual chat sender identity", () => {
  it("renders each participant as a screen-reader-labelled message article", () => {
    const html = renderToStaticMarkup(createElement(ChatPane, {
      agentName: "Great Smoky Mountains",
      messages: [message("1", "user", "Please review this."), message("2", "assistant", "Review complete.")],
    }));

    expect(html.match(/<article/g)).toHaveLength(2);
    expect(html).toMatch(/<article[^>]+aria-label="You message"[^>]*>.*>You<\/div>.*Please review this\./);
    expect(html).toMatch(/<article[^>]+aria-label="Great Smoky Mountains message"[^>]*>.*>Great Smoky Mountains<\/div>.*Review complete\./);
    expect(html.indexOf("You</div>")).toBeLessThan(html.indexOf("Please review this."));
    expect(html.indexOf("Great Smoky Mountains</div>")).toBeLessThan(html.indexOf("Review complete."));
  });

  it("keeps Unicode titles selectable, direction-aware, and escaped", () => {
    const html = renderToStaticMarkup(createElement(ChatPane, {
      agentName: "مراجعة / проверка / 完了 <script>alert(1)</script> & QA",
      messages: [message("1", "assistant", "Safe content")],
    }));

    expect(html).toContain("مراجعة / проверка / 完了 &lt;script&gt;alert(1)&lt;/script&gt; &amp; QA");
    expect(html).toContain('dir="auto"');
    expect(html).toContain("user-select:text");
    expect(html).toContain("unicode-bidi:plaintext");
    expect(html).not.toContain("<script>");
  });

  it("uses an accessible fallback without disturbing attachment or timestamp actions", () => {
    const assistant = {
      ...message("2", "assistant", "See the attachment."),
      attachments: [{ id: "attachment-1", name: "result.png", url: "/result.png", mimeType: "image/png", size: 123 }],
    } satisfies MessageDto;
    const html = renderToStaticMarkup(createElement(ChatPane, {
      agentName: "   ",
      messages: [message("1", "user", "Original request"), assistant],
    }));

    expect(html).toContain('aria-label="Agent message"');
    expect(html).toContain(">Agent</div>");
    expect(html).toContain('aria-label="Download result.png"');
    expect(html).toContain("<time");
  });

  it("keeps the individual-chat self identity distinct from the outer User label", () => {
    const html = renderToStaticMarkup(createElement(ChatPane, {
      agentName: "Pinnacles",
      messages: [message("1", "user", "Manager-authored message")],
    }));

    expect(html).toContain('aria-label="You message"');
    expect(html).toContain(">User</div>");
    expect(html).toContain(">You</div>");
    expect(html.indexOf(">User</div>")).toBeLessThan(html.indexOf('data-message-bubble="true"'));
    expect(html.indexOf(">You</div>")).toBeGreaterThan(html.indexOf('data-message-bubble="true"'));
    expect(html.indexOf(">You</div>")).toBeLessThan(html.indexOf("Manager-authored message"));
  });

  it("renders an inbound collaboration with the sending agent's identity", () => {
    const report = {
      ...message("2", "assistant", "Private finding for the manager."),
      authorAgentId: "child-agent",
    } satisfies MessageDto;
    const html = renderToStaticMarkup(createElement(ChatPane, {
      agentName: "Castle Clinton",
      agentNameForId: (agentId: string) => agentId === "child-agent" ? "Status QA Liaison" : undefined,
      messages: [report],
    }));

    expect(html).toContain('aria-label="Status QA Liaison message"');
    expect(html).toContain(">Status QA Liaison</div>");
    expect(html).not.toContain(">You</div>");
    expect(html).not.toContain(">Castle Clinton</div>");
  });
});
