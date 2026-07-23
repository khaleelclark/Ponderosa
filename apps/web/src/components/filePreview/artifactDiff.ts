import type { ArtifactDto } from "@ponderosa/core";

export function createdFileUnifiedDiff(path: string, content: string): string {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const lines = normalized === "" ? [] : normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

export function recordedArtifactDiff(artifact: ArtifactDto, content: string): string | undefined {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const hasDiffStructure = /^(?:diff --git |@@ |--- |\+\+\+ )/mu.test(normalized)
    && /^(?:\+(?!\+\+)|-(?!--))/mu.test(normalized);
  if (hasDiffStructure) return normalized;
  if (/^create\s+/iu.test(artifact.summary?.trim() ?? "") && !/No diff text was provided by the engine\./iu.test(normalized)) {
    return createdFileUnifiedDiff(artifact.sourcePath ?? artifact.summary!.trim().replace(/^create\s+/iu, ""), normalized);
  }
  return undefined;
}
