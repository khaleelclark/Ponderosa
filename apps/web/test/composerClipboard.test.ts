import { describe, expect, it } from "vitest";
import { filesFromClipboard, selectComposerFiles } from "../src/components/panes";

const file = (name: string, type: string, size = 4) => new File([new Uint8Array(size)], name, { type });

describe("composer clipboard attachments", () => {
  it("extracts only clipboard file items and preserves browser metadata", () => {
    const image = file("pasted-image.png", "image/png");
    const document = file("notes.pdf", "application/pdf");
    expect(filesFromClipboard([
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => image },
      { kind: "file", getAsFile: () => document },
    ])).toEqual([image, document]);
  });

  it("accepts images and general files supported by the shared upload endpoint", () => {
    const candidates = [
      file("screen.png", "image/png"),
      file("context.pdf", "application/pdf"),
      file("logs.txt", "text/plain"),
      file("bundle.zip", "application/zip"),
    ];
    expect(selectComposerFiles([], candidates)).toEqual({ accepted: candidates, error: undefined });
  });

  it("rejects unsupported, oversized, and over-total files before upload", () => {
    const eightMiB = 8 * 1024 * 1024;
    const current = [file("one.pdf", "application/pdf", eightMiB), file("two.pdf", "application/pdf", eightMiB)];
    const candidates = [
      file("three.pdf", "application/pdf", eightMiB),
      file("too-large.pdf", "application/pdf", eightMiB + 1),
      file("script.html", "text/html"),
    ];
    const result = selectComposerFiles(current, candidates);
    expect(result.accepted).toEqual([candidates[0]]);
    expect(result.error).toContain("2 pasted or selected files were not attached");
  });
});
