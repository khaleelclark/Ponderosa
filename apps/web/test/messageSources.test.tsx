import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatPane, splitMessageSources } from "../src/components/panes";

describe("message sources", () => {
  it("keeps source markdown associated with the message and renders it in a footer", () => {
    const text = "Answer with **formatting**.\n\n## Sources\n\n- [Primary docs](https://example.com/docs)\n- Original title";
    expect(splitMessageSources(text)).toEqual({
      body: "Answer with **formatting**.",
      sources: "## Sources\n\n- [Primary docs](https://example.com/docs)\n- Original title",
    });
    const html = renderToStaticMarkup(<ChatPane agentName="Agent" messages={[{
      id: "m1", threadId: "a1", seq: 1, role: "assistant", text, createdAt: "2026-07-12T01:00:00.000Z",
    }]} />);
    expect(html).toContain('aria-label="Sources"');
    expect(html).toContain("<strong>formatting</strong>");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html.indexOf("Answer with")).toBeLessThan(html.indexOf("Sources"));
  });
});
