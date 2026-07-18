import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@ponderosa/core";
import { streamProcess } from "../src/process.js";
import { assertPersistentRuntimeHostingSupported, terminateProcessGroup } from "../src/process-termination.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};

describe("observed process-group termination", () => {
  it("fails before persistent runtime spawn on unsupported Windows hosting", () => {
    expect(() => assertPersistentRuntimeHostingSupported("win32")).toThrow(/Job Object process-tree containment/);
    expect(() => assertPersistentRuntimeHostingSupported("linux")).not.toThrow();
  });

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

  it.runIf(process.platform !== "win32")("keeps a non-persistent Run open until a stubborn descendant is observed gone", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "ponderosa-stream-process-"));
    const pidFile = path.join(temp, "descendant.json");
    const fake = fileURLToPath(new URL("./fake-stubborn-run.mjs", import.meta.url));
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    let settled = false;
    try {
      const collection = (async () => {
        for await (const event of streamProcess({
          bin: process.execPath,
          args: [fake],
          cwd: temp,
          signal: controller.signal,
          environment: { PONDEROSA_TEST_DESCENDANT_PID_FILE: pidFile },
          spawnFn: spawn,
          killGraceMs: 120,
          label: "stubborn one-shot",
          map: () => [{ type: "session", sessionId: "stubborn-run" }],
        })) {
          events.push(event);
          if (event.type === "session") controller.abort();
        }
      })().finally(() => { settled = true; });
      await vi.waitFor(() => expect(() => readFileSync(pidFile, "utf8")).not.toThrow());
      const descendantPid = JSON.parse(readFileSync(pidFile, "utf8")) as { descendantPid: number };
      await sleep(25);
      expect(settled).toBe(false);
      expect(processAlive(descendantPid.descendantPid)).toBe(true);
      await collection;
      expect(events.at(-1)).toEqual({ type: "error", message: "run cancelled" });
      expect(processAlive(descendantPid.descendantPid)).toBe(false);
    } finally {
      controller.abort();
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("terminates a descendant that retains stdout after the provider root exits", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "ponderosa-root-exit-stream-"));
    const pidFile = path.join(temp, "descendant.json");
    const fake = fileURLToPath(new URL("./fake-root-exit-inherited-stdout.mjs", import.meta.url));
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    let rootAuthorityRevoked = false;
    let settled = false;
    try {
      const collection = (async () => {
        for await (const event of streamProcess({
          bin: process.execPath,
          args: [fake],
          cwd: temp,
          signal: controller.signal,
          environment: { PONDEROSA_TEST_DESCENDANT_PID_FILE: pidFile },
          spawnFn: spawn,
          killGraceMs: 200,
          label: "root-exit inherited-stdout",
          map: () => [{ type: "session", sessionId: "root-exited" }],
          onRuntimeRootExit: () => { rootAuthorityRevoked = true; },
        })) events.push(event);
      })().finally(() => { settled = true; });
      await vi.waitFor(() => expect(() => readFileSync(pidFile, "utf8")).not.toThrow());
      const descendantPid = JSON.parse(readFileSync(pidFile, "utf8")) as { descendantPid: number };
      await vi.waitFor(() => expect(rootAuthorityRevoked).toBe(true));
      expect(settled).toBe(false);
      expect(processAlive(descendantPid.descendantPid)).toBe(true);
      await collection;
      expect(events).toContainEqual({ type: "session", sessionId: "root-exited" });
      expect(processAlive(descendantPid.descendantPid)).toBe(false);
    } finally {
      controller.abort();
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
