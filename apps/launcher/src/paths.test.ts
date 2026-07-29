import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLauncherState } from "./paths.js";

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
    ...(supervisorPid === undefined ? {} : { supervisorPid }),
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
