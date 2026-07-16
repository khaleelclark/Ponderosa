// Engine auth-status detection. Engine-specific, so it lives in packages/engines
// (AGENTS.md invariant 2). Ponderosa NEVER handles provider credentials directly
// (invariant 1); it asks the CLI for its auth mode so the UI can show an auth
// badge without Ponderosa reading token files (SPEC §8 /api/engines, §9).

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { EngineAuthStatus, EngineAvailabilityStatus } from "@ponderosa/core";

const execFileAsync = promisify(execFile);
type AuthCommandRunner = (
  bin: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

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

/**
 * Report whether Claude Code (`claude`) is logged in with a Claude Pro/Max
 * subscription (an OAuth account in `~/.claude.json`). We never read the token —
 * only the account's presence — and flag if `ANTHROPIC_API_KEY` is set, which would
 * route Claude Code to billed API auth instead of the subscription (invariant 1).
 */
export async function claudeAuthStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EngineAuthStatus> {
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim() !== "") {
    return {
      authenticated: false,
      detail:
        "ANTHROPIC_API_KEY is set — unset it so Claude Code uses your Pro/Max subscription, not billed API auth",
    };
  }
  const configPath = path.join(os.homedir(), ".claude.json");
  try {
    const raw = await readFile(configPath, "utf8");
    const config = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string } };
    if (config.oauthAccount) {
      const email = config.oauthAccount.emailAddress;
      return {
        authenticated: true,
        detail: email ? `logged in as ${email} (subscription)` : "Claude subscription login present",
      };
    }
    return { authenticated: false, detail: "run `claude` and sign in to your Claude Pro/Max account" };
  } catch {
    return { authenticated: false, detail: "run `claude` and sign in to your Claude Pro/Max account" };
  }
}

/**
 * Make one explicit, tool-free Claude request to prove current subscription
 * entitlement. This is intentionally separate from auth polling: credential
 * presence alone cannot prove that a lapsed subscription will accept work.
 */
export async function claudeAvailabilityStatus(
  env: NodeJS.ProcessEnv = process.env,
  run: AuthCommandRunner = execFileAsync,
  readAuth: () => Promise<EngineAuthStatus> = () => claudeAuthStatus(env),
): Promise<EngineAvailabilityStatus> {
  const auth = await readAuth();
  if (!auth.authenticated) return { available: false, detail: auth.detail };
  const bin = env.PONDEROSA_CLAUDE_BIN ?? "claude";
  try {
    const { stdout } = await run(bin, [
      "--print",
      "--output-format", "json",
      "--permission-mode", "dontAsk",
      "--tools", "",
      "--safe-mode",
      "--no-session-persistence",
      "Reply exactly PONDEROSA_RUNTIME_READY and do nothing else.",
    ], {
      env: { ...process.env, ...env },
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    try {
      const result = JSON.parse(stdout) as { is_error?: boolean; subtype?: string; error?: string };
      if (result.is_error || result.subtype === "error") {
        return { available: false, detail: result.error ?? "Claude rejected the subscription-backed test request" };
      }
    } catch {
      if (!stdout.trim()) return { available: false, detail: "Claude returned no entitlement-test result" };
    }
    return { available: true, detail: "Claude accepted a subscription-backed test request" };
  } catch (error) {
    const failure = error as Error & { stderr?: string; stdout?: string };
    const detail = failure.stderr?.trim() || failure.stdout?.trim() || failure.message || String(error);
    return { available: false, detail: detail.slice(0, 1_000) };
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
