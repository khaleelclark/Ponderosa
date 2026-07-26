import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatPane } from "../src/components/chat/ChatPane";
import { CommunicationDocumentCard } from "../src/components/chat/ChatMessages";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

describe("message sources", () => {
  it("renders only verified structured citations in a compact footer", () => {
    const text = "Answer with **formatting**.\n\n## Sources\n\n- [Primary docs](https://example.com/docs)\n- Original title";
    const html = renderToStaticMarkup(<ChatPane agentName="Agent" messages={[{
      id: "m1", agentId: "a1", seq: 1, role: "assistant", text, createdAt: "2026-07-12T01:00:00.000Z",
      citations: [{ url: "https://example.com/verified", title: "Verified docs", verifiedAt: "2026-07-12T00:00:00.000Z" }],
    }]} />);
    expect(html).toContain('aria-label="Sources"');
    expect(html).toContain("<strong>formatting</strong>");
    expect(html).toContain('href="https://example.com/verified"');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html.indexOf("Answer with")).toBeLessThan(html.indexOf("Sources"));
  });
});

describe("communication documents", () => {
  it("renders a titled Markdown preview/download card without expanding content into chat", () => {
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><CommunicationDocumentCard document={{
      id: "doc-1", title: "Detailed Review", mediaType: "text/markdown", byteLength: 2048,
      authorAgentId: "agent-1", executionId: "run-1", createdAt: "2026-07-12T00:00:00.000Z",
      previewUrl: "/api/projects/p1/communication-documents/doc-1", downloadUrl: "/api/projects/p1/communication-documents/doc-1/download",
    }} /></QueryClientProvider>);
    expect(html).toContain("Detailed Review");
    expect(html).toContain("Preview");
    expect(html).toContain("Download");
    expect(html).toContain("2048 bytes");
    expect(html).not.toContain("Full document content");
  });
});
