import { describe, expect, it } from "vitest";
import { isSafePresentedPath, presentProjectPath } from "./projectPathPresentation";

describe("presentProjectPath", () => {
  it.each([
    ["Linux", "/srv/work/project", "/srv/work/project/src/index.ts", "src/index.ts"],
    ["Linux filesystem root", "/", "/srv/work/project/src/index.ts", "srv/work/project/src/index.ts"],
    ["macOS", "/Users/patrick/Project", "/Users/patrick/Project/docs/report.md", "docs/report.md"],
    ["Windows drive and case", "C:\\Work\\Project", "c:\\work\\project\\src\\index.ts", "src/index.ts"],
    ["Windows mixed separators", "C:\\Work\\Project", "C:/Work/Project/src/index.ts", "src/index.ts"],
    ["Windows UNC and case", "\\\\server\\share\\Project", "\\\\SERVER\\share\\project\\src\\index.ts", "src/index.ts"],
    ["Windows relative", "C:\\Work\\Project", "src\\index.ts", "src/index.ts"],
    ["POSIX relative", "/srv/work/project", "src/index.ts", "src/index.ts"],
    ["Project root itself", "C:\\Work\\Project", "c:\\work\\project", "."],
  ])("uses a relative display on %s", (_platform, root, candidate, displayPath) => {
    expect(presentProjectPath(root, candidate)).toEqual({
      displayPath,
      diagnosticPath: candidate,
      projectRelative: true,
    });
  });

  it.each([
    ["POSIX sibling containment", "/srv/work/project", "/srv/work/project-old/file.ts", "file.ts"],
    ["macOS case mismatch", "/Users/patrick/Project", "/Users/patrick/project/file.ts", "file.ts"],
    ["Windows sibling containment", "C:\\Work\\Project", "C:\\Work\\Project-old\\file.ts", "file.ts"],
    ["Windows cross-volume", "C:\\Work\\Project", "D:\\Work\\Project\\file.ts", "file.ts"],
    ["Windows root-relative", "C:\\Work\\Project", "\\Windows\\System32", "System32"],
    ["Windows slash-rooted", "C:\\Work\\Project", "/Windows/System32", "System32"],
    ["Windows drive-relative", "C:\\Work\\Project", "D:secret.txt", "secret.txt"],
    ["UNC cross-server", "\\\\server\\share\\Project", "\\\\other\\share\\Project\\file.ts", "file.ts"],
    ["UNC cross-share", "\\\\server\\share\\Project", "\\\\server\\other\\Project\\file.ts", "file.ts"],
    ["UNC under POSIX", "/srv/work/project", "\\\\server\\share\\Project\\file.ts", "file.ts"],
    ["uncanonical absolute traversal", "/srv/work/project", "/srv/work/project/../secret.txt", "secret.txt"],
    ["escaping relative path", "/srv/work/project", "../secret.txt", "secret.txt"],
    ["ambiguous POSIX backslashes", "/srv/work/project", "src\\index.ts", "index.ts"],
    ["contained POSIX backslash traversal", "/srv/work/project", "/srv/work/project/..\\secret.txt", "secret.txt"],
    ["contained POSIX Windows-looking filename", "/srv/work/project", "/srv/work/project/C:\\Windows\\System32", "System32"],
    ["contained POSIX UNC-looking filename", "/srv/work/project", "/srv/work/project/\\\\server\\share\\private.txt", "private.txt"],
    ["invalid relative Windows stream", "C:\\Work\\Project", "src\\file.txt:secret", "file.txt:secret"],
    ["relative Project root", "work/project", "src/index.ts", "index.ts"],
  ])("fails presentation closed for %s", (_name, root, candidate, displayPath) => {
    expect(presentProjectPath(root, candidate)).toEqual({
      displayPath,
      diagnosticPath: candidate,
      projectRelative: false,
    });
  });

  it.each([
    [
      "contained absolute CR/LF header injection",
      "/srv/work/project",
      "/srv/work/project/report.ts\n+++ /home/patrick/private/secret.txt",
      "secret.txt",
    ],
    [
      "contained absolute bidi override",
      "/srv/work/project",
      "/srv/work/project/report\u202etxt",
      "report�txt",
    ],
    [
      "relative ASCII control",
      "/srv/work/project",
      "reports/\u001bsecret.txt",
      "�secret.txt",
    ],
    [
      "external C1 control",
      "/srv/work/project",
      "/home/patrick/private/secret\u0085.txt",
      "secret�.txt",
    ],
  ])("neutralizes unsafe presentation characters in %s", (_name, root, candidate, displayPath) => {
    expect(presentProjectPath(root, candidate)).toEqual({
      displayPath,
      diagnosticPath: candidate,
      projectRelative: false,
    });
  });

  it("rejects every ASCII/C1 control and Unicode bidi formatting character", () => {
    const codePoints = [
      ...Array.from({ length: 0x20 }, (_, value) => value),
      ...Array.from({ length: 0x21 }, (_, value) => value + 0x7f),
      0x061c, 0x200e, 0x200f, 0x2028, 0x2029,
      ...Array.from({ length: 5 }, (_, value) => value + 0x202a),
      ...Array.from({ length: 4 }, (_, value) => value + 0x2066),
    ];

    for (const codePoint of codePoints) {
      const control = String.fromCodePoint(codePoint);
      const candidate = `/srv/work/project/report${control}.txt`;
      expect(presentProjectPath("/srv/work/project", candidate)).toEqual({
        displayPath: "report�.txt",
        diagnosticPath: candidate,
        projectRelative: false,
      });
    }
  });

  it.each([
    "src\\index.ts",
    "..\\secret.txt",
    "C:\\Windows\\System32",
    "\\\\server\\share\\private.txt",
  ])("rejects ambiguous separators before diff-header construction: %s", value => {
    expect(isSafePresentedPath(value)).toBe(false);
  });
});
