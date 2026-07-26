import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type {
  ProviderUsage,
  ProviderUsageReadOptions,
  ProviderUsageWindow,
  RuntimeProcessHandle,
} from "@ponderosa/core";
import { JsonRpcProcess } from "./json-rpc-process.js";
import { parseJsonlChunks } from "./jsonl.js";
import type { SpawnFn } from "./process.js";
import { runtimeProcessHandle } from "./process-termination.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function boundedPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : undefined;
}

function futureResetTimestamp(value: string, now = new Date()): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed
    .replace(/(\d)(am|pm)\b/iu, "$1 $2")
    .replace(/\s*\(([^)]+)\)\s*$/u, " $1");
  const explicit = Date.parse(normalized);
  if (Number.isFinite(explicit) && /\b\d{4}\b/u.test(trimmed)) {
    return new Date(explicit).toISOString();
  }
  for (const year of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const withYear = normalized.replace(
      /^([A-Za-z]{3,9}\s+\d{1,2},?)(\s+)/u,
      `$1 ${year}$2`,
    );
    const parsed = Date.parse(withYear);
    if (!Number.isFinite(parsed)) continue;
    // Provider reset labels omit the year. Keep the current-year timestamp
    // unless it is clearly an old calendar date, then roll forward once.
    if (parsed >= now.getTime() - 36 * 60 * 60_000 || year > now.getUTCFullYear()) {
      return new Date(parsed).toISOString();
    }
  }
  return undefined;
}

export function parseClaudeUsageText(text: string, now = new Date()): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^Current (session|week)(?: \(([^)]+)\))?:\s*([0-9]+(?:\.[0-9]+)?)% used(?:\s*·\s*resets\s+(.+))?$/iu.exec(line.trim());
    if (!match) continue;
    const id = match[1]!.toLowerCase();
    const usedPercent = boundedPercent(Number(match[3]));
    const resetsAt = match[4] ? futureResetTimestamp(match[4], now) : undefined;
    windows.push({
      id,
      label: id === "session"
        ? "Current session"
        : match[2]?.trim()
          ? `Current week (${match[2].trim()})`
          : "Current week",
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  if (windows.length === 0) {
    throw new Error("Claude /usage returned no recognizable subscription windows");
  }
  return windows;
}

interface ClaudeUsageEvidence {
  text?: string;
  result?: string;
  zeroTokenSyntheticMessage: boolean;
  zeroTokenResult: boolean;
}

function zeroUsage(value: unknown): boolean {
  const usage = record(value);
  return Boolean(usage) && [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ].every((key) => usage![key] === 0);
}

function observeClaudeUsage(raw: unknown, evidence: ClaudeUsageEvidence): void {
  const event = record(raw);
  if (event?.type === "assistant") {
    const message = record(event.message);
    if (message?.model === "<synthetic>" && zeroUsage(message.usage)) {
      evidence.zeroTokenSyntheticMessage = true;
      const content = Array.isArray(message.content) ? message.content : [];
      const text = content
        .flatMap((candidate) => {
          const block = record(candidate);
          return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
        })
        .join("\n")
        .trim();
      if (text) evidence.text = text;
    }
  }
  if (event?.type === "result") {
    const modelUsage = record(event.modelUsage);
    const noModelUsage = !modelUsage || Object.keys(modelUsage).length === 0;
    evidence.zeroTokenResult = event.subtype === "success" &&
      event.is_error === false &&
      event.num_turns === 0 &&
      event.duration_api_ms === 0 &&
      event.total_cost_usd === 0 &&
      zeroUsage(event.usage) &&
      noModelUsage;
    if (typeof event.result === "string" && event.result.trim()) {
      evidence.result = event.result.trim();
    }
  }
}

function childCompletion(child: ChildProcess): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => resolve({ code, ...(spawnError ? { error: spawnError } : {}) }));
  });
}

export async function readClaudeProviderUsage(input: {
  bin: string;
  spawnFn?: SpawnFn;
  killGraceMs: number;
  options: ProviderUsageReadOptions;
}): Promise<ProviderUsage> {
  const { options } = input;
  if (options.signal.aborted) throw new Error("Claude usage read aborted");
  const child = (input.spawnFn ?? nodeSpawn)(input.bin, [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "dontAsk",
    "--tools", "",
    "--no-session-persistence",
    "/usage",
  ], {
    cwd: options.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const handle = runtimeProcessHandle(child, {
    label: "Claude provider usage",
    termGraceMs: input.killGraceMs,
  });
  options.onRuntimeSpawned(handle);
  const completed = childCompletion(child);
  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-8_192);
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void handle.close().catch(() => undefined);
  }, options.timeoutMs ?? 15_000);
  timeout.unref();
  const abort = (): void => { void handle.close().catch(() => undefined); };
  options.signal.addEventListener("abort", abort);
  const evidence: ClaudeUsageEvidence = {
    zeroTokenSyntheticMessage: false,
    zeroTokenResult: false,
  };
  try {
    if (!child.stdout) throw new Error("Claude usage stdout is unavailable");
    for await (const raw of parseJsonlChunks(child.stdout as AsyncIterable<Buffer>)) {
      observeClaudeUsage(raw, evidence);
    }
    const terminal = await completed;
    if (timedOut) throw new Error("Claude usage read timed out");
    if (options.signal.aborted) throw new Error("Claude usage read aborted");
    if (terminal.error) throw new Error(`failed to spawn Claude: ${terminal.error.message}`);
    if (terminal.code !== 0) {
      throw new Error(`Claude usage command exited with code ${terminal.code}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""}`);
    }
    if (!evidence.zeroTokenSyntheticMessage || !evidence.zeroTokenResult) {
      throw new Error("Claude /usage did not provide zero-token command evidence");
    }
    const text = evidence.result ?? evidence.text;
    if (!text) throw new Error("Claude /usage returned no result text");
    return {
      provider: "claude",
      windows: parseClaudeUsageText(text),
      source: "provider-command",
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
    await handle.close();
  }
}

function durationId(minutes: number | undefined): string {
  if (!minutes) return "limit";
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function durationLabel(minutes: number | undefined): string {
  if (!minutes) return "Rate limit";
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}

export function normalizeCodexProviderUsage(
  accountResponse: unknown,
  limitsResponse: unknown,
  fetchedAt = new Date(),
): ProviderUsage {
  const account = record(record(accountResponse)?.account);
  const byId = record(record(limitsResponse)?.rateLimitsByLimitId);
  const legacy = record(record(limitsResponse)?.rateLimits);
  const snapshots = Object.entries(byId ?? {}).flatMap(([limitId, value]) => {
    const snapshot = record(value);
    return snapshot ? [{ limitId, snapshot }] : [];
  });
  if (snapshots.length === 0 && legacy) {
    snapshots.push({
      limitId: typeof legacy.limitId === "string" && legacy.limitId.trim()
        ? legacy.limitId.trim()
        : "codex",
      snapshot: legacy,
    });
  }
  const multipleLimits = snapshots.length > 1;
  const windows: ProviderUsageWindow[] = [];
  for (const { limitId, snapshot } of snapshots) {
    const limitName = typeof snapshot.limitName === "string" && snapshot.limitName.trim()
      ? snapshot.limitName.trim()
      : undefined;
    for (const [position, value] of [["primary", snapshot.primary], ["secondary", snapshot.secondary]] as const) {
      const window = record(value);
      if (!window) continue;
      const usedPercent = boundedPercent(window.usedPercent);
      const minutes = typeof window.windowDurationMins === "number" &&
        Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0
        ? window.windowDurationMins
        : undefined;
      const id = durationId(minutes);
      const resetsAt = typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
        ? new Date(window.resetsAt * 1_000).toISOString()
        : undefined;
      windows.push({
        id: multipleLimits || position === "secondary" ? `${limitId}:${position}:${id}` : id,
        label: `${limitName ? `${limitName} · ` : ""}${durationLabel(minutes)}`,
        ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  if (windows.length === 0) {
    throw new Error("Codex returned no subscription rate-limit windows");
  }
  const email = typeof account?.email === "string" && account.email.trim()
    ? account.email.trim()
    : undefined;
  const plan = typeof account?.planType === "string" && account.planType.trim()
    ? account.planType.trim()
    : undefined;
  return {
    provider: "codex",
    windows,
    ...(email ? { accountLabel: email } : plan ? { accountLabel: plan } : {}),
    source: "provider-rpc",
    fetchedAt: fetchedAt.toISOString(),
  };
}

export async function readCodexProviderUsage(input: {
  bin: string;
  spawnFn?: SpawnFn;
  sandboxMode: string;
  killGraceMs: number;
  options: ProviderUsageReadOptions;
}): Promise<ProviderUsage> {
  const { options } = input;
  if (options.signal.aborted) throw new Error("Codex usage read aborted");
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal.addEventListener("abort", abort);
  if (options.signal.aborted) controller.abort();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 15_000);
  timeout.unref();
  const rpc = new JsonRpcProcess({
    bin: input.bin,
    args: [
      "app-server", "--stdio",
      "-c", `sandbox_mode=${JSON.stringify(input.sandboxMode)}`,
      "-c", 'approval_policy="never"',
    ],
    cwd: options.cwd,
    signal: controller.signal,
    spawnFn: input.spawnFn,
    killGraceMs: input.killGraceMs,
    onRuntimeSpawned: options.onRuntimeSpawned,
    onRuntimeRootExit: () => undefined,
  });
  try {
    await rpc.initialize();
    const [account, limits] = await Promise.all([
      rpc.request("account/read", { refreshToken: false }),
      rpc.request("account/rateLimits/read"),
    ]);
    return normalizeCodexProviderUsage(account, limits);
  } catch (error) {
    if (timedOut) throw new Error("Codex usage read timed out");
    if (options.signal.aborted) throw new Error("Codex usage read aborted");
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
    controller.abort();
    await rpc.close();
  }
}
