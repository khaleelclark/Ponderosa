import { accessSync, constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  LauncherConfiguration,
  PlatformAdapter,
  ProviderDiscovery,
} from "./types.js";

const execFileAsync = promisify(execFile);

function isUsableExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function invocation(
  executable: string,
  args: string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { executable: string; args: string[] } {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(executable)) {
    return { executable, args };
  }
  const command = [`"${executable}"`, ...args].join(" ");
  return {
    executable: env.ComSpec?.trim() || env.COMSPEC?.trim() || "cmd.exe",
    args: ["/d", "/s", "/c", `"${command}"`],
  };
}

async function executableVersion(
  executable: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const call = invocation(executable, ["--version"], platform, env);
  try {
    const { stdout, stderr } = await execFileAsync(call.executable, call.args, {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env,
    });
    return `${stdout}\n${stderr}`.trim().split(/\r?\n/, 1)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function authenticationStatus(
  provider: "codex" | "claude",
  executable: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<{ authenticated?: boolean; detail: string }> {
  const call = invocation(
    executable,
    provider === "codex" ? ["login", "status"] : ["auth", "status"],
    platform,
    env,
  );
  try {
    await execFileAsync(call.executable, call.args, {
        timeout: 8_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        env,
      },
    );
    return { authenticated: true, detail: "Existing provider login detected." };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: string | number }).code;
    if (code === "ENOENT" || code === "ENOTSUP") {
      return { detail: "This provider version does not expose a safe login-status check." };
    }
    return { authenticated: false, detail: "Provider login was not confirmed." };
  }
}

export async function discoverProvider(
  provider: "codex" | "claude",
  platform: PlatformAdapter,
  configuration: LauncherConfiguration,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderDiscovery> {
  const configured = configuration.providers?.[provider]?.executable?.trim();
  if (configured && !isUsableExecutable(configured, platform.platform)) {
    return {
      id: provider,
      installed: false,
      executable: configured,
      detail: `The configured ${provider} executable is unavailable.`,
    };
  }
  const executable = configured ?? platform.executableCandidates(provider, env)[0];
  if (!executable) {
    return {
      id: provider,
      installed: false,
      detail: `${provider === "codex" ? "Codex" : "Claude Code"} was not found. Select its executable in Ponderosa Settings.`,
    };
  }
  const version = await executableVersion(executable, platform.platform, env);
  const authentication = await authenticationStatus(provider, executable, platform.platform, env);
  return {
    id: provider,
    installed: true,
    executable,
    ...(version ? { version } : {}),
    ...(authentication.authenticated !== undefined ? { authenticated: authentication.authenticated } : {}),
    authenticationDetail: authentication.detail,
    detail: version
      ? `${provider === "codex" ? "Codex" : "Claude Code"} is installed.`
      : `${provider === "codex" ? "Codex" : "Claude Code"} is present, but its version could not be read.`,
  };
}

export async function discoverProviders(
  platform: PlatformAdapter,
  configuration: LauncherConfiguration,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderDiscovery[]> {
  return Promise.all([
    discoverProvider("codex", platform, configuration, env),
    discoverProvider("claude", platform, configuration, env),
  ]);
}
