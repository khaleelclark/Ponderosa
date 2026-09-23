// Engine auth-status detection. Engine-specific, so it lives in packages/engines
// (AGENTS.md invariant 2). Ponderosa NEVER handles provider credentials directly
// (invariant 1); it asks the CLI for its auth mode so the UI can show an auth
// badge without Ponderosa reading token files (SPEC §8 /api/engines, §9).

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyProviderFailure,
  type EngineAuthStatus,
  type EngineAvailabilityStatus,
} from "@ponderosa/core";
import { spawnContainedCli } from "./contained-spawn.js";
import { runtimeProcessHandle } from "./process-termination.js";
import { runtimeEnvironment } from "./runtime-environment.js";

type AuthCommandRunner = (
  bin: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

async function containedAuthCommand(
  bin: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  const spawned = spawnContainedCli({
    bin,
    args,
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
    stdin: "ignore",
  });
  const handle = runtimeProcessHandle(spawned.child, {
    label: "provider authentication probe",
    termGraceMs: 1_000,
    killConfirmationMs: 2_000,
  }, spawned.authority);
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      void finish(new Error(`provider authentication probe timed out after ${options.timeout}ms`), true);
    }, options.timeout);
    const finish = async (error?: Error, terminate = false): Promise<void> => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        // close() is an observed no-op after natural exit and exact tree
        // teardown after timeout, output overflow, or spawn failure.
        await handle.close();
      } catch (closeError) {
        error = new Error(
          `${error?.message ?? "provider authentication probe failed"}; teardown: ` +
          `${closeError instanceof Error ? closeError.message : String(closeError)}`,
        );
      }
      if (error || terminate) {
        const failure = error ?? new Error("provider authentication probe failed");
        Object.assign(failure, { stdout, stderr });
        reject(failure);
      } else {
        resolve({ stdout, stderr });
      }
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
      const text = chunk.toString();
      bytes += Buffer.byteLength(text);
      if (stream === "stdout") stdout += text;
      else stderr += text;
      if (bytes > options.maxBuffer) {
        void finish(new Error(`provider authentication probe exceeded ${options.maxBuffer} output bytes`), true);
      }
    };
    spawned.child.stdout?.on("data", (chunk: Buffer | string) => collect("stdout", chunk));
    spawned.child.stderr?.on("data", (chunk: Buffer | string) => collect("stderr", chunk));
    spawned.child.once("error", (error) => void finish(error, true));
    spawned.child.once("close", (code, signal) => {
      if (code === 0) void finish();
      else void finish(new Error(
        `provider authentication probe exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`,
      ));
    });
  });
}

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
  const bin = env.PONDEROSA_CODEX_BIN?.trim() || "codex";
  try {
    const { stdout, stderr } = await containedAuthCommand(bin, ["login", "status"], {
      env: runtimeEnvironment(env),
      timeout: 5000,
      maxBuffer: 256 * 1024,
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

/** One bounded, read-only provider round trip from the installed Codex CLI.
 * Login status is not reachability evidence, and this probe never starts a
 * Ponderosa Run or grants the model tool or workspace authority. */
export async function codexAvailabilityStatus(
  env: NodeJS.ProcessEnv = process.env,
  run: AuthCommandRunner = containedAuthCommand,
  readAuth: () => Promise<EngineAuthStatus> = () => codexAuthStatus(env),
): Promise<EngineAvailabilityStatus> {
  const auth = await readAuth();
  if (!auth.authenticated) {
    return { available: false, failureCategory: "authentication", detail: auth.detail };
  }
  const bin = env.PONDEROSA_CODEX_BIN?.trim() || "codex";
  const marker = "PONDEROSA_RUNTIME_READY";
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ponderosa-codex-probe-"));
  try {
    const { stdout } = await run(bin, [
      "exec", "--json", "--ephemeral", "--sandbox", "read-only",
      "--ignore-user-config", "--skip-git-repo-check",
      `Reply exactly ${marker}. Do not use tools or inspect the environment.`,
    ], {
      env: runtimeEnvironment(env),
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      cwd,
    });
    let completed = false;
    let answer: string | undefined;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      let event: unknown;
      try { event = JSON.parse(line); }
      catch { return { available: false, failureCategory: "unavailable", detail: "Codex returned invalid probe events" }; }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        return { available: false, failureCategory: "unavailable", detail: "Codex returned invalid probe events" };
      }
      const item = (event as { item?: { type?: unknown; text?: unknown } }).item;
      // A successful qualification must be tool-free, even if a future CLI
      // version adds tools to a nominally read-only invocation.
      if (item && item.type !== "agent_message" && item.type !== "reasoning") {
        return { available: false, failureCategory: "unavailable", detail: "Codex probe attempted a tool" };
      }
      if ((event as { type?: unknown }).type === "item.completed" &&
          item?.type === "agent_message" && typeof item.text === "string") answer = item.text;
      if ((event as { type?: unknown }).type === "turn.completed") completed = true;
      if ((event as { type?: unknown }).type === "turn.failed") {
        return { available: false, failureCategory: "unavailable", detail: "Codex did not complete the test request" };
      }
    }
    return completed && answer?.trim() === marker
      ? { available: true, detail: "Codex accepted a subscription-backed test request" }
      : { available: false, failureCategory: "unavailable", detail: "Codex did not return the test marker" };
  } catch (error) {
    const failure = error as Error & { stderr?: string; stdout?: string };
    const detail = failure.stderr?.trim() || failure.stdout?.trim() || failure.message || String(error);
    return {
      available: false,
      failureCategory: classifyProviderFailure(detail),
      detail: detail.slice(0, 1_000),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
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
  run: AuthCommandRunner = containedAuthCommand,
  readAuth: () => Promise<EngineAuthStatus> = () => claudeAuthStatus(env),
): Promise<EngineAvailabilityStatus> {
  const auth = await readAuth();
  if (!auth.authenticated) {
    return { available: false, failureCategory: "authentication", detail: auth.detail };
  }
  const bin = env.PONDEROSA_CLAUDE_BIN?.trim() || "claude";
  const marker = "PONDEROSA_RUNTIME_READY";
  try {
    const { stdout } = await run(bin, [
      "--print",
      "--output-format", "json",
      "--permission-mode", "dontAsk",
      "--tools", "",
      "--safe-mode",
      "--no-session-persistence",
      `Reply exactly ${marker} and do nothing else.`,
    ], {
      env: runtimeEnvironment(env),
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    let parsed: unknown;
    try { parsed = JSON.parse(stdout); }
    catch {
      return { available: false, failureCategory: "unavailable", detail: "Claude returned an invalid entitlement-test result" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { available: false, failureCategory: "unavailable", detail: "Claude returned an invalid entitlement-test result" };
    }
    const result = parsed as {
      type?: unknown; subtype?: unknown; is_error?: unknown;
      result?: unknown; error?: unknown;
    };
    if (result.type !== "result" || result.subtype !== "success" || result.is_error !== false) {
      const hint = typeof result.error === "string" ? result.error
        : typeof result.result === "string" ? result.result : "";
      return {
        available: false,
        failureCategory: classifyProviderFailure(hint),
        detail: "Claude did not complete the subscription-backed test request",
      };
    }
    if (typeof result.result !== "string" || result.result.trim() !== marker) {
      return { available: false, failureCategory: "unavailable", detail: "Claude did not return the entitlement-test marker" };
    }
    return { available: true, detail: "Claude accepted a subscription-backed test request" };
  } catch (error) {
    const failure = error as Error & { stderr?: string; stdout?: string };
    const detail = failure.stderr?.trim() || failure.stdout?.trim() || failure.message || String(error);
    return {
      available: false,
      failureCategory: classifyProviderFailure(detail),
      detail: detail.slice(0, 1_000),
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
