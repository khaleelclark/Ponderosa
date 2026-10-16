import { accessSync, constants, existsSync, readdirSync } from "@ponderosa/native-host/fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { PlatformAdapter, UpdateRestartPrompt } from "./types.js";

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
      .sort(compareVersionDirectoryNamesDescending)
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

function compareVersionDirectoryNamesDescending(left: string, right: string): number {
  const leftNumbers = left.match(/\d+/gu)?.map(Number) ?? [];
  const rightNumbers = right.match(/\d+/gu)?.map(Number) ?? [];
  const width = Math.max(leftNumbers.length, rightNumbers.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (rightNumbers[index] ?? -1) - (leftNumbers[index] ?? -1);
    if (difference) return difference;
  }
  if (left === right) return 0;
  return left < right ? 1 : -1;
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

async function runPrompt(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string } | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = `${stdout}${chunk}`.slice(-4_000);
    });
    child.once("error", () => resolve(undefined));
    child.once("exit", (code) => resolve({ code, stdout }));
  });
}

function updateRestartMessage(input: UpdateRestartPrompt): string {
  const shortCommit = (commit: string): string => commit.slice(0, 12);
  return [
    "A different Ponderosa Server version is still running.",
    "",
    `Running: ${input.running.version} (${shortCommit(input.running.commit)})`,
    `Installed: ${input.installed.version} (${shortCommit(input.installed.commit)})`,
    "",
    "Restart now to use the installed version?",
    "Active Agent work will stop safely. Your Projects and Ponderosa data will be preserved.",
  ].join("\n");
}

class HostPlatformAdapter implements PlatformAdapter {
  constructor(readonly platform: NodeJS.Platform = process.platform) {}

  defaultDataDir(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
    if (this.platform === "darwin") {
      return path.join(homeDir, "Library", "Application Support", "Ponderosa");
    }
    if (this.platform === "win32") {
      const localAppData = env.LOCALAPPDATA?.trim();
      return path.join(localAppData || path.join(homeDir, "AppData", "Local"), "Ponderosa");
    }
    const xdg = env.XDG_DATA_HOME?.trim();
    return path.join(xdg || path.join(homeDir, ".local", "share"), "ponderosa");
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
      if (provider === "codex") {
        candidates.push(path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"));
      }
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

  async confirmUpdateRestart(input: UpdateRestartPrompt): Promise<boolean> {
    const message = updateRestartMessage(input);
    if (this.platform === "darwin") {
      const result = await runPrompt("/usr/bin/osascript", [
        "-e", "on run argv",
        "-e", "set promptText to item 1 of argv",
        "-e", "display dialog promptText with title \"Ponderosa Update\" buttons {\"Not Now\", \"Restart\"} default button \"Restart\" with icon note",
        "-e", "return button returned of result",
        "-e", "end run",
        "--",
        message,
      ]);
      return result?.code === 0 && result.stdout.trim() === "Restart";
    }
    if (this.platform === "win32") {
      const result = await runPrompt("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName PresentationFramework; " +
          "$choice = [System.Windows.MessageBox]::Show(" +
          "$env:PONDEROSA_UPDATE_PROMPT, 'Ponderosa Update', " +
          "[System.Windows.MessageBoxButton]::YesNo, " +
          "[System.Windows.MessageBoxImage]::Information); " +
          "Write-Output $choice",
      ], {
        ...process.env,
        PONDEROSA_UPDATE_PROMPT: message,
      });
      return result?.code === 0 && result.stdout.trim() === "Yes";
    }
    const zenity = await runPrompt("zenity", [
      "--question",
      "--title=Ponderosa Update",
      `--text=${message}`,
      "--ok-label=Restart",
      "--cancel-label=Not Now",
      "--width=520",
    ]);
    if (zenity) return zenity.code === 0;
    const kdialog = await runPrompt("kdialog", [
      "--title",
      "Ponderosa Update",
      "--yesno",
      message,
      "--yes-label",
      "Restart",
      "--no-label",
      "Not Now",
    ]);
    return kdialog?.code === 0;
  }
}

export function hostPlatformAdapter(platform: NodeJS.Platform = process.platform): PlatformAdapter {
  return new HostPlatformAdapter(platform);
}
