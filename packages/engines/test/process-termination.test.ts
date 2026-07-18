import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { terminateProcessGroup } from "../src/process-termination.js";

describe("observed process-group termination", () => {
  it.runIf(process.platform !== "win32")("rejects and leaves the live handle retryable when signal delivery fails", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    const pid = child.pid!;
    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((target, signal) => {
      if (signal === 0) return realKill(target, signal);
      return false;
    }) as typeof process.kill);
    try {
      await expect(terminateProcessGroup(child, {
        label: "stubborn test runtime",
        termGraceMs: 20,
        killConfirmationMs: 20,
      })).rejects.toThrow(/remained alive after SIGKILL.*delivery returned false/);
      expect(realKill(process.platform === "win32" ? pid : -pid, 0)).toBe(true);
      killSpy.mockRestore();
      await terminateProcessGroup(child, {
        label: "stubborn test runtime retry",
        termGraceMs: 20,
        killConfirmationMs: 50,
      });
      expect(() => realKill(-pid, 0)).toThrow();
    } finally {
      killSpy.mockRestore();
      try {
        realKill(-pid, 0);
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        realKill(-pid, "SIGKILL");
        await closed;
      } catch { /* already exited */ }
    }
  });
});
