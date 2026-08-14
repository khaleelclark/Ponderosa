import { describe, expect, it } from "vitest";
import type { ArtifactDto } from "@ponderosa/core";
import { createdFileUnifiedDiff, recordedArtifactDiff, recordedPathDiff } from "./artifactDiff";

const artifact: ArtifactDto = {
  id: "diff-1",
  agentId: "agent-1",
  kind: "diff",
  path: "managed.diff",
  sourcePath: "/home/patrick/project/src/index.ts",
  summary: "edit /home/patrick/project/src/index.ts",
  createdAt: "2026-08-14T00:00:00.000Z",
};

describe("recordedArtifactDiff", () => {
  it("reconstructs a workspace diff without requiring an artifact DTO", () => {
    const rendered = recordedPathDiff([
      "diff --git a//home/phoenix/private.ts b//home/phoenix/private.ts",
      "--- /home/phoenix/private.ts",
      "+++ C:\\Users\\patrick\\private.ts",
      "@@ -1 +1 @@ trailing /home/phoenix/private.ts",
      "-old",
      "+new",
    ].join("\n"), "src/public.ts");

    expect(rendered).toBe([
      "diff --git a/src/public.ts b/src/public.ts",
      "--- a/src/public.ts",
      "+++ b/src/public.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"));
    expect(rendered).not.toContain("/home/phoenix");
    expect(rendered).not.toContain("C:\\Users");
  });

  it("does not reinterpret malformed structural headers as created-file body text", () => {
    const rendered = recordedPathDiff([
      "--- /home/phoenix/private/old.ts",
      "+++ C:\\Users\\patrick\\private.ts",
      "@@ malformed /home/phoenix/private @@",
      "+secret",
    ].join("\n"), "src/public.ts", true);

    expect(rendered).toBeUndefined();
  });

  it.each([
    ["rename from", "rename from /home/phoenix/private/old.ts"],
    ["rename to", "rename to C:\\Users\\patrick\\private.ts"],
    ["copy from", "copy from \\\\server\\share\\private.ts"],
    ["copy to", "copy to /home/phoenix/private/copied.ts"],
    ["binary files", "Binary files /home/phoenix/private/old.bin and C:\\Users\\patrick\\private.bin differ"],
    ["files differ", "Files /home/phoenix/private/old.bin and \\\\server\\share\\private.bin differ"],
    ["Git binary patch", "GIT binary patch"],
    ["context old-file header", "*** /home/phoenix/private/old.ts\t2026-08-14"],
    ["context hunk header", "*** 1,2 ****"],
    ["Subversion property header", "Property changes on: /home/phoenix/private/old.ts"],
    ["RCS header", "RCS file: /home/phoenix/private/old.ts,v"],
    ["Perforce header", "==== //depot/private/old.ts#3 - /home/phoenix/private/old.ts ===="],
  ])("fails a created-file fallback closed for %s metadata", (_name, structuralLine) => {
    expect(recordedPathDiff(structuralLine, "src/public.ts", true)).toBeUndefined();
  });

  it("preserves ordinary created-file body text", () => {
    const content = [
      "export const migrationNote = 'rename from /home/phoenix/private/old.ts';",
      "export const copyNote = 'copy to C:\\\\Users\\\\patrick\\\\private.ts';",
      "export const emphasis = '*** ordinary body text ***';",
    ].join("\n");

    const rendered = recordedPathDiff(content, "src/public.ts", true);

    expect(rendered).toContain(`+${content.split("\n")[0]}`);
    expect(rendered).toContain(`+${content.split("\n")[1]}`);
    expect(rendered).toContain(`+${content.split("\n")[2]}`);
  });

  it("neutralizes an unsafe presented path in a created-file preview", () => {
    const rendered = createdFileUnifiedDiff(
      "report.ts\n+++ /home/patrick/private/secret.txt",
      "report\n",
    );
    expect(rendered).toContain("diff --git a/artifact b/artifact");
    expect(rendered).toContain("+++ b/artifact");
    expect(rendered).not.toContain("/home/patrick");
    expect(rendered).not.toContain("\n+++ /home");
  });

  it("rewrites provider path metadata to the safe display path", () => {
    const content = [
      "diff --git a//home/patrick/project/src/index.ts b//home/patrick/project/src/index.ts",
      "Index: /home/patrick/project/src/index.ts",
      "--- /home/patrick/project/src/index.ts",
      "+++ /home/patrick/project/src/index.ts",
      "@@ -1 +1 @@ /home/patrick/private/function-name",
      "-old",
      "+new",
    ].join("\n");
    const rendered = recordedArtifactDiff(artifact, content, "src/index.ts");
    expect(rendered).toContain("diff --git a/src/index.ts b/src/index.ts");
    expect(rendered).toContain("--- a/src/index.ts");
    expect(rendered).toContain("+++ b/src/index.ts");
    expect(rendered).toContain("@@ -1 +1 @@\n-old\n+new");
    expect(rendered).not.toContain("/home/patrick");
  });

  it("preserves the null side while rewriting a created-file diff", () => {
    const content = [
      "diff --git a//Users/patrick/project/report.md b//Users/patrick/project/report.md",
      "--- /dev/null",
      "+++ /Users/patrick/project/report.md",
      "@@ -0,0 +1 @@",
      "+report",
    ].join("\n");
    const rendered = recordedArtifactDiff(artifact, content, "report.md");
    expect(rendered).toContain("--- /dev/null");
    expect(rendered).toContain("+++ b/report.md");
    expect(rendered).not.toContain("/Users/patrick");
  });

  it.each([
    "diff -u /home/patrick/private/old.ts /home/patrick/private/new.ts",
    "diff -Naur /home/patrick/private/old.ts /home/patrick/private/new.ts",
    "Index: /home/patrick/private/new.ts",
    "Only in /home/patrick/private: new.ts",
  ])("drops non-git and unknown path-bearing structural header %s", structuralHeader => {
    const content = [
      structuralHeader,
      "--- /home/patrick/private/old.ts\t2026-08-14",
      "+++ /home/patrick/private/new.ts\t2026-08-14",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const rendered = recordedArtifactDiff(artifact, content, "src/index.ts");
    expect(rendered).toBe([
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"));
    expect(rendered).not.toContain("/home/patrick");
  });

  it("does not carry structural headers between multiple unified sections", () => {
    const content = [
      "diff -u /home/patrick/one.ts /home/patrick/two.ts",
      "--- /home/patrick/one.ts",
      "+++ /home/patrick/two.ts",
      "@@ -1 +1 @@",
      "-one",
      "+two",
      "diff --git a//home/patrick/three.ts b//home/patrick/four.ts",
      "--- /home/patrick/three.ts",
      "+++ /home/patrick/four.ts",
      "@@ -2 +2 @@",
      "-three",
      "+four",
    ].join("\n");
    const rendered = recordedArtifactDiff(artifact, content, "src/index.ts");
    expect(rendered).toContain("@@ -1 +1 @@\n-one\n+two");
    expect(rendered).toContain("@@ -2 +2 @@\n-three\n+four");
    expect(rendered).not.toContain("/home/patrick");
  });

  it.each([
    "report.ts\n+++ /home/patrick/private/secret.txt",
    "report\u202etxt",
    "/home/patrick/private/secret.txt",
    "src\\secret.txt",
    "..\\secret.txt",
    "C:\\Users\\patrick\\secret.txt",
    "\\\\server\\share\\secret.txt",
  ])("neutralizes an unsafe presented path before reconstructing headers: %s", displayPath => {
    const content = [
      "--- /home/patrick/project/old.ts",
      "+++ /home/patrick/project/new.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const rendered = recordedArtifactDiff(artifact, content, displayPath);
    expect(rendered).toBe([
      "diff --git a/artifact b/artifact",
      "--- a/artifact",
      "+++ b/artifact",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"));
    expect(rendered).not.toContain("/home/patrick");
    expect(rendered).not.toContain("\u202e");
  });
});
