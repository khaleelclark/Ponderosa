import type { ArtifactDto } from "@ponderosa/core";
import { isSafePresentedPath } from "../../projectPathPresentation";

function diffHeaderPath(path: string): string {
  return isSafePresentedPath(path) ? path : "artifact";
}

const DIFF_STRUCTURE = [
  /^(?:diff|Index:|Only in|Property changes on:|Common subdirectories:)(?:\s|$)/u,
  /^(?:---|\+\+\+|@@|@@@)(?:\s|$)/u,
  /^(?:rename|copy) (?:from|to)(?:\s|$)/u,
  /^(?:Binary files|Files) .+ differ$/u,
  /^GIT binary patch$/u,
  /^(?:literal|delta) \d+$/u,
  /^(?:old mode|new mode|deleted file mode|new file mode) \d+$/u,
  /^(?:similarity|dissimilarity) index \d+%$/u,
  /^index [0-9a-f]+(?:\.\.[0-9a-f]+)+(?: \d+)?$/iu,
  /^\*\*\*(?:\s|$)/u,
  /^\*{15}$/u,
  /^RCS file:\s/u,
  /^retrieving revision\s/u,
  /^==== .+ ====$/u,
  /^(?:Added|Modified|Deleted):\s/u,
];

function containsDiffStructure(content: string): boolean {
  return content.split("\n").some(line => DIFF_STRUCTURE.some(pattern => pattern.test(line)));
}

export function createdFileUnifiedDiff(path: string, content: string): string {
  const safePath = diffHeaderPath(path);
  const normalized = content.replace(/\r\n?/gu, "\n");
  const lines = normalized === "" ? [] : normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
  return [
    `diff --git a/${safePath} b/${safePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${safePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

export function recordedArtifactDiff(
  artifact: ArtifactDto,
  content: string,
  displayPath: string,
): string | undefined {
  return recordedPathDiff(
    content,
    displayPath,
    /^create\s+/iu.test(artifact.summary?.trim() ?? ""),
  );
}

/**
 * Rebuild a provider or workspace diff from line-counted hunks. Canonical
 * structural headers never cross this presentation boundary.
 */
export function recordedPathDiff(
  content: string,
  displayPath: string,
  createdFile = false,
): string | undefined {
  const safePath = diffHeaderPath(displayPath);
  const normalized = content.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const firstHunk = lines.findIndex(line => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(line));
  if (firstHunk >= 0) {
    const headers = lines.slice(0, firstHunk);
    const beforeMissing = headers.some(line => /^--- \/dev\/null(?:\t.*)?$/u.test(line));
    const afterMissing = headers.some(line => /^\+\+\+ \/dev\/null(?:\t.*)?$/u.test(line));
    const safeDiff = [
      `diff --git a/${safePath} b/${safePath}`,
      beforeMissing ? "--- /dev/null" : `--- a/${safePath}`,
      afterMissing ? "+++ /dev/null" : `+++ b/${safePath}`,
    ];
    let includedHunk = false;
    for (let index = firstHunk; index < lines.length; index += 1) {
      const hunk = lines[index]!.match(/^(@@ -(?:\d+)(?:,(\d+))? \+(?:\d+)(?:,(\d+))? @@)/u);
      if (!hunk) continue;
      let oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      let newRemaining = hunk[3] === undefined ? 1 : Number(hunk[3]);
      const hunkLines = [hunk[1]!];
      while (index + 1 < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
        const line = lines[index + 1]!;
        if (line.startsWith("\\")) {
          hunkLines.push("\\ No newline at end of file");
          index += 1;
          continue;
        }
        if (line.startsWith(" ")) {
          oldRemaining -= 1;
          newRemaining -= 1;
        } else if (line.startsWith("-")) oldRemaining -= 1;
        else if (line.startsWith("+")) newRemaining -= 1;
        else break;
        hunkLines.push(line);
        index += 1;
      }
      if (oldRemaining === 0 && newRemaining === 0) {
        safeDiff.push(...hunkLines);
        includedHunk = true;
      }
    }
    if (includedHunk) return safeDiff.join("\n");
  }
  if (createdFile
    && !containsDiffStructure(normalized)
    && !/No diff text was provided by the engine\./iu.test(normalized)) {
    return createdFileUnifiedDiff(safePath, normalized);
  }
  return undefined;
}
