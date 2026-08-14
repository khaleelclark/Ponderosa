import { describe, expect, it } from "vitest";
import type { ArtifactDto } from "@ponderosa/core";
import { artifactDisplayLabel, artifactDisplayPath, artifactSearchText } from "./artifactPresentation";

function artifact(overrides: Partial<ArtifactDto> = {}): ArtifactDto {
  return {
    id: "artifact-1",
    agentId: "agent-1",
    kind: "diff",
    path: "managed/artifact.diff",
    sourcePath: "/srv/projects/demo/src/index.ts",
    summary: "edit /srv/projects/demo/src/index.ts",
    createdAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("artifact presentation", () => {
  it("uses a Project-relative path and never renders a provider summary path", () => {
    const item = artifact();
    const displayPath = artifactDisplayPath(item, "/srv/projects/demo");
    expect(displayPath).toBe("src/index.ts");
    expect(artifactDisplayLabel(item, displayPath)).toBe("Edit · src/index.ts");
  });

  it("fails outside paths closed to a basename", () => {
    const item = artifact({ sourcePath: "C:\\Users\\patrick\\secret.pdf", kind: "document" });
    const displayPath = artifactDisplayPath(item, "C:\\Work\\Project");
    expect(displayPath).toBe("secret.pdf");
    expect(artifactDisplayLabel(item, displayPath)).toBe("secret.pdf");
  });

  it.each([
    ["test_report", "Test report"],
    ["pr_summary", "Pull request summary"],
    ["screenshot", "Browser screenshot"],
    ["log", "Command output"],
  ] as const)("does not expose an arbitrary %s summary", (kind, expected) => {
    const item = artifact({ kind, summary: "result at /home/patrick/private/output.txt" });
    expect(artifactDisplayLabel(item)).toBe(expected);
  });

  it("indexes only safe presented artifact values", () => {
    const item = artifact({
      path: "managed/private-result.diff",
      sourcePath: "/home/patrick/private/secret-name.ts",
      summary: "edit payroll-token-9831 at /home/patrick/private/secret-name.ts",
    });
    const searchText = artifactSearchText(item, "/srv/projects/demo");
    expect(searchText).toContain("secret-name.ts");
    expect(searchText).toContain("diff");
    expect(searchText).not.toContain("/home/patrick");
    expect(searchText).not.toContain("payroll-token-9831");
    expect(searchText).not.toContain("managed/private-result.diff");
  });

  it("does not index a control-character path injection", () => {
    const sourcePath = "/srv/projects/demo/report.ts\n+++ /home/patrick/private/secret.txt";
    const item = artifact({ sourcePath, summary: `edit ${sourcePath}` });
    const displayPath = artifactDisplayPath(item, "/srv/projects/demo");
    const searchText = artifactSearchText(item, "/srv/projects/demo");

    expect(displayPath).toBe("secret.txt");
    expect(searchText).toContain("secret.txt");
    expect(searchText).not.toContain("patrick");
    expect(searchText).not.toContain("+++");
    expect(searchText).not.toContain("\n");
  });
});
