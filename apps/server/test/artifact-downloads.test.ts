import { describe, expect, it } from "vitest";
import { contentDisposition, managedArtifactDownloadName } from "../src/assets.js";

/**
 * A recorded diff once downloaded as `Mutant-Knights-Riftfront-1.2.0-READY.jar`
 * carrying 115 bytes of patch text, because the download name came from the
 * artifact's `summary` -- which for a `file_change` projection is the prose
 * `"<change> <host path>"`, not a filename. The operator copied it into a mods
 * folder and Forge rejected it with `zip END header not found`.
 *
 * The managed-artifact write path needs Linux descriptor-relative filesystem
 * access, so the full route cannot be exercised here. These cover the two pure
 * functions the defect actually lived in.
 */
describe("managed artifact download naming", () => {
  it("names a recorded diff after its patch file, not the path in its summary", () => {
    expect(managedArtifactDownloadName({
      kind: "diff",
      path: "artifacts/000123/diff.patch",
      summary: "create /home/phoenix/mutant/Mutant-Knights-Riftfront-1.2.0-READY.jar",
    })).toBe("diff.patch");
  });

  it("keeps the recorded name of a generated file", () => {
    expect(managedArtifactDownloadName({
      kind: "generated_file",
      path: "artifacts/000124/report.pdf",
      summary: "Quarterly report.pdf",
    })).toBe("Quarterly report.pdf");
  });

  it("falls back to the artifact path when a generated file has no recorded name", () => {
    expect(managedArtifactDownloadName({
      kind: "generated_file",
      path: "artifacts/000125/export.csv",
      summary: "   ",
    })).toBe("export.csv");
  });

  it("uses the artifact path for every other kind that carries prose", () => {
    for (const artifact of [
      { kind: "test_report" as const, path: "artifacts/000126/test.md", summary: "pass: 42 assertions" },
      { kind: "log" as const, path: "artifacts/000127/command.md", summary: "pnpm build --filter web" },
      { kind: "screenshot" as const, path: "artifacts/000128/shot.png", summary: "Browser screenshot (1280×800)" },
    ]) {
      expect(managedArtifactDownloadName(artifact)).toBe(artifact.path.split("/").pop());
    }
  });
});

describe("contentDisposition", () => {
  it("never lets a path inside the value decide the saved name", () => {
    const header = contentDisposition("create /home/phoenix/mutant/Mutant-Knights-1.2.0-READY.jar");
    expect(header).toBe(
      `attachment; filename="Mutant-Knights-1.2.0-READY.jar"; filename*=UTF-8''Mutant-Knights-1.2.0-READY.jar`,
    );
    expect(header).not.toContain("%2F");
    expect(header).not.toContain("/");
  });

  it("reduces a Windows-style path the same way", () => {
    expect(contentDisposition("C:\\Users\\phoenix\\report.pdf"))
      .toContain(`filename="report.pdf"`);
  });

  it("keeps both parameters describing the same file for non-ASCII names", () => {
    const header = contentDisposition("отчёт.pdf");
    expect(header).toContain(`filename="_____.pdf"`);
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent("отчёт.pdf")}`);
  });

  it("substitutes a placeholder rather than emitting an empty filename", () => {
    expect(contentDisposition("/")).toContain(`filename="asset"`);
    expect(contentDisposition("")).toContain(`filename="asset"`);
  });
});
