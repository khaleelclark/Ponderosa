import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostPlatformAdapter } from "./platform.js";

describe("macOS provider executable discovery", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function executable(pathname: string): string {
    mkdirSync(path.dirname(pathname), { recursive: true });
    writeFileSync(pathname, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(pathname, 0o755);
    return pathname;
  }

  it("honors an absolute configured Codex path with a sanitized GUI PATH", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-macos-codex-"));
    roots.push(root);
    const codex = executable(path.join(root, "opt", "homebrew", "bin", "codex"));
    const candidates = hostPlatformAdapter("darwin").executableCandidates(
      "codex",
      {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PONDEROSA_CODEX_BIN: codex,
      },
      root,
    );
    expect(candidates[0]).toBe(codex);
  });

  it("discovers the newest executable managed by Claude Desktop", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ponderosa-macos-claude-"));
    roots.push(home);
    const older = executable(path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
      "2.1.99",
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    ));
    const newest = executable(path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
      "2.1.219",
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    ));
    const tiedUpper = executable(path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
      "2.1.219-A",
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    ));
    const tiedLower = executable(path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
      "2.1.219-a",
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    ));
    const candidates = hostPlatformAdapter("darwin").executableCandidates(
      "claude",
      { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      home,
    );
    expect(candidates).toContain(older);
    expect(candidates.indexOf(tiedLower)).toBeLessThan(candidates.indexOf(tiedUpper));
    expect(candidates.indexOf(tiedUpper)).toBeLessThan(candidates.indexOf(newest));
    expect(candidates.indexOf(newest)).toBeLessThan(candidates.indexOf(older));
  });
});
