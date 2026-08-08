import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  isRestartRecoverableProcessIdentity,
  recoveredRuntimeProcessHandle,
  runtimeProcessIdentity,
} from "./process-termination.js";

const darwinTest = process.platform === "darwin" ? test : test.skip;

describe("restart-recoverable process identity", () => {
  const linuxIdentity = { pid: 41, pgid: 41, birthMarker: "linux:123456789" };
  const legacyDarwinIdentity = {
    pid: 41,
    pgid: 41,
    birthMarker: "darwin:Sat Aug  8 12:34:56 2026",
  };

  test("retains high-resolution Linux process birth authority", () => {
    expect(isRestartRecoverableProcessIdentity(linuxIdentity, "linux")).toBe(true);
  });

  test("rejects second-resolution Darwin identities instead of authorizing a signal", () => {
    expect(isRestartRecoverableProcessIdentity(legacyDarwinIdentity, "darwin")).toBe(false);
    expect(isRestartRecoverableProcessIdentity(linuxIdentity, "darwin")).toBe(false);
  });

  test("accepts only high-resolution Darwin birth identities on Darwin", () => {
    expect(isRestartRecoverableProcessIdentity({
      pid: 41,
      pgid: 41,
      birthMarker: "darwin:1786192496:123456",
    }, "darwin")).toBe(true);
    expect(isRestartRecoverableProcessIdentity({
      pid: 41,
      pgid: 41,
      birthMarker: "darwin:1786192496:1000000",
    }, "darwin")).toBe(false);
  });

  darwinTest("captures native high-resolution identity and terminates its detached group", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const identity = runtimeProcessIdentity(child);
    expect(identity?.birthMarker).toMatch(/^darwin:\d+:\d{1,6}$/u);
    expect(identity && isRestartRecoverableProcessIdentity(identity)).toBe(true);
    child.unref();
    if (!identity) throw new Error("Darwin process identity unavailable");
    const handle = recoveredRuntimeProcessHandle(identity, {
      label: "Darwin process identity qualification",
      termGraceMs: 500,
      killConfirmationMs: 500,
    });
    try {
      expect(handle.isAlive()).toBe(true);
    } finally {
      await handle.close();
    }
    expect(handle.isAlive()).toBe(false);
  });
});
