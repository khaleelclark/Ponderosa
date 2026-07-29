import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { PlatformAdapter } from "./types.js";

function canExecute(candidate: string): boolean {
  try {
    accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const suffixes = platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  return (env.PATH ?? "").split(path.delimiter).filter(Boolean).flatMap((directory) =>
    suffixes.map((suffix) => path.join(directory, `${command}${suffix.toLowerCase()}`)));
}

function claudeDesktopCandidates(homeDir: string): string[] {
  const versionsRoot = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Claude",
    "claude-code",
  );
  try {
    return readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, {
        numeric: true,
        sensitivity: "base",
      }))
      .map((version) => path.join(
        versionsRoot,
        version,
        "claude.app",
        "Contents",
        "MacOS",
        "claude",
      ));
  } catch {
    return [];
  }
}

async function spawnDetached(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

class HostPlatformAdapter implements PlatformAdapter {
  constructor(readonly platform: NodeJS.Platform = process.platform) {}

  defaultDataDir(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
    if (this.platform === "darwin") {
      return path.join(homeDir, "Library", "Application Support", "Ponderosa Beta");
    }
    if (this.platform === "win32") {
      const localAppData = env.LOCALAPPDATA?.trim();
      return path.join(localAppData || path.join(homeDir, "AppData", "Local"), "Ponderosa Beta");
    }
    const xdg = env.XDG_DATA_HOME?.trim();
    return path.join(xdg || path.join(homeDir, ".local", "share"), "ponderosa-beta");
  }

  nodeExecutableName(): string {
    return this.platform === "win32" ? "node.exe" : "node";
  }

  executableCandidates(
    provider: "codex" | "claude",
    env: NodeJS.ProcessEnv = process.env,
    homeDir = os.homedir(),
  ): string[] {
    const configured = provider === "codex" ? env.PONDEROSA_CODEX_BIN : env.PONDEROSA_CLAUDE_BIN;
    const candidates = configured?.trim() ? [configured.trim()] : [];
    candidates.push(...pathCandidates(provider, env, this.platform));
    if (this.platform === "darwin") {
      candidates.push(
        `/opt/homebrew/bin/${provider}`,
        `/usr/local/bin/${provider}`,
        path.join(homeDir, ".local", "bin", provider),
        path.join(homeDir, ".npm-global", "bin", provider),
      );
      if (provider === "claude") candidates.push(...claudeDesktopCandidates(homeDir));
    } else if (this.platform === "win32") {
      const appData = env.APPDATA?.trim() || path.join(homeDir, "AppData", "Roaming");
      const localAppData = env.LOCALAPPDATA?.trim() || path.join(homeDir, "AppData", "Local");
      candidates.push(
        path.join(appData, "npm", `${provider}.cmd`),
        path.join(appData, "npm", `${provider}.exe`),
        path.join(localAppData, "Programs", provider, `${provider}.exe`),
      );
    } else {
      candidates.push(
        `/usr/local/bin/${provider}`,
        `/usr/bin/${provider}`,
        path.join(homeDir, ".local", "bin", provider),
        path.join(homeDir, ".npm-global", "bin", provider),
      );
    }
    return [...new Set(candidates.map((candidate) => path.resolve(candidate)).filter((candidate) =>
      existsSync(candidate) && canExecute(candidate)))];
  }

  async openBrowser(url: string): Promise<void> {
    if (this.platform === "darwin") {
      await spawnDetached("open", [url]);
      return;
    }
    if (this.platform === "win32") {
      await spawnDetached("cmd.exe", ["/d", "/s", "/c", "start", "", url]);
      return;
    }
    await spawnDetached("xdg-open", [url]);
  }
}

export function hostPlatformAdapter(platform: NodeJS.Platform = process.platform): PlatformAdapter {
  return new HostPlatformAdapter(platform);
}
