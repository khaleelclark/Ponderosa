import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { artifactDisplayLabel } from "../src/components/panes";
import { AttachmentPreview } from "../src/components/filePreview/AttachmentPreview";
import { ChatAttachments } from "../src/components/chat/ChatAttachments";

const panes = readFileSync(new URL("../src/components/panes.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api/real.ts", import.meta.url), "utf8");

describe("general asset UI contract", () => {
  it("presents file changes and shell results with compact human labels", () => {
    expect(artifactDisplayLabel({ kind: "diff", path: "artifact.diff", summary: "edit /very/long/path/report.md" })).toBe("Edit · report.md");
    expect(artifactDisplayLabel({ kind: "log", path: "result.log", summary: "/bin/bash -lc test -f report.md" })).toBe("Command · test -f report.md");
  });

  it("offers only server-supported formats and retains 44px attachment actions", () => {
    expect(panes).toContain("application/pdf,text/plain,application/json,application/zip");
    expect(panes).not.toContain("image/gif");
    expect(panes).toContain('aria-label="Add attachment or capability"');
    expect(panes).toContain("Upload image or file");
    expect(panes).toContain("minWidth: 44, minHeight: 44");
  });

  it("renders safe previews separately from general download metadata", () => {
    const previewHtml = renderToStaticMarkup(createElement(AttachmentPreview, { attachment: {
      id: "file-1",
      name: "report.pdf",
      mediaType: "application/pdf",
      size: 4096,
      url: "/asset",
      previewUrl: "/asset/preview",
      downloadUrl: "/asset/download",
    } }));
    expect(previewHtml).toContain('data-preview-capability="pdf"');
    expect(previewHtml).not.toContain("<iframe");
    expect(previewHtml).toContain('href="/asset/preview"');
    expect(previewHtml).toContain('href="/asset/download"');
    expect(previewHtml).toContain('aria-label="Download report.pdf"');

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

  it("uploads bytes through the binary parser while preserving declared type separately", () => {
    expect(api).toContain('"content-type": "application/octet-stream"');
    expect(api).toContain('"x-ponderosa-media-type": file.type');
  });
});
