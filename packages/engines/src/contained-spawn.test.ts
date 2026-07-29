import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { spawnContainedCli } from "./contained-spawn.js";

describe("spawnContainedCli", () => {
  it("routes injected helper launches through the shared POSIX process-group boundary", () => {
    const child = {} as ChildProcess;
    const spawnFn = vi.fn(() => child) as unknown as typeof nodeSpawn;
    const result = spawnContainedCli({
      bin: "claude",
      args: ["--version"],
      cwd: "/tmp",
      env: { TEST: "value" },
      stdin: "ignore",
      spawnFn,
    });

    expect(result.child).toBe(child);
    expect(spawnFn).toHaveBeenCalledWith("claude", ["--version"], {
      cwd: "/tmp",
      env: { TEST: "value" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  });
});
