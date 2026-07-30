import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  expectedClaudeGuiExecutable,
  newestClaudeDesktopManagedCli,
} from "./macos-provider-evidence.mjs";

test("selects the newest executable Desktop-managed Claude deterministically", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ponderosa-gui-claude-"));
  try {
    const executable = (version, mode = 0o755) => {
      const pathname = path.join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude-code",
        version,
        "claude.app",
        "Contents",
        "MacOS",
        "claude",
      );
      mkdirSync(path.dirname(pathname), { recursive: true });
      writeFileSync(pathname, "#!/bin/sh\nexit 0\n", { mode });
      chmodSync(pathname, mode);
      return pathname;
    };
    executable("2.1.220", 0o644);
    executable("2.1.219-A");
    const expected = executable("2.1.219-a");
    executable("2.1.99");

    assert.deepEqual(newestClaudeDesktopManagedCli(home), {
      executable: expected,
      version: "2.1.219-a",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reports Desktop-managed Claude absent when no executable version exists", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ponderosa-gui-claude-"));
  try {
    assert.equal(newestClaudeDesktopManagedCli(home), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("preserves normal macOS executable precedence ahead of Claude Desktop", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ponderosa-gui-claude-"));
  try {
    const desktop = path.join(
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
    );
    const pathBin = path.join(home, "gui-bin");
    const standard = path.join(pathBin, "claude");
    for (const pathname of [desktop, standard]) {
      mkdirSync(path.dirname(pathname), { recursive: true });
      writeFileSync(pathname, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      chmodSync(pathname, 0o755);
    }
    assert.deepEqual(expectedClaudeGuiExecutable(home, pathBin), {
      executable: standard,
      providerClass: "standard",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
