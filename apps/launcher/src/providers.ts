import { accessSync, constants } from "node:fs";
import type {
  LauncherConfiguration,
  PlatformAdapter,
  ProviderDiscovery,
} from "./types.js";

function isUsableExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The launcher discovers only a provider executable path. Authentication,
 * version, and subscription availability are server-owned engine probes,
 * where every provider process is placed in the same contained spawn boundary
 * and host-only Ponderosa credentials are stripped centrally.
 */
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
  return {
    id: provider,
    installed: true,
    executable,
    authenticationDetail:
      "Provider authentication and subscription availability are verified by the contained server engine probe.",
    detail: `${provider === "codex" ? "Codex" : "Claude Code"} executable is present.`,
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
