import { gunzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTarGz } from "../src/archive.js";
import { acquireOperationLock, startPonderosa } from "../src/control.js";
import { parseBuildManifest } from "../src/manifest.js";
import { ensureDataLayout, readLauncherState, resolveLauncherPaths } from "../src/paths.js";
import { hostPlatformAdapter } from "../src/platform.js";
import type { BuildManifest, PlatformAdapter } from "../src/types.js";

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ponderosa-launcher-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const manifest: BuildManifest = {
  schemaVersion: 1,
  product: "Ponderosa",
  version: "3.5.0-beta.1",
  commit: "abc123",
  communicationProtocolVersion: "communication-v3",
  databaseSchemaVersion: "0035",
  target: { platform: process.platform, arch: process.arch },
  nodeVersion: process.version,
  buildTime: "2026-07-23T00:00:00.000Z",
  channel: "beta",
};

describe("build manifest", () => {
  it("validates exact installed-build identity", () => {
    expect(parseBuildManifest(manifest)).toEqual(manifest);
    expect(() => parseBuildManifest({ ...manifest, schemaVersion: 2 })).toThrow(/unsupported/);
    expect(() => parseBuildManifest({ ...manifest, target: { platform: "", arch: "x64" } })).toThrow(/target.platform/);
    expect(() => parseBuildManifest({ ...manifest, buildTime: "not-a-date" })).toThrow(/ISO timestamp/);
  });
});

describe("platform-neutral paths", () => {
  it("uses native private-beta data locations behind one adapter", () => {
    expect(hostPlatformAdapter("darwin").defaultDataDir({}, "/Users/tester"))
      .toBe("/Users/tester/Library/Application Support/Ponderosa Beta");
    expect(hostPlatformAdapter("win32").defaultDataDir(
      { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      "C:\\Users\\tester",
    )).toContain("Ponderosa Beta");
    expect(hostPlatformAdapter("linux").defaultDataDir(
      { XDG_DATA_HOME: "/home/tester/data" },
      "/home/tester",
    )).toBe("/home/tester/data/ponderosa-beta");
  });

  it("never inherits a development server data directory into an installed beta", () => {
    const paths = resolveLauncherPaths({
      platform: hostPlatformAdapter("linux"),
      env: {
        XDG_DATA_HOME: "/home/tester/.local/share",
        PONDEROSA_DATA_DIR: "/home/tester/.ponderosa-production",
      },
      installRoot: "/opt/ponderosa-beta",
    });
    expect(paths.dataDir).toBe("/home/tester/.local/share/ponderosa-beta");
    expect(paths.applicationDataDir).toBe("/home/tester/.local/share/ponderosa-beta/data");
  });

  it("creates the complete durable data layout without a repository checkout", () => {
    const root = temporaryDirectory();
    const paths = resolveLauncherPaths({
      platform: hostPlatformAdapter(),
      installRoot: path.join(root, "installed"),
      dataDir: path.join(root, "data"),
    });
    ensureDataLayout(paths);
    expect(paths.applicationDataDir).toBe(path.join(paths.dataDir, "data"));
    for (const directory of [
      "data", "runtime", "checkpoints", "logs", "diagnostics", "backups", "config", "launcher-state",
    ]) expect(readFileOrDirectory(path.join(paths.dataDir, directory))).toBe("directory");
  });

  it("rejects incomplete or unsafe persisted launcher state", () => {
    const root = temporaryDirectory();
    const statePath = path.join(root, "instance.json");
    const valid = {
      schemaVersion: 1,
      controlToken: randomBytes(32).toString("base64url"),
      pid: 0,
      port: 8787,
      host: "127.0.0.1",
      startedAt: new Date().toISOString(),
      dataDir: path.join(root, "data"),
      installRoot: path.join(root, "install"),
      version: manifest.version,
      commit: manifest.commit,
      channel: manifest.channel,
    };
    writeFileSync(statePath, JSON.stringify(valid));
    expect(readLauncherState(statePath)).toMatchObject(valid);

    for (const invalid of [
      { ...valid, controlToken: "short" },
      { ...valid, port: 0 },
      { ...valid, host: "0.0.0.0" },
      { ...valid, startedAt: "not-a-date" },
      { ...valid, dataDir: "" },
    ]) {
      writeFileSync(statePath, JSON.stringify(invalid));
      expect(readLauncherState(statePath)).toBeUndefined();
    }
  });
});

describe("diagnostic archives", () => {
  it("creates a portable gzip tar without changing its inputs", () => {
    const archive = createTarGz([
      { name: "summary.json", content: "{\"ok\":true}\n", modifiedAt: new Date(0) },
      { name: "logs/server.log", content: "hello\n", modifiedAt: new Date(0) },
    ]);
    const tar = gunzipSync(archive);
    expect(tar.subarray(0, 100).toString("utf8")).toContain("summary.json");
    expect(tar.toString("utf8")).toContain("{\"ok\":true}");
    expect(tar.toString("utf8")).toContain("logs/server.log");
  });
});

describe("launcher ownership", () => {
  it("serializes competing lifecycle operations", () => {
    const root = temporaryDirectory();
    const lockPath = path.join(root, "operation.lock");
    const release = acquireOperationLock(lockPath);
    expect(() => acquireOperationLock(lockPath)).toThrow(/already in progress/);
    release();
    expect(acquireOperationLock(lockPath)).toBeTypeOf("function");
  });

  it("does not steal a newly created lock before its owner receipt is written", () => {
    const root = temporaryDirectory();
    const lockPath = path.join(root, "operation.lock");
    writeFileSync(lockPath, "");
    expect(() => acquireOperationLock(lockPath)).toThrow(/already in progress/);
    expect(readFileOrDirectory(lockPath)).toBe("file");

    const stale = new Date(Date.now() - 10_000);
    utimesSync(lockPath, stale, stale);
    const release = acquireOperationLock(lockPath);
    release();
    expect(readFileOrDirectory(lockPath)).toBe("missing");
  });
});

describe("launcher lifecycle", () => {
  it("starts one installed server and opens a one-time fragment bootstrap", async () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "Ponderosa");
    const dataDir = path.join(root, "data");
    const opened: string[] = [];
    const platform: PlatformAdapter = {
      platform: process.platform,
      defaultDataDir: () => dataDir,
      nodeExecutableName: () => process.platform === "win32" ? "node.exe" : "node",
      executableCandidates: () => [],
      openBrowser: async (url) => { opened.push(url); },
    };
    const paths = resolveLauncherPaths({ platform, installRoot, dataDir });
    mkdirSync(path.dirname(paths.nodeExecutable), { recursive: true });
    mkdirSync(path.dirname(paths.serverEntry), { recursive: true });
    mkdirSync(paths.webDist, { recursive: true });
    writeFileSync(paths.nodeExecutable, "");
    writeFileSync(paths.serverEntry, "");
    writeFileSync(paths.manifestPath, JSON.stringify(manifest));

    let statePid: number | undefined;
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/api/launcher/status")) {
        const state = JSON.parse(readFileSync(paths.statePath, "utf8")) as {
          pid: number; dataDir: string; version: string; commit: string; channel: string;
        };
        return Response.json({
          pid: state.pid,
          dataDir: state.dataDir,
          version: state.version,
          commit: state.commit,
          channel: state.channel,
        });
      }
      if (url.endsWith("/api/launcher/bootstrap") && init?.method === "POST") {
        return Response.json({ token: "one-time-browser-token" });
      }
      expect(init).toBeDefined();
      return new Response("not found", { status: 404 });
    };
    const state = await startPonderosa({
      paths,
      manifest,
      platform,
      dependencies: {
        fetch: fakeFetch as typeof globalThis.fetch,
        spawnServer: async (_paths, provisional) => {
          statePid = process.pid;
          expect(provisional.pid).toBe(0);
          return process.pid;
        },
      },
    });
    expect(state.pid).toBe(statePid);
    expect(state.dataDir).toBe(paths.applicationDataDir);
    expect(opened).toEqual([
      `http://127.0.0.1:8787/__ponderosa_bootstrap#one-time-browser-token`,
    ]);
    const persisted = readFileSync(paths.statePath, "utf8");
    expect(persisted).toContain("\"controlToken\"");
    expect(persisted).not.toContain("one-time-browser-token");

    const sameState = await startPonderosa({
      paths,
      manifest,
      platform,
      dependencies: {
        fetch: fakeFetch as typeof globalThis.fetch,
        spawnServer: async () => {
          throw new Error("A second server must not be spawned.");
        },
      },
    });
    expect(sameState.pid).toBe(state.pid);
    expect(opened).toHaveLength(2);
  });

  it("recovers a server spawned before its PID receipt was committed", async () => {
    const root = temporaryDirectory();
    const installRoot = path.join(root, "Ponderosa");
    const dataDir = path.join(root, "data");
    const platform = hostPlatformAdapter();
    const paths = resolveLauncherPaths({ platform, installRoot, dataDir });
    for (const pathname of [paths.nodeExecutable, paths.serverEntry]) {
      mkdirSync(path.dirname(pathname), { recursive: true });
      writeFileSync(pathname, "");
    }
    mkdirSync(paths.webDist, { recursive: true });
    ensureDataLayout(paths);
    const interrupted = {
      schemaVersion: 1 as const,
      controlToken: randomBytes(32).toString("base64url"),
      pid: 0,
      port: 8787,
      host: "127.0.0.1" as const,
      startedAt: new Date().toISOString(),
      dataDir: paths.applicationDataDir,
      installRoot,
      version: manifest.version,
      commit: manifest.commit,
      channel: manifest.channel,
    };
    writeFileSync(paths.statePath, JSON.stringify(interrupted));
    const fetch = async () => Response.json({ ...interrupted, pid: process.pid });
    const recovered = await startPonderosa({
      paths, manifest, platform, openBrowser: false,
      dependencies: { fetch: fetch as typeof globalThis.fetch, spawnServer: async () => { throw new Error("must not spawn"); } },
    });
    expect(recovered.pid).toBe(process.pid);
    expect(JSON.parse(readFileSync(paths.statePath, "utf8")).pid).toBe(process.pid);
  });
});

function readFileOrDirectory(pathname: string): "file" | "directory" | "missing" {
  try {
    const entry = statSync(pathname);
    return entry.isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
}
