import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { defaultEngineRegistrations } from "./index.js";

describe("default engine executable binding", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("binds launcher-resolved absolute provider paths into both runtime adapters", () => {
    const env = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      PONDEROSA_CODEX_BIN: "/opt/homebrew/bin/codex",
      PONDEROSA_CLAUDE_BIN:
        "/Users/test/Library/Application Support/Claude/claude-code/2.1.219/claude.app/Contents/MacOS/claude",
    } as NodeJS.ProcessEnv;
    const registrations = defaultEngineRegistrations(env);
    const codex = registrations.find(({ adapter }) => adapter.id === "codex")?.adapter;
    const claude = registrations.find(({ adapter }) => adapter.id === "claude")?.adapter;
    expect(codex).toBeInstanceOf(CodexAdapter);
    expect(claude).toBeInstanceOf(ClaudeAdapter);
    expect((codex as unknown as { bin: string }).bin).toBe(env.PONDEROSA_CODEX_BIN);
    expect((claude as unknown as { bin: string }).bin).toBe(env.PONDEROSA_CLAUDE_BIN);
    expect((claude as unknown as {
      modelEnvironment: Readonly<Record<string, string | undefined>>;
    }).modelEnvironment).toBe(env);
  });

  const posixIt = process.platform === "win32" ? it.skip : it;
  posixIt("uses the configured absolute Codex path for authentication with a sanitized PATH", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-engine-bin-"));
    roots.push(root);
    const codex = path.join(root, "codex");
    writeFileSync(codex, "#!/bin/sh\nprintf 'Logged in using ChatGPT\\n'\n", { mode: 0o755 });
    chmodSync(codex, 0o755);
    const registration = defaultEngineRegistrations({
      ...process.env,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      PONDEROSA_CODEX_BIN: codex,
    }).find(({ adapter }) => adapter.id === "codex");
    await expect(registration?.authStatus?.()).resolves.toEqual({
      authenticated: true,
      detail: "Logged in using ChatGPT",
    });
  });
});
