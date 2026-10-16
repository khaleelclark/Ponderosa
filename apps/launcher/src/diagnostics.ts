import { randomUUID } from "node:crypto";
import { writeSecureFileAtomic } from "@ponderosa/native-host";
import { existsSync, realpathSync, statSync, writeFileSync } from "@ponderosa/native-host/fs";
import os from "node:os";
import path from "node:path";
import { createTarGz, type ArchiveEntry } from "./archive.js";
import { inspectLauncher } from "./control.js";
import { ensureDataLayout, readLauncherConfiguration, readLauncherState } from "./paths.js";
import type {
  BuildManifest,
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

export async function writeDiagnosticBundle(input: {
  paths: LauncherPaths;
  manifest: BuildManifest;
  now?: Date;
  output?: string;
}): Promise<string> {
  const inspection = await inspectLauncher(input.paths);
  try {
  if (inspection.readOnly && !input.output) throw new Error("a live daemon owns archive storage; select an external --output or stop it first");
  if (!inspection.readOnly) ensureDataLayout(inspection.paths);
  const originalRoot = path.resolve(input.paths.dataDir);
  input = { ...input, paths: inspection.paths };
  const now = input.now ?? new Date();
  const stamp = now.toISOString().replaceAll(":", "-");
  const target = input.output ? path.resolve(input.output) : path.join(input.paths.diagnosticsDir, `ponderosa-diagnostics-${stamp}.tgz`);
  if (input.output && (target === originalRoot || target.startsWith(`${originalRoot}${path.sep}`))) throw new Error("external output must be outside the retained root");
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
  if (input.output) {
    const root = realpathSync(input.paths.dataDir);
    const directory = realpathSync(path.dirname(target));
    if (directory === root || directory.startsWith(`${root}${path.sep}`)) throw new Error("external output resolves inside the retained root");
    // Reuse native retained-parent publication on every platform. External
    // archives must not depend on Linux's descriptor pathname namespace.
    writeSecureFileAtomic({ root: directory, leaf: path.basename(target),
      temporaryLeaf: `.diagnostics.${randomUUID()}.tmp`, body: createTarGz(entries) });
  } else { writeFileSync(target, createTarGz(entries), { mode: 0o600, flag: "wx" }); }
  return target;
  } finally { inspection.close(); }
}
