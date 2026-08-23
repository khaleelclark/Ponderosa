import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  ProviderUsageReadError,
  type ProviderUsageFailureCode,
  type ProviderUsageAccountIdentity,
  type ProviderUsageSnapshot,
  type ProviderUsage,
  type ProviderUsageReadOptions,
  type ProviderUsageWindow,
  type RuntimeProcessHandle,
} from "@ponderosa/core";
import { spawnContainedCli } from "./contained-spawn.js";
import { JsonRpcProcess } from "./json-rpc-process.js";
import { parseJsonlChunks } from "./jsonl.js";
import { runtimeProcessHandle } from "./process-termination.js";
import { runtimeEnvironment } from "./runtime-environment.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function providerFailure(
  error: unknown,
  fallback: ProviderUsageFailureCode,
  metadata: { exitCode?: number; timedOut?: boolean } = {},
): ProviderUsageReadError {
  if (error instanceof ProviderUsageReadError) return error;
  const detail = error instanceof Error
    ? error.message.slice(0, 2_048).toLowerCase()
    : typeof error === "string"
      ? error.slice(0, 2_048).toLowerCase()
      : "";
  let code = fallback;
  if (/method not found|unsupported|does not expose|unknown command/u.test(detail)) {
    code = "usage_not_supported";
  } else if (/enoent|no such file|failed to spawn/u.test(detail)) {
    code = "provider_not_installed";
  } else if (/not authenticated|not logged in|sign[ -]?in|oauth|token.*expired|unauthorized|\b401\b|\b403\b/u.test(detail)) {
    code = "provider_not_authenticated";
  } else if (/disabled|access.*blocked|subscription.*inactive/u.test(detail)) {
    code = "provider_disabled";
  } else if (/output.*aggregate limit|output.*byte limit/u.test(detail)) {
    code = "invalid_provider_response";
  } else if (/rate.?limit|too many requests|\b429\b/u.test(detail)) {
    code = "provider_rate_limited";
  } else if (/temporar|unavailable|overloaded|\b502\b|\b503\b|\b504\b/u.test(detail)) {
    code = "provider_temporarily_unavailable";
  }
  return new ProviderUsageReadError(code, metadata);
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
    throw new ProviderUsageReadError("usage_not_supported");
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

async function* boundedOutput(
  source: AsyncIterable<Buffer>,
  maximumBytes = 1_048_576,
): AsyncGenerator<Buffer> {
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) {
      throw new ProviderUsageReadError("invalid_provider_response");
    }
    yield chunk;
  }
}

export async function readClaudeProviderUsage(input: {
  bin: string;
  killGraceMs: number;
  options: ProviderUsageReadOptions;
}): Promise<ProviderUsage> {
  const { options } = input;
  if (options.signal.aborted) throw new ProviderUsageReadError("provider_temporarily_unavailable");
  const spawned = spawnContainedCli({
    bin: input.bin,
    args: [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "dontAsk",
    "--tools", "",
    "--no-session-persistence",
    "/usage",
    ],
    cwd: options.cwd,
    env: runtimeEnvironment(),
    stdin: "ignore",
  });
  const child = spawned.child;
  const handle = runtimeProcessHandle(child, {
    label: "Claude provider usage",
    termGraceMs: input.killGraceMs,
  }, spawned.authority);
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
    if (!child.stdout) throw new ProviderUsageReadError("server_environment_invalid");
    for await (const raw of parseJsonlChunks(boundedOutput(child.stdout as AsyncIterable<Buffer>))) {
      observeClaudeUsage(raw, evidence);
    }
    const terminal = await completed;
    if (timedOut) throw new ProviderUsageReadError("command_timeout", { timedOut: true });
    if (options.signal.aborted) throw new ProviderUsageReadError("provider_temporarily_unavailable");
    if (terminal.error) throw providerFailure(terminal.error, "unknown_failure");
    if (terminal.code !== 0) {
      throw providerFailure(stderrTail, "unknown_failure", {
        ...(terminal.code === null ? {} : { exitCode: terminal.code }),
      });
    }
    if (!evidence.zeroTokenSyntheticMessage || !evidence.zeroTokenResult) {
      throw new ProviderUsageReadError("invalid_provider_response", {
        ...(terminal.code === null ? {} : { exitCode: terminal.code }),
      });
    }
    const text = evidence.result ?? evidence.text;
    if (!text) throw new ProviderUsageReadError("usage_not_supported");
    return {
      provider: "claude",
      windows: parseClaudeUsageText(text),
      source: "provider-command",
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof ProviderUsageReadError) throw error;
    if (timedOut) throw new ProviderUsageReadError("command_timeout", { timedOut: true });
    if (options.signal.aborted) {
      throw new ProviderUsageReadError("provider_temporarily_unavailable");
    }
    throw providerFailure(error, "invalid_provider_response");
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
  const windowCandidates: Array<{
    durationMinutes: number;
    limitId: string;
    positionIndex: number;
    window: ProviderUsageWindow;
  }> = [];
  for (const { limitId, snapshot } of snapshots) {
    const limitName = typeof snapshot.limitName === "string" && snapshot.limitName.trim()
      ? snapshot.limitName.trim()
      : undefined;
    for (const [positionIndex, [position, value]] of [["primary", snapshot.primary], ["secondary", snapshot.secondary]].entries()) {
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
      windowCandidates.push({
        durationMinutes: minutes ?? Number.POSITIVE_INFINITY,
        limitId,
        positionIndex,
        window: {
          id: multipleLimits || position === "secondary" ? `${limitId}:${position}:${id}` : id,
          label: `${limitName ? `${limitName} · ` : ""}${durationLabel(minutes)}`,
          ...(usedPercent !== undefined ? { usedPercent } : {}),
          ...(resetsAt ? { resetsAt } : {}),
        },
      });
    }
  }
  const windows = windowCandidates
    .sort((left, right) => left.durationMinutes - right.durationMinutes ||
      left.limitId.localeCompare(right.limitId) ||
      left.positionIndex - right.positionIndex)
    .map(({ window }) => window);
  if (windows.length === 0) {
    throw new ProviderUsageReadError("invalid_provider_response");
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

function codexAccountIdentity(accountResponse: unknown): ProviderUsageAccountIdentity {
  const account = record(record(accountResponse)?.account);
  const stableIdentity = ["id", "accountId", "userId", "email"]
    .flatMap((key) => {
      const value = account?.[key];
      return typeof value === "string" && value.trim() ? [`${key}:${value.trim()}`] : [];
    })[0];
  if (!stableIdentity) {
    throw new ProviderUsageReadError("invalid_provider_response");
  }
  const email = typeof account?.email === "string" && account.email.trim()
    ? account.email.trim()
    : undefined;
  return {
    fingerprint: createHash("sha256")
      .update(`codex\0${stableIdentity}`, "utf8")
      .digest("hex"),
    ...(email ? { accountLabel: email } : {}),
  };
}

async function withCodexUsageRpc<T>(input: {
  bin: string;
  sandboxMode: string;
  killGraceMs: number;
  options: ProviderUsageReadOptions;
  read(rpc: JsonRpcProcess): Promise<T>;
}): Promise<T> {
  const { options } = input;
  if (options.signal.aborted) throw new ProviderUsageReadError("provider_temporarily_unavailable");
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
    killGraceMs: input.killGraceMs,
    onRuntimeSpawned: options.onRuntimeSpawned,
    onRuntimeRootExit: () => undefined,
    maxOutputBytes: 1_048_576,
  });
  try {
    await rpc.initialize();
    return await input.read(rpc);
  } catch (error) {
    if (timedOut) throw new ProviderUsageReadError("command_timeout", { timedOut: true });
    if (options.signal.aborted) throw new ProviderUsageReadError("provider_temporarily_unavailable");
    throw providerFailure(error, "invalid_provider_response");
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
    controller.abort();
    await rpc.close();
  }
}

export async function readCodexProviderUsageSnapshot(input: {
  bin: string;
  sandboxMode: string;
  killGraceMs: number;
  options: ProviderUsageReadOptions;
}): Promise<ProviderUsageSnapshot> {
  return withCodexUsageRpc({
    ...input,
    read: async (rpc) => {
      const accountBefore = await rpc.request("account/read", { refreshToken: false });
      const identityBefore = codexAccountIdentity(accountBefore);
      input.options.onAccountIdentity?.(identityBefore);
      const limitsResult = await rpc.request("account/rateLimits/read").then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      let accountAfter: unknown;
      let identityAfter: ProviderUsageAccountIdentity;
      try {
        accountAfter = await rpc.request("account/read", { refreshToken: false });
        identityAfter = codexAccountIdentity(accountAfter);
      } catch (error) {
        input.options.onAccountIdentity?.(undefined);
        throw error;
      }
      input.options.onAccountIdentity?.(identityAfter);
      if (identityBefore.fingerprint !== identityAfter.fingerprint) {
        throw new ProviderUsageReadError("provider_temporarily_unavailable");
      }
      if (limitsResult.status === "rejected") throw limitsResult.reason;
      return {
        identity: identityAfter,
        usage: normalizeCodexProviderUsage(accountAfter, limitsResult.value),
      };
    },
  });
}

export async function readCodexProviderUsage(input: {
  bin: string;
  sandboxMode: string;
  killGraceMs: number;
  options: ProviderUsageReadOptions;
}): Promise<ProviderUsage> {
  return (await readCodexProviderUsageSnapshot(input)).usage;
}
