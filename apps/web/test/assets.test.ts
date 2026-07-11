import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panes = readFileSync(new URL("../src/components/panes.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api/real.ts", import.meta.url), "utf8");

describe("general asset UI contract", () => {
  it("offers only server-supported formats and retains 44px attachment actions", () => {
    expect(panes).toContain("application/pdf,text/plain,application/json,application/zip");
    expect(panes).not.toContain("image/gif");
    expect(panes).toContain('aria-label="Attach assets"');
    expect(panes).toContain("minWidth: 44, minHeight: 44");
  });

  it("renders safe previews separately from general download metadata", () => {
    expect(panes).toContain("attachment.previewUrl || attachment.mediaType.startsWith");
    expect(panes).toContain("attachment.downloadUrl ?? attachment.url");
    expect(panes).toContain('aria-label={`Download ${attachment.name}`}');
  });

  it("uploads bytes through the binary parser while preserving declared type separately", () => {
    expect(api).toContain('"content-type": "application/octet-stream"');
    expect(api).toContain('"x-ponderosa-media-type": file.type');
  });
});
