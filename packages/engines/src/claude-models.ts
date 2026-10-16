import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  classifyProviderFailure,
} from "@ponderosa/core";
import type {
  EngineModelDiscoveryOptions,
  EngineModelOption,
  EngineModelValidationError,
  EngineModelValidationResult,
  ProviderErrorCode,
  RuntimeProcessHandle,
} from "@ponderosa/core";
import { spawnContainedCli } from "./contained-spawn.js";
import { parseJsonlChunks } from "./jsonl.js";
import { runtimeProcessHandle } from "./process-termination.js";
import type { NativeProcessTreeAuthority } from "./process-termination.js";
import { runtimeEnvironment } from "./runtime-environment.js";

interface ClaudeModelCatalogProbeOptions {
  bin: string;
  environment?: Readonly<Record<string, string | undefined>>;
  killGraceMs: number;
}

interface RawClaudeModelInfo {
  value?: unknown;
  resolvedModel?: unknown;
  displayName?: unknown;
  description?: unknown;
  supportedEffortLevels?: unknown;
}

interface RawClaudeRecord {
  type?: unknown;
  subtype?: unknown;
  model?: unknown;
  claude_code_version?: unknown;
  error?: unknown;
  error_status?: unknown;
  is_error?: unknown;
  result?: unknown;
  errors?: unknown;
  response?: {
    subtype?: unknown;
    request_id?: unknown;
    error?: unknown;
    response?: { models?: unknown };
  };
}

const PROBE_TIMEOUT_MS = 20_000;
const VERSION_TIMEOUT_MS = 10_000;
const VALIDATION_TIMEOUT_MS = 45_000;

function environmentFor(
  configured: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv {
  return runtimeEnvironment({
    ...configured,
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  });
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

/** Humanize provider wire ids without maintaining a model registry. */
export function claudeModelDisplayName(id: string): string {
  const suffix = id.endsWith("[1m]") ? " [1m]" : "";
  const base = suffix ? id.slice(0, -4) : id;
  const parts = base.replace(/^claude-/u, "").split("-").filter(Boolean);
  if (parts.length === 0) return id;
  const family = capitalize(parts.shift()!);
  const date = parts.at(-1)?.match(/^(\d{4})(\d{2})(\d{2})$/u);
  if (date) parts.pop();
  let version = "";
  if (parts.length > 0) {
    const numeric = parts.every((part) => /^\d+$/u.test(part));
    version = numeric ? parts.join(".") : parts.join(" ");
  }
  return [
    family,
    version,
    date ? `· ${date[1]}-${date[2]}-${date[3]}` : "",
  ].filter(Boolean).join(" ") + suffix;
}

export function normalizeClaudeProviderModels(input: unknown): EngineModelOption[] {
  if (!Array.isArray(input)) throw new Error("Claude initialization did not return a model list");
  const aliases: EngineModelOption[] = [];
  const exact = new Map<string, EngineModelOption>();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as RawClaudeModelInfo;
    const id = typeof raw.value === "string" ? raw.value.trim() : "";
    if (!id) continue;
    const resolvedModel = typeof raw.resolvedModel === "string" && raw.resolvedModel.trim()
      ? raw.resolvedModel.trim()
      : undefined;
    const displayName = typeof raw.displayName === "string" && raw.displayName.trim()
      ? raw.displayName.trim()
      : claudeModelDisplayName(id);
    const description = typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : undefined;
    const supportedEffortLevels = Array.isArray(raw.supportedEffortLevels)
      ? raw.supportedEffortLevels.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      : undefined;
    const common = {
      ...(description ? { description } : {}),
      ...(supportedEffortLevels?.length ? { supportedEffortLevels } : {}),
      source: "provider-probe" as const,
      availability: "available" as const,
    };
    if (!id.startsWith("claude-")) {
      aliases.push({
        id,
        ...(resolvedModel ? { resolvedModel } : {}),
        label: displayName,
        kind: "alias",
        ...common,
      });
      if (resolvedModel && !exact.has(resolvedModel)) {
        exact.set(resolvedModel, {
          id: resolvedModel,
          resolvedModel,
          label: claudeModelDisplayName(resolvedModel),
          kind: "exact",
          ...common,
        });
      }
      continue;
    }
    exact.set(id, {
      id,
      ...(resolvedModel ? { resolvedModel } : {}),
      label: claudeModelDisplayName(id),
      kind: "exact",
      ...common,
    });
  }
  if (aliases.length === 0 && exact.size === 0) {
    throw new Error("Claude initialization returned an empty model list");
  }
  return [...aliases, ...exact.values()];
}

export function claudeProviderErrorCode(rawCode: unknown, detail = ""): ProviderErrorCode | undefined {
  const code = typeof rawCode === "string" ? rawCode : "";
  const combined = `${code} ${detail}`;
  const structuredProviderCategory = code
    ? classifyProviderFailure("", code)
    : "unknown";
  if (structuredProviderCategory === "authentication") return "authentication_failed";
  if (structuredProviderCategory === "rate_limit") return "rate_limit";
  if (structuredProviderCategory === "capacity") return "capacity";
  if (structuredProviderCategory === "context_length") return "context_length";
  if (structuredProviderCategory === "unavailable") return "network";
  if (/oauth_org_not_allowed|availableModels|organization.*(?:policy|allow|disabled)|managed policy/iu.test(combined)) {
    return "organization_policy";
  }
  if (/billing_error|plan entitlement|subscription.*(?:does not|doesn't|unavailable)|upgrade.*plan/iu.test(combined)) {
    return "plan_entitlement";
  }
  if (/authentication_failed|expired.*oauth|unauthori[sz]ed|sign.?in required/iu.test(combined)) {
    return "authentication_failed";
  }
  const providerCategory = classifyProviderFailure(detail);
  if (providerCategory === "rate_limit") return "rate_limit";
  if (providerCategory === "capacity") return "capacity";
  if (providerCategory === "context_length") return "context_length";
  if (/invalid_model|\b400\b.*model/iu.test(combined)) return "invalid_model";
  if (/model_not_found|\b404\b.*model/iu.test(combined)) return "model_not_found";
  if (/network|ECONN|ENOTFOUND|ETIMEDOUT|socket|fetch failed/iu.test(combined)) return "network";
  if (code || detail) return "provider_error";
}

function validationErrorCode(code: ProviderErrorCode | undefined): EngineModelValidationError {
  if (code === "authentication_failed") return "authentication";
  return code ?? "provider_error";
}

function validationError(
  modelId: string,
  code: ProviderErrorCode | undefined,
  detail: string,
): EngineModelValidationResult {
  const errorCode = validationErrorCode(code);
  const error = (() => {
    switch (errorCode) {
      case "invalid_model":
        return `Claude rejected "${modelId}" as an invalid model ID. Check the exact version ID and try again.`;
      case "model_not_found":
        return `Claude could not find "${modelId}". The model may not exist or may no longer be available to this account.`;
      case "authentication":
        return "Claude authentication has expired. Sign in with Claude Code, then retry validation.";
      case "rate_limit":
        return "Claude usage limit was reached. Wait for the limit to reset, then retry validation.";
      case "capacity":
        return "Claude is temporarily at capacity. Retry validation when capacity is available.";
      case "context_length":
        return "Claude rejected the validation request because its context limit was reached.";
      case "organization_policy":
        return `Your organization policy does not allow "${modelId}". Check Claude's availableModels policy with your administrator.`;
      case "plan_entitlement":
        return `Your current Claude plan is not entitled to "${modelId}". Choose an included model or update the plan.`;
      case "network":
        return "Claude model validation could not reach the provider. Check the network connection and retry.";
      default:
        return detail.trim()
          ? `Claude could not validate "${modelId}": ${detail.trim()}`
          : `Claude could not validate "${modelId}".`;
    }
  })();
  return { valid: false, errorCode, error };
}

function registerProcess(
  child: ChildProcess,
  label: string,
  killGraceMs: number,
  context: EngineModelDiscoveryOptions,
  authority?: NativeProcessTreeAuthority,
): RuntimeProcessHandle {
  const handle = runtimeProcessHandle(child, { label, termGraceMs: killGraceMs }, authority);
  context.onRuntimeSpawned(handle);
  return handle;
}

async function closeAfter<T>(
  operation: () => Promise<T>,
  handle: RuntimeProcessHandle,
): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Claude model helper and cleanup failed");
    }
    throw error;
  }
  await handle.close();
  return result;
}

function observeChildErrors(
  child: ChildProcess,
  label: string,
): Promise<never> {
  let onError: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    onError = (error) => reject(new Error(`${label} failed to start: ${error.message}`, {
      cause: error,
    }));
    // Keep this listener installed through process-handle teardown. Node can
    // report a spawn failure before close(), and removing the sole listener
    // while cleanup is still observing the failed child would re-open the
    // daemon-crashing unhandled-error window.
    child.on("error", onError);
    child.once("close", () => child.off("error", onError));
  });
  return failure;
}

function observeTerminationRequest(
  handle: RuntimeProcessHandle,
  context: EngineModelDiscoveryOptions,
  timeoutMs: number,
  timeoutMessage: string,
): { failure: Promise<never>; dispose: () => void } {
  let rejectFailure: (reason?: unknown) => void;
  let requested = false;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const terminate = (reason: Error): void => {
    if (requested) return;
    requested = true;
    void handle.close().then(
      () => rejectFailure(reason),
      (closeError) => rejectFailure(new AggregateError(
        [reason, closeError],
        "Claude model helper and cleanup failed",
      )),
    );
  };
  const timeout = setTimeout(() => terminate(new Error(timeoutMessage)), timeoutMs);
  const abort = () => terminate(
    context.signal.reason instanceof Error
      ? context.signal.reason
      : new Error("Claude model discovery was cancelled"),
  );
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) abort();
  return {
    failure,
    dispose: () => {
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", abort);
    },
  };
}

export class ClaudeModelCatalogProbe {
  constructor(private readonly options: ClaudeModelCatalogProbeOptions) {}

  async discover(
    cwd: string,
    context: EngineModelDiscoveryOptions,
  ): Promise<{ models: EngineModelOption[]; cliVersion: string }> {
    const controller = new AbortController();
    const abortFromCaller = () => {
      if (!controller.signal.aborted) {
        controller.abort(context.signal.reason ?? new Error("Claude model discovery was cancelled"));
      }
    };
    if (context.signal.aborted) abortFromCaller();
    else context.signal.addEventListener("abort", abortFromCaller, { once: true });
    const branchContext: EngineModelDiscoveryOptions = {
      signal: controller.signal,
      onRuntimeSpawned: context.onRuntimeSpawned,
    };
    const cancelSiblingOnFailure = async <T>(operation: Promise<T>): Promise<T> => {
      try {
        return await operation;
      } catch (error) {
        if (!controller.signal.aborted) controller.abort(error);
        throw error;
      }
    };
    try {
      const results = await Promise.allSettled([
        cancelSiblingOnFailure(this.initializationModels(cwd, branchContext)),
        cancelSiblingOnFailure(this.cliVersion(cwd, branchContext)),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Claude model discovery helpers failed");
      }
      if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled") {
        throw new Error("Claude model discovery helpers did not produce results");
      }
      return {
        models: results[0].value,
        cliVersion: results[1].value,
      };
    } finally {
      context.signal.removeEventListener("abort", abortFromCaller);
    }
  }

  async validate(
    cwd: string,
    modelId: string,
    context: EngineModelDiscoveryOptions,
  ): Promise<EngineModelValidationResult> {
    const spawned = spawnContainedCli({
      bin: this.options.bin,
      args: [
      "-p",
      ".",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "dontAsk",
      "--tools", "",
      "--no-session-persistence",
      "--max-turns", "1",
      "--model", modelId,
      ],
      cwd,
      env: environmentFor(this.options.environment),
      stdin: "ignore",
    });
    const child = spawned.child;
    const childErrors = observeChildErrors(child, "Claude model validation");
    const handle = registerProcess(
      child,
      "Claude model validation",
      this.options.killGraceMs,
      context,
      spawned.authority,
    );
    return closeAfter(() => Promise.race([(async () => {
        const stdout = child.stdout;
        if (!stdout) return validationError(modelId, "provider_error", "Claude validation stdout is unavailable");
        let stderr = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8_192); });
        let initModel: string | undefined;
        let observedCode: ProviderErrorCode | undefined;
        let observedDetail = "";
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          void handle.close().catch(() => undefined);
        }, VALIDATION_TIMEOUT_MS);
        const abort = () => { void handle.close().catch(() => undefined); };
        context.signal.addEventListener("abort", abort, { once: true });
        try {
          for await (const value of parseJsonlChunks(stdout as AsyncIterable<Buffer>)) {
            const raw = value as RawClaudeRecord;
            if (raw.type === "system" && raw.subtype === "init" && typeof raw.model === "string") {
              initModel = raw.model.trim() || undefined;
            }
            if (raw.type === "assistant" && raw.error) {
              observedCode = claudeProviderErrorCode(raw.error, observedDetail);
            }
            if (raw.type === "system" && raw.subtype === "api_retry") {
              observedCode = claudeProviderErrorCode(raw.error, String(raw.error_status ?? ""));
            }
            if (raw.type !== "result") continue;
            const details = [
              typeof raw.result === "string" ? raw.result : "",
              ...(Array.isArray(raw.errors) ? raw.errors.filter((item): item is string => typeof item === "string") : []),
              stderr,
            ].filter(Boolean).join(" ");
            observedDetail = details;
            observedCode = claudeProviderErrorCode(observedCode, details) ?? observedCode;
            if (raw.is_error === true || raw.subtype !== "success") {
              return validationError(modelId, observedCode, details);
            }
            const label = initModel && !initModel.startsWith("claude-")
              ? initModel
              : claudeModelDisplayName(modelId);
            return {
              valid: true as const,
              model: {
                id: modelId,
                resolvedModel: modelId.endsWith("[1m]") ? modelId.slice(0, -4) : modelId,
                label,
                kind: "exact" as const,
                source: "operator" as const,
                validatedAt: new Date().toISOString(),
                availability: "available" as const,
              },
            };
          }
          if (context.signal.aborted) throw context.signal.reason ?? new Error("Claude model validation was cancelled");
          if (timedOut) return validationError(modelId, "network", "Claude model validation timed out");
          return validationError(modelId, observedCode, observedDetail || stderr || "Claude ended before returning a validation result");
        } finally {
          clearTimeout(timeout);
          context.signal.removeEventListener("abort", abort);
        }
      })(), childErrors]), handle);
  }

  private async initializationModels(
    cwd: string,
    context: EngineModelDiscoveryOptions,
  ): Promise<EngineModelOption[]> {
    const spawned = spawnContainedCli({
      bin: this.options.bin,
      args: [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--tools", "",
      ],
      cwd,
      env: environmentFor(this.options.environment),
      stdin: "pipe",
    });
    const child = spawned.child;
    const childErrors = observeChildErrors(child, "Claude model catalog probe");
    const handle = registerProcess(
      child,
      "Claude model catalog probe",
      this.options.killGraceMs,
      context,
      spawned.authority,
    );
    const termination = observeTerminationRequest(
      handle,
      context,
      PROBE_TIMEOUT_MS,
      "Claude model catalog probe timed out",
    );
    try {
      return await closeAfter(() => Promise.race([(async () => {
        const stdout = child.stdout;
        if (!stdout || !child.stdin) throw new Error("Claude model catalog transport is unavailable");
        let stderr = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8_192); });
        child.stdin.on("error", () => undefined);
        const requestId = `ponderosa-models-${randomUUID()}`;
        child.stdin.write(`${JSON.stringify({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "initialize", hooks: {}, sdkMcpServers: [] },
        })}\n`);
        for await (const value of parseJsonlChunks(stdout as AsyncIterable<Buffer>)) {
          const raw = value as RawClaudeRecord;
          const response = raw.type === "control_response" ? raw.response : undefined;
          if (response?.request_id !== requestId) continue;
          if (response.subtype !== "success") {
            throw new Error(typeof response.error === "string" ? response.error : "Claude model catalog probe failed");
          }
          return normalizeClaudeProviderModels(response.response?.models);
        }
        if (context.signal.aborted) throw context.signal.reason ?? new Error("Claude model catalog probe was cancelled");
        throw new Error(`Claude model catalog probe ended without a response${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      })(), childErrors, termination.failure]), handle);
    } finally {
      termination.dispose();
    }
  }

  private async cliVersion(
    cwd: string,
    context: EngineModelDiscoveryOptions,
  ): Promise<string> {
    const spawned = spawnContainedCli({
      bin: this.options.bin,
      args: ["--version"],
      cwd,
      env: environmentFor(this.options.environment),
      stdin: "ignore",
    });
    const child = spawned.child;
    const childErrors = observeChildErrors(child, "Claude version check");
    const handle = registerProcess(
      child,
      "Claude version check",
      this.options.killGraceMs,
      context,
      spawned.authority,
    );
    const termination = observeTerminationRequest(
      handle,
      context,
      VERSION_TIMEOUT_MS,
      "Claude version check timed out",
    );
    try {
      return await closeAfter(async () => {
        let output = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => { output = (output + chunk).slice(-4_096); });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4_096); });
        return Promise.race([
          new Promise<string>((resolve, reject) => {
            child.once("exit", (code) => {
              if (context.signal.aborted) {
                reject(context.signal.reason ?? new Error("Claude version check was cancelled"));
              } else if (code === 0 && output.trim()) {
                resolve(output.trim());
              } else {
                reject(new Error(
                  `Claude version check failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
                ));
              }
            });
          }),
          childErrors,
          termination.failure,
        ]);
      }, handle);
    } finally {
      termination.dispose();
    }
  }
}
