import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { artifactDisplayLabel } from "../src/components/panes";

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
    expect(panes).toContain("attachment.previewUrl || !attachment.mediaType || attachment.mediaType.startsWith");
    expect(panes).toContain("attachment.downloadUrl ?? attachment.url");
    expect(panes).toContain('aria-label={`Download ${attachment.name}`}');
  });

  it("uploads bytes through the binary parser while preserving declared type separately", () => {
    expect(api).toContain('"content-type": "application/octet-stream"');
    expect(api).toContain('"x-ponderosa-media-type": file.type');
  });
});
