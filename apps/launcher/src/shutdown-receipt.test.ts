import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentPonderosaStatus,
  launcherProcessBirthMarker,
  shutdownReceiptPath,
  startPonderosa,
  stopPonderosa,
} from "./control.js";
import { ensureDataLayout, readLegacyLauncherState, readLauncherState, writeJsonAtomic } from "./paths.js";
import type { BuildManifest, LauncherPaths, LauncherState, LegacyLauncherState, PlatformAdapter } from "./types.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): { paths: LauncherPaths; state: LauncherState; child: ChildProcess } {
  const root = mkdtempSync(path.join(tmpdir(), "ponderosa-launcher-receipt-"));
  roots.push(root);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  children.push(child);
  const paths: LauncherPaths = {
    installRoot: root,
    dataDir: root,
    applicationDataDir: path.join(root, "data"),
    runtimeDir: path.join(root, "runtime"),
    logsDir: path.join(root, "logs"),
    diagnosticsDir: path.join(root, "diagnostics"),
    configDir: path.join(root, "config"),
    stateDir: path.join(root, "launcher-state"),
    nodeExecutable: process.execPath,
    serverEntry: path.join(root, "server.js"),
    webDist: path.join(root, "web"),
    manifestPath: path.join(root, "manifest.json"),
    configPath: path.join(root, "config", "launcher.json"),
    statePath: path.join(root, "launcher-state", "instance.json"),
    operationLockPath: path.join(root, "launcher-state", "operation.lock"),
    engineSupervisorPath: path.join(root, "launcher-state", "engine-supervisor.json"),
    stdoutLogPath: path.join(root, "logs", "server.log"),
    stderrLogPath: path.join(root, "logs", "server-error.log"),
  };
  ensureDataLayout(paths);
  const state: LauncherState = {
    schemaVersion: 2,
    generation: "11111111-1111-4111-8111-111111111111",
    controlToken: "x".repeat(43),
    pid: child.pid!,
    port: 8787,
    host: "127.0.0.1",
    startedAt: "2026-08-14T00:00:00.000Z",
    dataDir: paths.applicationDataDir,
    installRoot: root,
    version: "0.1.0",
    commit: "test-commit",
    channel: "beta",
  };
  writeJsonAtomic(paths.statePath, state);
  return { paths, state, child };
}

function prepareStartFixture(paths: LauncherPaths): {
  manifest: BuildManifest;
  platform: PlatformAdapter;
} {
  mkdirSync(path.dirname(paths.serverEntry), { recursive: true });
  mkdirSync(paths.webDist, { recursive: true });
  writeFileSync(paths.serverEntry, "// fixture\n");
  return {
    manifest: {
      schemaVersion: 1,
      product: "Ponderosa",
      version: "0.2.0",
      commit: "replacement-commit",
      communicationProtocolVersion: "test",
      databaseSchemaVersion: "test",
      databaseSchemaSha256: "0".repeat(64),
      target: { platform: process.platform, arch: process.arch },
      nodeVersion: process.version,
      nodeExecutableBytes: 1,
      nodeExecutableSha256: "0".repeat(64),
      nodeSource: {
        url: "https://example.invalid/node",
        archiveSha256: "0".repeat(64),
        executableSha256: "0".repeat(64),
      },
      nativeAbi: { modules: process.versions.modules, napi: process.versions.napi ?? "" },
      nativeHost: { bytes: 1, sha256: "0".repeat(64) },
      buildTime: "2026-08-14T00:00:00.000Z",
      channel: "beta",
    },
    platform: {
      platform: process.platform,
      defaultDataDir: () => paths.dataDir,
      nodeExecutableName: () => path.basename(process.execPath),
      executableCandidates: () => [],
      openBrowser: async () => undefined,
      confirmUpdateRestart: async () => true,
    },
  };
}

function fetchForShutdown(
  paths: LauncherPaths,
  state: LauncherState,
  child: ChildProcess,
  receiptState: "clean" | "incomplete",
): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/launcher/status")) {
      return Response.json({
        pid: state.pid,
        dataDir: state.dataDir,
        version: state.version,
        commit: state.commit,
        channel: state.channel,
        acceptingDurableIntake: true,
        leasingRuns: true,
        activeRunCount: 0,
      });
    }
    const body = JSON.parse(String(init?.body)) as { generation: string; requestedAt: string };
    writeJsonAtomic(shutdownReceiptPath(paths, body.generation), {
      schemaVersion: 1,
      generation: body.generation,
      pid: state.pid,
      ...(launcherProcessBirthMarker(state.pid)
        ? { processBirthMarker: launcherProcessBirthMarker(state.pid) }
        : {}),
      state: receiptState,
      requestedAt: body.requestedAt,
      updatedAt: body.requestedAt,
      ...(receiptState === "incomplete" ? { error: "injected background cleanup failed" } : {}),
    });
    child.kill("SIGTERM");
    return Response.json({ accepted: true }, { status: 202 });
  }) as typeof fetch;
}

describe("durable launcher shutdown receipts", () => {
  it("canonicalizes an authenticated provisional PID before direct shutdown", async () => {
    const { paths, state, child } = fixture();
    const marker = launcherProcessBirthMarker(state.pid);
    if (!marker) return;
    writeJsonAtomic(paths.statePath, { ...state, pid: 0 });
    const fetchFn = (async (input, init) => {
      if (String(input).endsWith("/api/launcher/status")) {
        return Response.json({
          pid: state.pid,
          dataDir: state.dataDir,
          version: state.version,
          commit: state.commit,
          channel: state.channel,
          acceptingDurableIntake: true,
          leasingRuns: true,
          activeRunCount: 0,
        });
      }
      const body = JSON.parse(String(init?.body)) as { generation: string; requestedAt: string };
      const canonical = readLauncherState(paths.statePath)!;
      writeJsonAtomic(shutdownReceiptPath(paths, body.generation), {
        schemaVersion: 1,
        generation: body.generation,
        pid: state.pid,
        processBirthMarker: marker,
        state: "clean",
        requestedAt: body.requestedAt,
        updatedAt: body.requestedAt,
      });
      expect(canonical).toMatchObject({ pid: state.pid, processBirthMarker: marker });
      child.kill("SIGTERM");
      return Response.json({ accepted: true }, { status: 202 });
    }) as typeof fetch;
    await expect(stopPonderosa({ paths, fetch: fetchFn })).resolves.toBe("stopped");
    expect(existsSync(paths.statePath)).toBe(false);
  });

  it("persists POSIX birth evidence during status repair and uses it for shutdown", async () => {
    const { paths, state, child } = fixture();
    const marker = launcherProcessBirthMarker(state.pid);
    if (!marker) return;
    writeJsonAtomic(paths.statePath, { ...state, pid: 0 });
    const fetchFn = (async (input, init) => {
      if (String(input).endsWith("/api/launcher/status")) {
        return Response.json({
          pid: state.pid,
          dataDir: state.dataDir,
          version: state.version,
          commit: state.commit,
          channel: state.channel,
          acceptingDurableIntake: true,
          leasingRuns: true,
          activeRunCount: 0,
        });
      }
      const body = JSON.parse(String(init?.body)) as { generation: string; requestedAt: string };
      writeJsonAtomic(shutdownReceiptPath(paths, body.generation), {
        schemaVersion: 1,
        generation: body.generation,
        pid: state.pid,
        processBirthMarker: marker,
        state: "clean",
        requestedAt: body.requestedAt,
        updatedAt: body.requestedAt,
      });
      child.kill("SIGTERM");
      return Response.json({ accepted: true }, { status: 202 });
    }) as typeof fetch;
    await expect(currentPonderosaStatus(paths, fetchFn)).resolves.toMatchObject({ pid: state.pid });
    expect(readLauncherState(paths.statePath)).toMatchObject({
      pid: state.pid,
      processBirthMarker: marker,
    });
    await expect(stopPonderosa({ paths, fetch: fetchFn })).resolves.toBe("stopped");
  });

  it("repairs provisional Windows-style authority without replacing its supervisor fence", async () => {
    const { paths, state, child } = fixture();
    const supervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(supervisor);
    const supervisorGeneration = "22222222-2222-4222-8222-222222222222";
    const provisional: LauncherState = {
      ...state,
      pid: 0,
      supervisorPid: supervisor.pid!,
      supervisorGeneration,
    };
    writeJsonAtomic(paths.statePath, provisional);
    const supervisorStatus = path.join(paths.runtimeDir, `server-supervisor-${supervisorGeneration}.json`);
    writeJsonAtomic(supervisorStatus, {
      schemaVersion: 1,
      generation: supervisorGeneration,
      supervisorPid: supervisor.pid,
      status: "active",
      updatedAt: "2026-08-14T00:00:00.000Z",
    });
    const fetchFn = (async (input, init) => {
      if (String(input).endsWith("/api/launcher/status")) {
        return Response.json({
          pid: state.pid,
          dataDir: state.dataDir,
          version: state.version,
          commit: state.commit,
          channel: state.channel,
          acceptingDurableIntake: true,
          leasingRuns: true,
          activeRunCount: 0,
        });
      }
      const body = JSON.parse(String(init?.body)) as { generation: string; requestedAt: string };
      const canonical = readLauncherState(paths.statePath)!;
      expect(canonical).toMatchObject({
        pid: state.pid,
        supervisorPid: supervisor.pid,
        supervisorGeneration,
      });
      expect(canonical.processBirthMarker).toBeUndefined();
      writeJsonAtomic(shutdownReceiptPath(paths, body.generation), {
        schemaVersion: 1,
        generation: body.generation,
        pid: state.pid,
        state: "clean",
        requestedAt: body.requestedAt,
        updatedAt: body.requestedAt,
      });
      writeJsonAtomic(supervisorStatus, {
        schemaVersion: 1,
        generation: supervisorGeneration,
        supervisorPid: supervisor.pid,
        status: "drained",
        updatedAt: body.requestedAt,
      });
      child.kill("SIGTERM");
      supervisor.kill("SIGTERM");
      return Response.json({ accepted: true }, { status: 202 });
    }) as typeof fetch;
    await expect(stopPonderosa({ paths, fetch: fetchFn })).resolves.toBe("stopped");
    expect(existsSync(paths.statePath)).toBe(false);
  });

  it("removes launcher state only after the exact generation records clean", async () => {
    const { paths, state, child } = fixture();
    await expect(stopPonderosa({
      paths,
      fetch: fetchForShutdown(paths, state, child, "clean"),
    })).resolves.toBe("stopped");
    expect(existsSync(paths.statePath)).toBe(false);
    expect(existsSync(shutdownReceiptPath(paths, state.generation))).toBe(false);
  });

  it("retains the fence and blocks replacement after cleanup is incomplete", async () => {
    const { paths, state, child } = fixture();
    await expect(stopPonderosa({
      paths,
      fetch: fetchForShutdown(paths, state, child, "incomplete"),
    })).rejects.toThrow("injected background cleanup failed");
    expect(existsSync(paths.statePath)).toBe(true);
    expect(existsSync(shutdownReceiptPath(paths, state.generation))).toBe(true);
  });

  it("retries dead exact cleanup on each attempt and removes authority only after recovery proves clean", async () => {
    const { paths, state, child } = fixture();
    const stoppingState = { ...state, shutdownRequestedAt: "2026-08-14T02:00:00.000Z" };
    writeJsonAtomic(paths.statePath, stoppingState);
    writeJsonAtomic(shutdownReceiptPath(paths, state.generation), {
      schemaVersion: 1,
      generation: state.generation,
      pid: state.pid,
      state: "incomplete",
      requestedAt: stoppingState.shutdownRequestedAt,
      updatedAt: stoppingState.shutdownRequestedAt,
      error: "first cleanup failed",
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let attempts = 0;
    const recoverShutdown = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("recovery verifier retained authority");
      writeJsonAtomic(shutdownReceiptPath(paths, state.generation), {
        schemaVersion: 1,
        generation: state.generation,
        pid: state.pid,
        state: "clean",
        requestedAt: stoppingState.shutdownRequestedAt,
        updatedAt: "2026-08-14T02:00:01.000Z",
      });
    };
    await expect(stopPonderosa({
      paths,
      fetch: (async () => { throw new Error("server is dead"); }) as typeof fetch,
      dependencies: { recoverShutdown },
    })).rejects.toThrow("recovery verifier retained authority");
    expect(existsSync(paths.statePath)).toBe(true);
    await expect(stopPonderosa({
      paths,
      fetch: (async () => { throw new Error("server is dead"); }) as typeof fetch,
      dependencies: { recoverShutdown },
    })).resolves.toBe("stopped");
    expect(attempts).toBe(2);
    expect(existsSync(paths.statePath)).toBe(false);
  });

  it("retries a live exact post-close process but remains blocked when birth evidence is uncertain", async () => {
    const exact = fixture();
    const exactMarker = launcherProcessBirthMarker(exact.state.pid);
    if (!exactMarker) return;
    const exactState = {
      ...exact.state,
      processBirthMarker: exactMarker,
      shutdownRequestedAt: "2026-08-14T03:00:00.000Z",
    };
    writeJsonAtomic(exact.paths.statePath, exactState);
    writeJsonAtomic(shutdownReceiptPath(exact.paths, exact.state.generation), {
      schemaVersion: 1,
      generation: exact.state.generation,
      pid: exact.state.pid,
      processBirthMarker: exactMarker,
      state: "incomplete",
      requestedAt: exactState.shutdownRequestedAt,
      updatedAt: exactState.shutdownRequestedAt,
      error: "route close failed",
    });
    exact.child.once("exit", () => writeJsonAtomic(
      shutdownReceiptPath(exact.paths, exact.state.generation),
      {
        schemaVersion: 1,
        generation: exact.state.generation,
        pid: exact.state.pid,
        processBirthMarker: exactMarker,
        state: "clean",
        requestedAt: exactState.shutdownRequestedAt,
        updatedAt: "2026-08-14T03:00:01.000Z",
      },
    ));
    await expect(stopPonderosa({
      paths: exact.paths,
      fetch: (async () => { throw new Error("route is closed"); }) as typeof fetch,
    })).resolves.toBe("stopped");

    const uncertain = fixture();
    const uncertainState = {
      ...uncertain.state,
      shutdownRequestedAt: "2026-08-14T04:00:00.000Z",
    };
    writeJsonAtomic(uncertain.paths.statePath, uncertainState);
    let recoveries = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(stopPonderosa({
        paths: uncertain.paths,
        fetch: (async () => { throw new Error("ownership unavailable"); }) as typeof fetch,
        dependencies: { recoverShutdown: async () => { recoveries += 1; } },
      })).rejects.toThrow("without exact post-close birth evidence");
    }
    expect(recoveries).toBe(0);
    expect(existsSync(uncertain.paths.statePath)).toBe(true);
  });

  it("retains a schema-1 provisional fence beyond the readiness window and drains it on restart", async () => {
    const { paths, state, child } = fixture();
    const legacy: LegacyLauncherState = {
      schemaVersion: 1,
      controlToken: state.controlToken,
      // Reproduce the crash window after old state was published but before
      // the old launcher repaired its provisional PID.
      pid: 0,
      port: state.port,
      host: state.host,
      startedAt: state.startedAt,
      dataDir: state.dataDir,
      installRoot: state.installRoot,
      version: "0.1.0",
      commit: "legacy-commit",
      channel: state.channel,
    };
    writeJsonAtomic(paths.statePath, legacy);
    const { manifest, platform } = prepareStartFixture(paths);
    const replacement = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(replacement);
    let replacementSpawned = false;
    let legacyStatusAttempts = 0;
    let legacyReachable = false;
    const fetchFn = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/launcher/status") && !replacementSpawned) {
        legacyStatusAttempts += 1;
        if (!legacyReachable) {
          return Response.json({ error: "legacy daemon is still starting" }, { status: 503 });
        }
        return Response.json({
          pid: state.pid,
          dataDir: legacy.dataDir,
          version: legacy.version,
          commit: legacy.commit,
          channel: legacy.channel,
          acceptingDurableIntake: true,
          leasingRuns: true,
          activeRunCount: 0,
        });
      }
      if (url.endsWith("/api/launcher/shutdown")) {
        expect(init?.body).toBeUndefined();
        child.kill("SIGTERM");
        return Response.json({ accepted: true }, { status: 202 });
      }
      return Response.json({
        pid: replacement.pid,
        dataDir: paths.applicationDataDir,
        version: manifest.version,
        commit: manifest.commit,
        channel: manifest.channel,
        acceptingDurableIntake: true,
        leasingRuns: true,
        activeRunCount: 0,
      });
    }) as typeof fetch;
    await expect(startPonderosa({
      paths,
      manifest,
      platform,
      openBrowser: false,
      dependencies: {
        fetch: fetchFn,
        spawnServer: async () => {
          replacementSpawned = true;
          return replacement.pid!;
        },
      },
    })).rejects.toThrow("Upgrade remains blocked");
    expect(legacyStatusAttempts).toBeGreaterThanOrEqual(20);
    expect(replacementSpawned).toBe(false);
    expect(readLegacyLauncherState(paths.statePath)).toEqual(legacy);
    expect(launcherProcessBirthMarker(state.pid)).toBeDefined();

    legacyReachable = true;
    const started = await startPonderosa({
      paths,
      manifest,
      platform,
      openBrowser: false,
      dependencies: {
        fetch: fetchFn,
        spawnServer: async () => {
          expect(launcherProcessBirthMarker(state.pid)).toBeUndefined();
          replacementSpawned = true;
          return replacement.pid!;
        },
      },
    });
    expect(started).toMatchObject({
      schemaVersion: 2,
      pid: replacement.pid,
      version: manifest.version,
      commit: manifest.commit,
    });
    expect(legacyStatusAttempts).toBeGreaterThanOrEqual(21);
    expect(started.generation).not.toBe("");
  }, 15_000);

  it("persists exact schema-1 ownership before a lost shutdown response and replaces only after drain", async () => {
    const { paths, state, child } = fixture();
    const marker = launcherProcessBirthMarker(state.pid);
    if (!marker) return;
    const legacy: LegacyLauncherState = {
      schemaVersion: 1,
      controlToken: state.controlToken,
      pid: 0,
      port: state.port,
      host: state.host,
      startedAt: state.startedAt,
      dataDir: state.dataDir,
      installRoot: state.installRoot,
      version: state.version,
      commit: state.commit,
      channel: state.channel,
    };
    writeJsonAtomic(paths.statePath, legacy);
    const { manifest, platform } = prepareStartFixture(paths);
    const replacement = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(replacement);
    let oldProcessExited = false;
    let replacementSpawned = false;
    child.once("exit", () => { oldProcessExited = true; });
    const fetchFn = (async (input) => {
      if (String(input).endsWith("/api/launcher/status")) {
        return Response.json({
          pid: replacementSpawned ? replacement.pid : state.pid,
          dataDir: legacy.dataDir,
          version: replacementSpawned ? manifest.version : legacy.version,
          commit: replacementSpawned ? manifest.commit : legacy.commit,
          channel: replacementSpawned ? manifest.channel : legacy.channel,
          acceptingDurableIntake: true,
          leasingRuns: true,
          activeRunCount: 0,
        });
      }
      expect(readLegacyLauncherState(paths.statePath)).toMatchObject({
        pid: state.pid,
        processBirthMarker: marker,
      });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
      throw new TypeError("shutdown response socket closed");
    }) as typeof fetch;
    const started = await startPonderosa({
      paths,
      manifest,
      platform,
      openBrowser: false,
      dependencies: {
        fetch: fetchFn,
        spawnServer: async () => {
          expect(oldProcessExited).toBe(true);
          replacementSpawned = true;
          return replacement.pid!;
        },
      },
    });
    expect(started.pid).toBe(replacement.pid);
  });

  it("retains crash-canonicalized schema-1 authority across restart until the exact PID drains", async () => {
    const { paths, state, child } = fixture();
    const marker = launcherProcessBirthMarker(state.pid);
    if (!marker) return;
    const canonicalLegacy: LegacyLauncherState = {
      schemaVersion: 1,
      controlToken: state.controlToken,
      pid: state.pid,
      processBirthMarker: marker,
      port: state.port,
      host: state.host,
      startedAt: state.startedAt,
      dataDir: state.dataDir,
      installRoot: state.installRoot,
      version: state.version,
      commit: state.commit,
      channel: state.channel,
    };
    writeJsonAtomic(paths.statePath, canonicalLegacy);
    const { manifest, platform } = prepareStartFixture(paths);
    const replacement = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(replacement);
    let replacementSpawned = false;
    const fetchFn = (async () => {
      if (!replacementSpawned) throw new TypeError("legacy control route is already closed");
      return Response.json({
        pid: replacement.pid,
        dataDir: paths.applicationDataDir,
        version: manifest.version,
        commit: manifest.commit,
        channel: manifest.channel,
        acceptingDurableIntake: true,
        leasingRuns: true,
        activeRunCount: 0,
      });
    }) as typeof fetch;
    const starting = startPonderosa({
      paths,
      manifest,
      platform,
      openBrowser: false,
      dependencies: {
        fetch: fetchFn,
        spawnServer: async () => {
          replacementSpawned = true;
          expect(launcherProcessBirthMarker(state.pid)).toBeUndefined();
          return replacement.pid!;
        },
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(replacementSpawned).toBe(false);
    expect(readLegacyLauncherState(paths.statePath)).toEqual(canonicalLegacy);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
    const started = await starting;
    expect(replacementSpawned).toBe(true);
    expect(started.pid).toBe(replacement.pid);
  });

  it("retains a crash-canonicalized schema-1 Windows supervisor fence until its Job proves drained", async () => {
    const { paths, state, child } = fixture();
    const supervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(supervisor);
    const supervisorGeneration = "33333333-3333-4333-8333-333333333333";
    const canonicalLegacy: LegacyLauncherState = {
      schemaVersion: 1,
      controlToken: state.controlToken,
      pid: state.pid,
      supervisorPid: supervisor.pid!,
      supervisorGeneration,
      port: state.port,
      host: state.host,
      startedAt: state.startedAt,
      dataDir: state.dataDir,
      installRoot: state.installRoot,
      version: state.version,
      commit: state.commit,
      channel: state.channel,
    };
    writeJsonAtomic(paths.statePath, canonicalLegacy);
    const supervisorStatus = path.join(paths.runtimeDir, `server-supervisor-${supervisorGeneration}.json`);
    writeJsonAtomic(supervisorStatus, {
      schemaVersion: 1,
      generation: supervisorGeneration,
      supervisorPid: supervisor.pid,
      status: "active",
      updatedAt: "2026-08-14T00:00:00.000Z",
    });
    const { manifest, platform } = prepareStartFixture(paths);
    const replacement = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(replacement);
    let replacementSpawned = false;
    const fetchFn = (async () => {
      if (!replacementSpawned) throw new TypeError("legacy Windows control route is already closed");
      return Response.json({
        pid: replacement.pid,
        dataDir: paths.applicationDataDir,
        version: manifest.version,
        commit: manifest.commit,
        channel: manifest.channel,
        acceptingDurableIntake: true,
        leasingRuns: true,
        activeRunCount: 0,
      });
    }) as typeof fetch;
    const starting = startPonderosa({
      paths,
      manifest,
      platform,
      openBrowser: false,
      dependencies: {
        fetch: fetchFn,
        spawnServer: async () => {
          replacementSpawned = true;
          expect(existsSync(supervisorStatus)).toBe(false);
          return replacement.pid!;
        },
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(replacementSpawned).toBe(false);
    expect(readLegacyLauncherState(paths.statePath)).toEqual(canonicalLegacy);
    writeJsonAtomic(supervisorStatus, {
      schemaVersion: 1,
      generation: supervisorGeneration,
      supervisorPid: supervisor.pid,
      status: "drained",
      updatedAt: "2026-08-14T00:00:01.000Z",
    });
    const drained = Promise.all([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => supervisor.once("exit", () => resolve())),
    ]);
    child.kill("SIGTERM");
    supervisor.kill("SIGTERM");
    await drained;
    const started = await starting;
    expect(replacementSpawned).toBe(true);
    expect(started.pid).toBe(replacement.pid);
  });
});
