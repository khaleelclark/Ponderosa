import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  launcherStateLocation,
  readLauncherState,
  resolveLauncherPaths,
} from "./paths.js";
import type { PlatformAdapter } from "./types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function statePath(supervisorPid?: number): string {
  const root = mkdtempSync(path.join(tmpdir(), "ponderosa-launcher-state-"));
  roots.push(root);
  const pathname = path.join(root, "instance.json");
  writeFileSync(pathname, JSON.stringify({
    schemaVersion: 1,
    controlToken: "x".repeat(32),
    ...(supervisorPid === undefined ? {} : {
      supervisorPid,
      supervisorGeneration: "00000000-0000-4000-8000-000000000000",
    }),
    pid: 123,
    port: 8787,
    host: "127.0.0.1",
    startedAt: new Date(0).toISOString(),
    dataDir: root,
    installRoot: root,
    version: "test",
    commit: "test",
    channel: "development",
  }));
  return pathname;
}

describe("readLauncherState", () => {
  it("retains a valid Windows supervisor authority", () => {
    expect(readLauncherState(statePath(456))?.supervisorPid).toBe(456);
  });

  it("rejects an invalid Windows supervisor authority", () => {
    expect(readLauncherState(statePath(0))).toBeUndefined();
  });
});

describe("launcherStateLocation", () => {
  it("projects the resolved launcher root to the application data directory persisted in state", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-launcher-paths-"));
    roots.push(root);
    const platform: PlatformAdapter = {
      platform: process.platform,
      defaultDataDir: () => path.join(root, "default-data"),
      nodeExecutableName: () => process.platform === "win32" ? "node.exe" : "node",
      executableCandidates: () => [],
      openBrowser: async () => undefined,
      confirmUpdateRestart: async () => false,
    };
    const paths = resolveLauncherPaths({
      platform,
      installRoot: path.join(root, "install"),
      dataDir: path.join(root, "launcher-root"),
    });

    expect(launcherStateLocation(paths)).toEqual({
      installRoot: path.join(root, "install"),
      dataDir: path.join(root, "launcher-root", "data"),
    });
    expect(paths.statePath).toBe(
      path.join(root, "launcher-root", "launcher-state", "instance.json"),
    );
  });
});
