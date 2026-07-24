import { renderToStaticMarkup } from "react-dom/server";
import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { FilePreview } from "../src/components/filePreview/FilePreview";
import { normalizedMediaType, previewCapability } from "../src/components/filePreview/mimeCapabilities";

describe("MIME-aware file previews", () => {
  it("uses one deterministic registry with extension fallback and rejects active HTML embeds", () => {
    expect(normalizedMediaType("application/octet-stream", "report.MD")).toBe("text/markdown");
    expect(previewCapability({ mediaType: "image/png" }).kind).toBe("image");
    expect(previewCapability({ mediaType: "application/pdf" }).kind).toBe("pdf");
    expect(previewCapability({ mediaType: "text/plain", artifactKind: "diff" }).kind).toBe("diff");
    expect(previewCapability({ mediaType: "text/html" })).toEqual({
      kind: "unsupported",
      label: "HTML document",
      inline: false,
    });
  });

  it("renders image, Markdown, text, PDF, and diff semantics with accessible actions", () => {
    const image = renderToStaticMarkup(<FilePreview title="Screenshot" mediaType="image/png" previewUrl="/preview/image" downloadUrl="/download/image" />);
    expect(image).toContain('data-preview-capability="image"');
    expect(image).toContain('alt="Screenshot"');
    expect(image).toContain('href="/preview/image"');
    expect(image).toContain('href="/download/image"');

    const markdown = renderToStaticMarkup(<FilePreview title="Readme" path="README.md" content="# Heading" />);
    expect(markdown).toContain('data-preview-capability="markdown"');
    expect(markdown).toContain("<h1>Heading</h1>");

    const text = renderToStaticMarkup(<FilePreview title="Config" mediaType="application/json" content='{"safe":true}' />);
    expect(text).toContain('aria-label="Text preview for Config"');

    const pdf = renderToStaticMarkup(<FilePreview title="Report" mediaType="application/pdf" previewUrl="/preview/report" />);
    expect(pdf).toContain('data-testid="file-pdf-preview"');
    expect(pdf).toContain('title="Preview Report"');

    const diff = renderToStaticMarkup(<FilePreview title="Patch" contentType="diff" content={"@@ -1 +1 @@\n-old\n+new"} />);
    expect(diff).toContain('aria-label="Unified diff"');
    expect(diff).toContain('data-diff-line-kind="addition"');
    expect(diff).toContain('data-diff-line-kind="deletion"');
  });

  it("distinguishes loading, error, empty, and unsupported states", () => {
    const loading = create(<FilePreview title="Loading" loading hideHeader />);
    expect(loading.root.findByProps({ role: "status" }).props["aria-live"]).toBe("polite");
    loading.unmount();

    expect(renderToStaticMarkup(<FilePreview title="Error" error="network failed" hideHeader />)).toContain("network failed");
    expect(renderToStaticMarkup(<FilePreview title="Empty" mediaType="text/plain" content="" hideHeader />)).toContain("This file is empty.");
    const unsupported = renderToStaticMarkup(<FilePreview title="Page" mediaType="text/html" previewUrl="/unsafe" hideHeader />);
    expect(unsupported).toContain('data-preview-capability="unsupported"');
    expect(unsupported).not.toContain("<iframe");
    expect(unsupported).toContain("cannot be displayed safely");
  });

});
