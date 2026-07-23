import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTarGz, type ArchiveEntry } from "./archive.js";
import { readLauncherConfiguration, readLauncherState } from "./paths.js";
import type {
  BuildManifest,
  DoctorReport,
  LauncherPaths,
} from "./types.js";

function safeState(paths: LauncherPaths): unknown {
  const state = readLauncherState(paths.statePath);
  if (!state) return undefined;
  const { controlToken: _controlToken, ...safe } = state;
  return safe;
}

function safeConfiguration(paths: LauncherPaths): unknown {
  const configuration = readLauncherConfiguration(paths.configPath);
  return {
    ...(configuration.port ? { port: configuration.port } : {}),
    providers: Object.fromEntries(
      Object.entries(configuration.providers ?? {}).map(([id, value]) => [
        id,
        { executable: value.executable },
      ]),
    ),
  };
}

function logMetadata(paths: LauncherPaths): unknown[] {
  return ([
    ["server.log", paths.stdoutLogPath],
    ["server-error.log", paths.stderrLogPath],
  ] as const).flatMap(([name, pathname]) => {
    try {
      const stats = statSync(pathname);
      return [{ name, bytes: stats.size, modifiedAt: stats.mtime.toISOString() }];
    } catch {
      return [];
    }
  });
}

export function writeDiagnosticBundle(input: {
  paths: LauncherPaths;
  manifest: BuildManifest;
  doctor: DoctorReport;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const stamp = now.toISOString().replaceAll(":", "-");
  const target = path.join(input.paths.diagnosticsDir, `ponderosa-diagnostics-${stamp}.tgz`);
  const entries: ArchiveEntry[] = [
    {
      name: "summary.json",
      content: `${JSON.stringify({
        generatedAt: now.toISOString(),
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        hostname: os.hostname(),
        memoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
        dataDir: input.paths.dataDir,
      }, null, 2)}\n`,
    },
    { name: "build-manifest.json", content: `${JSON.stringify(input.manifest, null, 2)}\n` },
    { name: "doctor.json", content: `${JSON.stringify(input.doctor, null, 2)}\n` },
    { name: "launcher-state.json", content: `${JSON.stringify(safeState(input.paths), null, 2)}\n` },
    { name: "launcher-config.json", content: `${JSON.stringify(safeConfiguration(input.paths), null, 2)}\n` },
    { name: "log-metadata.json", content: `${JSON.stringify(logMetadata(input.paths), null, 2)}\n` },
    {
      name: "README.txt",
      content: [
        "Ponderosa private-beta diagnostic bundle",
        "",
        "This archive intentionally excludes provider credentials, bootstrap credentials,",
        "browser sessions, project contents, artifacts, message bodies, and raw logs.",
        "Only log file sizes and modification times are included.",
        "Share it only with a trusted Ponderosa support contact.",
        "",
      ].join("\n"),
    },
  ];
  if (existsSync(input.paths.configPath)) {
    entries.push({
      name: "config-presence.txt",
      content: "A launcher configuration file exists. Only its non-secret executable paths are represented above.\n",
    });
  }
  writeFileSync(target, createTarGz(entries), { mode: 0o600 });
  return target;
}
