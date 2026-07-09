// Engine auth-status detection. Engine-specific, so it lives in packages/engines
// (AGENTS.md invariant 2). Ponderosa NEVER handles provider credentials directly
// (invariant 1); it only observes whether the CLI's own on-disk login exists so
// the UI can show an auth badge (SPEC §8 /api/engines, §9).

import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EngineAuthStatus } from "@ponderosa/core";

/** Resolve the Codex home dir (honors CODEX_HOME, else ~/.codex). */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME && env.CODEX_HOME.trim() !== ""
    ? env.CODEX_HOME
    : path.join(os.homedir(), ".codex");
}

/**
 * Report whether `codex login` has been completed, by checking for the token file
 * the CLI writes (`$CODEX_HOME/auth.json`). We never read its contents — presence
 * is enough to show the badge; the CLI owns the credential.
 */
export async function codexAuthStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EngineAuthStatus> {
  const authFile = path.join(codexHome(env), "auth.json");
  try {
    await access(authFile);
    return { authenticated: true, detail: "codex login present" };
  } catch {
    return {
      authenticated: false,
      detail: "run `codex login` on the host to authenticate the ChatGPT subscription",
    };
  }
}
