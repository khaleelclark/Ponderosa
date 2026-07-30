import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAvailabilityStatus, codexAuthStatus } from "./auth.js";
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

  posixIt("normalizes whitespace-only provider overrides before authentication probes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-engine-path-"));
    roots.push(root);
    const codex = path.join(root, "codex");
    writeFileSync(codex, "#!/bin/sh\nprintf 'Logged in using ChatGPT\\n'\n", { mode: 0o755 });
    chmodSync(codex, 0o755);
    await expect(codexAuthStatus({
      ...process.env,
      PATH: `${root}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      PONDEROSA_CODEX_BIN: "   ",
    })).resolves.toEqual({
      authenticated: true,
      detail: "Logged in using ChatGPT",
    });

    let observedClaudeBin = "";
    await expect(claudeAvailabilityStatus(
      { PONDEROSA_CLAUDE_BIN: "\t " },
      async (bin) => {
        observedClaudeBin = bin;
        return { stdout: JSON.stringify({ result: "PONDEROSA_RUNTIME_READY" }), stderr: "" };
      },
      async () => ({ authenticated: true, detail: "subscription" }),
    )).resolves.toEqual({
      available: true,
      detail: "Claude accepted a subscription-backed test request",
    });
    expect(observedClaudeBin).toBe("claude");
  });

  posixIt("cancels and observes a hanging version helper when model discovery fails", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-claude-discovery-"));
    roots.push(root);
    const claude = path.join(root, "claude");
    const versionPid = path.join(root, "version.pid");
    writeFileSync(claude, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "$$" > "$PONDEROSA_TEST_VERSION_PID"
  trap 'exit 0' TERM INT
  while :; do sleep 1; done
fi
while [ ! -f "$PONDEROSA_TEST_VERSION_PID" ]; do sleep 0.01; done
exit 9
`, { mode: 0o755 });
    chmodSync(claude, 0o755);
    const handles: Array<{ isAlive(): boolean; close(): Promise<void> }> = [];
    const adapter = new ClaudeAdapter({
      bin: claude,
      killGraceMs: 100,
      modelEnvironment: {
        ...process.env,
        PONDEROSA_TEST_VERSION_PID: versionPid,
      },
    });
    await expect(adapter.discoverModelCatalog(root, {
      signal: new AbortController().signal,
      onRuntimeSpawned: (handle) => handles.push(handle),
    })).rejects.toThrow();

    expect(handles).toHaveLength(2);
    expect(handles.every((handle) => !handle.isAlive())).toBe(true);
    const pid = Number(readFileSync(versionPid, "utf8").trim());
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });
});
