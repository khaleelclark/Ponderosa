#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentPonderosaStatus, startPonderosa, stopPonderosa } from "./control.js";
import { writeDiagnosticBundle } from "./diagnostics.js";
import { runDoctor } from "./doctor.js";
import { readBuildManifest } from "./manifest.js";
import { ensureDataLayout, readLauncherState, resolveLauncherPaths } from "./paths.js";
import { hostPlatformAdapter } from "./platform.js";

type Command = "open" | "start" | "stop" | "restart" | "status" | "doctor" | "diagnostics" | "version" | "help";

interface ParsedArguments {
  command: Command;
  dataDir?: string;
  installRoot?: string;
  port?: number;
  openBrowser: boolean;
  json: boolean;
}

const HELP = `Ponderosa private-beta launcher

Usage:
  ponderosa [open|start|stop|restart|status|doctor|diagnostics|version] [options]

Commands:
  open          Start Ponderosa if necessary and open it in the default browser
  start         Start Ponderosa without opening a browser
  stop          Gracefully stop Ponderosa and its provider processes
  restart       Stop, start, and open Ponderosa
  status        Show whether this installation owns a healthy running instance
  doctor        Check installation, providers, storage, Git, ports, and process control
  diagnostics   Create a credential-free support archive
  version       Print exact build identity and target information

Options:
  --data-dir <path>      Override the private Ponderosa data directory
  --install-root <path>  Override the installed application root (support use)
  --port <number>        Override the configured loopback port for this start
  --no-browser           Do not open the default browser
  --json                 Print machine-readable output where supported
`;

function parseArguments(argv: string[]): ParsedArguments {
  let command: Command = "open";
  let dataDir: string | undefined;
  let installRoot: string | undefined;
  let port: number | undefined;
  let openBrowser = true;
  let json = false;
  let commandSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("-") && !commandSeen) {
      if (!["open", "start", "stop", "restart", "status", "doctor", "diagnostics", "version", "help"].includes(argument)) {
        throw new Error(`Unknown command: ${argument}`);
      }
      command = argument as Command;
      commandSeen = true;
      continue;
    }
    if (argument === "--data-dir") {
      dataDir = argv[++index];
      if (!dataDir) throw new Error("--data-dir requires a path");
    } else if (argument === "--install-root") {
      installRoot = argv[++index];
      if (!installRoot) throw new Error("--install-root requires a path");
    } else if (argument === "--port") {
      port = Number(argv[++index]);
      if (!Number.isSafeInteger(port)) throw new Error("--port requires an integer");
    } else if (argument === "--no-browser") {
      openBrowser = false;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--help" || argument === "-h") {
      command = "help";
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return {
    command,
    ...(dataDir ? { dataDir } : {}),
    ...(installRoot ? { installRoot } : {}),
    ...(port !== undefined ? { port } : {}),
    openBrowser,
    json,
  };
}

function isDirectInvocation(entryPath: string | undefined, moduleUrl: string): boolean {
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return pathToFileURL(entryPath).href === moduleUrl;
  }
}

function printDoctor(report: Awaited<ReturnType<typeof runDoctor>>): void {
  process.stdout.write(`Ponderosa Doctor — ${report.ready ? "ready" : "needs attention"}\n\n`);
  for (const item of report.checks) {
    const marker = item.status === "pass" ? "✓" : item.status === "warning" ? "!" : "✗";
    process.stdout.write(`${marker} ${item.label}: ${item.detail}\n`);
    if (item.repair) process.stdout.write(`  Fix: ${item.repair}\n`);
  }
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArguments(argv);
  if (parsed.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const platform = hostPlatformAdapter();
  const paths = resolveLauncherPaths({
    platform,
    ...(parsed.installRoot ? { installRoot: parsed.installRoot } : {}),
    ...(parsed.dataDir ? { dataDir: parsed.dataDir } : {}),
  });
  const manifest = readBuildManifest(paths.manifestPath);

  if (parsed.command === "version") {
    if (parsed.json) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    else {
      process.stdout.write([
        `Ponderosa ${manifest.version} (${manifest.channel})`,
        `Commit: ${manifest.commit}`,
        `Target: ${manifest.target.platform}/${manifest.target.arch}`,
        `Communication: ${manifest.communicationProtocolVersion}`,
        `Database: ${manifest.databaseSchemaVersion}`,
        `Node: ${manifest.nodeVersion}`,
        `Built: ${manifest.buildTime}`,
        "",
      ].join("\n"));
    }
    return;
  }

  ensureDataLayout(paths);
  if (parsed.command === "status") {
    const status = await currentPonderosaStatus(paths);
    if (parsed.json) process.stdout.write(`${JSON.stringify(status ?? { healthy: false, detail: "Ponderosa is not running." }, null, 2)}\n`);
    else process.stdout.write(`${status?.detail ?? "Ponderosa is not running."}\n`);
    if (!status?.healthy) process.exitCode = 1;
    return;
  }

  if (parsed.command === "doctor" || parsed.command === "diagnostics") {
    const report = await runDoctor({ paths, manifest, platform });
    if (parsed.command === "doctor") {
      if (parsed.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else printDoctor(report);
      if (!report.ready) process.exitCode = 1;
      return;
    }
    const target = writeDiagnosticBundle({ paths, manifest, doctor: report });
    process.stdout.write(`Diagnostic bundle created:\n${target}\n`);
    return;
  }

  if (parsed.command === "stop") {
    const result = await stopPonderosa({ paths });
    process.stdout.write(result === "stopped" ? "Ponderosa stopped.\n" : "Ponderosa is not running.\n");
    return;
  }

  if (parsed.command === "restart") {
    await stopPonderosa({ paths });
    const state = await startPonderosa({
      paths,
      manifest,
      platform,
      ...(parsed.port !== undefined ? { requestedPort: parsed.port } : {}),
      openBrowser: parsed.openBrowser,
    });
    process.stdout.write(`Ponderosa restarted at http://${state.host}:${state.port}\n`);
    return;
  }

  if (parsed.command === "open") {
    const running = await currentPonderosaStatus(paths);
    const runningDifferentBuild = running?.healthy && (
      running.version !== manifest.version ||
      running.commit !== manifest.commit ||
      running.channel !== manifest.channel
    );
    if (runningDifferentBuild && await platform.confirmUpdateRestart({
      running,
      installed: manifest,
    })) {
      await stopPonderosa({ paths });
    }
  }

  const state = await startPonderosa({
    paths,
    manifest,
    platform,
    ...(parsed.port !== undefined ? { requestedPort: parsed.port } : {}),
    openBrowser: parsed.command === "open" && parsed.openBrowser,
  });
  if (parsed.command === "start" && parsed.openBrowser) {
    // "start" deliberately leaves browser opening to the explicit open command.
    process.stdout.write(`Ponderosa started at http://${state.host}:${state.port}\n`);
  } else {
    process.stdout.write(`Ponderosa is available at http://${state.host}:${state.port}\n`);
  }
}

const direct = isDirectInvocation(process.argv[1], import.meta.url);
if (direct) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`Ponderosa launcher error: ${error instanceof Error ? error.message : String(error)}\n`);
    const statePath = (() => {
      try {
        const parsed = parseArguments(process.argv.slice(2));
        return resolveLauncherPaths({
          platform: hostPlatformAdapter(),
          ...(parsed.installRoot ? { installRoot: parsed.installRoot } : {}),
          ...(parsed.dataDir ? { dataDir: parsed.dataDir } : {}),
        }).statePath;
      } catch {
        return undefined;
      }
    })();
    if (statePath && readLauncherState(statePath)) {
      process.stderr.write("Run `ponderosa diagnostics` if the problem persists.\n");
    }
    process.exitCode = 1;
  });
}

export { isDirectInvocation, main, parseArguments };
