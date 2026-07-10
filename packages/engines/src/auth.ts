// Engine auth-status detection. Engine-specific, so it lives in packages/engines
// (AGENTS.md invariant 2). Ponderosa NEVER handles provider credentials directly
// (invariant 1); it asks the CLI for its auth mode so the UI can show an auth
// badge without Ponderosa reading token files (SPEC §8 /api/engines, §9).

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { EngineAuthStatus } from "@ponderosa/core";

const execFileAsync = promisify(execFile);

const API_AUTH_DETAIL =
  "Codex is logged in with API-key/token auth; run `codex logout` then `codex login` for ChatGPT subscription auth";
const LOGIN_DETAIL = "run `codex login` on the host to authenticate the ChatGPT subscription";

/** Resolve the Codex home dir (honors CODEX_HOME, else ~/.codex). */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME && env.CODEX_HOME.trim() !== ""
    ? env.CODEX_HOME
    : path.join(os.homedir(), ".codex");
}

/** Report whether `codex login` is using ChatGPT subscription auth. */
export async function codexAuthStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EngineAuthStatus> {
  const bin = env.PONDEROSA_CODEX_BIN ?? "codex";
  try {
    const { stdout, stderr } = await execFileAsync(bin, ["login", "status"], {
      env: { ...process.env, ...env },
      timeout: 5000,
    });
    const output = `${stdout}\n${stderr}`.trim();
    return parseCodexLoginStatus(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      authenticated: false,
      detail: `run \`codex login\` on the host for ChatGPT subscription auth (${message})`,
    };
  }
}

export function parseCodexLoginStatus(output: string): EngineAuthStatus {
  const detail = output.trim();
  const normalized = detail.toLowerCase();

  if (normalized.includes("api key") || normalized.includes("access token")) {
    return { authenticated: false, detail: API_AUTH_DETAIL };
  }

  if (
    normalized.includes("chatgpt") &&
    (normalized.includes("logged in") || normalized.includes("authenticated")) &&
    !normalized.includes("not logged in") &&
    !normalized.includes("not authenticated")
  ) {
    return { authenticated: true, detail: detail || "logged in using ChatGPT" };
  }

  return { authenticated: false, detail: detail || LOGIN_DETAIL };
}
