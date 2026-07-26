// @vitest-environment node

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { ChatAttachments } from "../src/components/chat/ChatAttachments";
import { Composer } from "../src/components/chat/Composer";
import { createPonderosaTheme } from "../src/theme";

describe("general asset UI contract", () => {
  it("offers only server-supported formats and retains 44px attachment actions", () => {
    const view = create(<QueryClientProvider client={new QueryClient()}>
      <Composer disabled={false} running={false} onSend={() => undefined} />
    </QueryClientProvider>);
    const input = view.root.findByType("input");
    expect(input.props.accept).toContain("application/pdf");
    expect(input.props.accept).toContain("text/plain");
    expect(input.props.accept).toContain("application/json");
    expect(input.props.accept).toContain("application/zip");
    expect(input.props.accept).not.toContain("image/gif");
    const add = view.root.findByProps({ "aria-label": "Add attachment or capability" });
    expect(add.props.sx).toBeUndefined();
    expect(createPonderosaTheme("light").components?.MuiIconButton?.styleOverrides?.root)
      .toMatchObject({ minWidth: 44, minHeight: 44 });
  });

  it("renders chat attachment previews separately from general download metadata", () => {
    const attachmentHtml = renderToStaticMarkup(<ChatAttachments attachments={[
      { id: "image", agentId: "a", name: "preview.png", mediaType: "image/png", size: 10, url: "/image", previewUrl: "/preview" },
      { id: "pdf", agentId: "a", name: "brief.pdf", mediaType: "application/pdf", size: 20, url: "/pdf", downloadUrl: "/download" },
    ]} />);
    expect(attachmentHtml).toContain('src="/preview"');
    expect(attachmentHtml).toContain("application/pdf · 20 bytes");
    expect(attachmentHtml).toContain('href="/download"');
    expect(attachmentHtml).toContain('aria-label="Download brief.pdf"');
    expect(attachmentHtml).toContain("min-height:44px");
  });
});
