import type { AgentEvent, ProviderErrorCode } from "./events.js";
import type { EngineModelValidationError } from "./adapter.js";

export const PROVIDER_QUOTA_LIMITS = ["five_hour", "weekly", "weekly_model", "extra_usage"] as const;
export type ProviderQuotaLimit = typeof PROVIDER_QUOTA_LIMITS[number];

export const MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS = 240;
export const MAX_PROVIDER_FAILURE_CLASSIFICATION_CHARACTERS = 2_048;

export const PROVIDER_FAILURE_CATEGORIES = [
  "authentication",
  "rate_limit",
  "quota_exhausted",
  "throttled",
  "capacity",
  "context_length",
  "invalid_request",
  "unavailable",
  "unknown",
] as const;

export type ProviderFailureCategory = typeof PROVIDER_FAILURE_CATEGORIES[number];
export type ProviderFailureKind = ProviderFailureCategory;

const PROVIDER_FAILURE_CATEGORY_SET = new Set<string>(PROVIDER_FAILURE_CATEGORIES);

export function normalizeProviderFailureCategory(value: unknown): ProviderFailureCategory {
  return typeof value === "string" && PROVIDER_FAILURE_CATEGORY_SET.has(value)
    ? value as ProviderFailureCategory
    : "unknown";
}

const ENGINE_MODEL_VALIDATION_ERRORS = new Set<EngineModelValidationError>([
  "client_upgrade_required",
  "invalid_request",
  "invalid_model",
  "model_not_found",
  "authentication",
  "rate_limit",
  "quota_exhausted",
  "throttled",
  "capacity",
  "context_length",
  "organization_policy",
  "plan_entitlement",
  "network",
  "provider_error",
]);

export function normalizeEngineModelValidationError(
  value: unknown,
): EngineModelValidationError {
  return typeof value === "string" && ENGINE_MODEL_VALIDATION_ERRORS.has(
    value as EngineModelValidationError,
  )
    ? value as EngineModelValidationError
    : "provider_error";
}

export const PUBLIC_PROVIDER_FAILURE_MESSAGES = {
  authentication: "Provider authentication was rejected.",
  rate_limit: "Provider limited the request.",
  quota_exhausted: "Provider usage limit reached.",
  throttled: "Provider is temporarily limiting requests.",
  capacity: "Provider is temporarily at capacity.",
  context_length: "Provider context limit was reached.",
  invalid_request: "Provider rejected the request.",
  unavailable: "Provider is temporarily unavailable.",
  unknown: "Provider execution failed.",
} as const satisfies Record<ProviderFailureCategory, string>;

export const PUBLIC_PROVIDER_FAILURE_REMEDIATIONS = {
  authentication: "Check the provider subscription and sign-in, then retry.",
  rate_limit: "Wait before retrying; check provider usage information for any reset time.",
  quota_exhausted: "Check provider usage and the reported reset time, then explicitly retry if needed.",
  throttled: "Wait for the scheduled retry or retry explicitly after automatic recovery stops.",
  capacity: "Retry when provider capacity is available.",
  context_length: "Start a new provider session or reduce the request context, then retry.",
  invalid_request: "Review the request settings, then retry.",
  unavailable: "Retry when the provider is available.",
  unknown: "Review the restricted server logs, then retry the provider operation.",
} as const satisfies Record<ProviderFailureCategory, string>;

const PLAN_ENTITLEMENT_SUMMARY = "The provider subscription does not include access to this work.";
const PLAN_ENTITLEMENT_REMEDIATION = "Check your provider subscription and model access, then recheck.";
const ORGANIZATION_POLICY_SUMMARY = "Organization policy blocks provider access.";
const ORGANIZATION_POLICY_REMEDIATION = "Ask your organization administrator to enable provider access, then recheck.";
const CLIENT_UPGRADE_SUMMARY = "The provider CLI needs an update for the selected model.";
const CLIENT_UPGRADE_REMEDIATION = "Update the provider CLI on this host, recheck it, then retry.";
const INVALID_MODEL_SUMMARY = "The selected model is unavailable for this provider. Choose another model, then retry.";
const INVALID_MODEL_REMEDIATION = "Choose a model supported by the signed-in provider account, then retry.";

function organizationPolicyDetail(detail: string): boolean {
  if (detail.length > MAX_PROVIDER_FAILURE_CLASSIFICATION_CHARACTERS) return false;
  const value = detail.trim().toLowerCase();
  return value === ORGANIZATION_POLICY_SUMMARY.toLowerCase()
    || /^your organization has disabled[\x20-\x7e]{0,40}\bclaude code\b/u.test(value);
}

const STRUCTURED_PROVIDER_FAILURE_CODES = new Map<string, ProviderFailureCategory>([
  ["authentication", "authentication"],
  ["auth", "authentication"],
  ["authentication_failed", "authentication"],
  ["unauthorized", "authentication"],
  ["invalid_credentials", "authentication"],
  ["subscription_expired", "authentication"],
  ["subscription_inactive", "authentication"],
  ["plan_entitlement", "authentication"],
  ["rate_limit", "rate_limit"],
  ["usage_limit", "quota_exhausted"],
  ["quota_exhausted", "quota_exhausted"],
  ["usage_limit_reached", "quota_exhausted"],
  ["rate_limit_error", "rate_limit"],
  ["throttled", "throttled"],
  ["capacity", "capacity"],
  ["overloaded_error", "capacity"],
  ["context", "context_length"],
  ["context_length", "context_length"],
  ["context_length_exceeded", "context_length"],
  ["context_window_exceeded", "context_length"],
  ["invalid_request", "invalid_request"],
  ["client_upgrade_required", "invalid_request"],
  ["invalid_model", "invalid_request"],
  ["model_not_found", "invalid_request"],
  ["organization_policy", "invalid_request"],
  ["unavailable", "unavailable"],
  ["network", "unavailable"],
  ["provider_error", "unknown"],
  ["unknown", "unknown"],
]);

export interface PublicProviderFailure {
  category: ProviderFailureCategory;
  summary: string;
  remediation: string;
}

const PUBLIC_PROVIDER_ERROR_CODES = new Set<ProviderErrorCode>([
  "client_upgrade_required",
  "invalid_request",
  "invalid_model",
  "model_not_found",
  "authentication_failed",
  "rate_limit",
  "quota_exhausted",
  "throttled",
  "capacity",
  "context_length",
  "organization_policy",
  "plan_entitlement",
  "network",
  "provider_error",
]);

function publicProviderErrorCode(value: string | undefined): ProviderErrorCode | undefined {
  return value && PUBLIC_PROVIDER_ERROR_CODES.has(value as ProviderErrorCode)
    ? value as ProviderErrorCode
    : undefined;
}

export function publicProviderFailureEvent(event: {
  type: "error";
  message: string;
  code?: string;
  category?: ProviderFailureCategory | string;
  terminalStatus?: Extract<AgentEvent, { type: "error" }>["terminalStatus"];
  httpStatusCode?: number;
  retryAfterMs?: number;
  quotaResetAt?: string;
  quotaLimit?: ProviderQuotaLimit;
}): {
  type: "error";
  message: string;
  code?: ProviderErrorCode;
  category: ProviderFailureCategory;
  remediation: string;
  terminalStatus?: Extract<AgentEvent, { type: "error" }>["terminalStatus"];
  httpStatusCode?: number;
  retryAfterMs?: number;
  quotaResetAt?: string;
  quotaLimit?: ProviderQuotaLimit;
} {
  const failure = publicProviderFailure({
    detail: event.message,
    category: event.category,
    code: event.code,
  });
  const code = publicProviderErrorCode(event.code);
  const resetAt = failure.category === "quota_exhausted" ? providerResetAt(event.quotaResetAt) : undefined;
  return {
    type: "error",
    ...(code ? { code } : {}),
    message: failure.summary,
    ...(resetAt ? { quotaResetAt: resetAt } : {}),
    ...(failure.category === "quota_exhausted" && event.quotaLimit && PROVIDER_QUOTA_LIMITS.includes(event.quotaLimit) ? { quotaLimit: event.quotaLimit } : {}),
    category: failure.category,
    remediation: failure.remediation,
    ...(event.terminalStatus !== undefined ? { terminalStatus: event.terminalStatus } : {}),
    ...(Number.isInteger(event.httpStatusCode) && event.httpStatusCode! >= 100 && event.httpStatusCode! <= 599 ? { httpStatusCode: event.httpStatusCode } : {}),
    ...(Number.isInteger(event.retryAfterMs) && event.retryAfterMs! >= 0 && event.retryAfterMs! <= 86_400_000 ? { retryAfterMs: event.retryAfterMs } : {}),
  };
}

function categoryFromStructuredCode(code: string | undefined): ProviderFailureCategory | undefined {
  if (!code || code.length > 64 || !/^[a-z][a-z0-9_-]*$/u.test(code)) return undefined;
  return STRUCTURED_PROVIDER_FAILURE_CODES.get(code);
}

function highConfidenceTextCategory(detail: string): ProviderFailureCategory {
  if (
    detail.length === 0
    || detail.length > MAX_PROVIDER_FAILURE_CLASSIFICATION_CHARACTERS
  ) return "unknown";
  // Only the exact ASCII policy prefix is evidence; the CLI's Unicode suffix
  // is ignored and never included in a public message.
  if (organizationPolicyDetail(detail)) return "invalid_request";
  if (detail === PLAN_ENTITLEMENT_SUMMARY) return "authentication";
  if (/[^\x09\x0a\x0d\x20-\x7e]/u.test(detail)) return "unknown";
  const value = detail.trim().toLowerCase();
  if (value === CLIENT_UPGRADE_SUMMARY.toLowerCase() || value === INVALID_MODEL_SUMMARY.toLowerCase()) return "invalid_request";
  if (!value || /^(?:\{|\[|")|\\u[0-9a-f]{4}|%[0-9a-f]{2}/iu.test(value)) return "unknown";
  if (/^[a-z0-9+/_-]{16,}={0,2}$/iu.test(value)) return "unknown";

  const ownedCategory = (Object.entries(PUBLIC_PROVIDER_FAILURE_MESSAGES) as Array<
    [ProviderFailureCategory, string]
  >).find(([, message]) => message.toLowerCase() === value)?.[0];
  if (ownedCategory) return ownedCategory;

  if (/\b(?:subscription (?:expired|inactive)|oauth session expired|failed to authenticate|unauthori[sz]ed|authentication (?:failed|rejected|required)|not authenticated|sign[- ]?in required|invalid credentials?)\b/u.test(value)) {
    return "authentication";
  }
  if (/\b(?:0 weighted tokens left|usage limit (?:was )?reached|quota (?:exhausted|reached)|you(?: have|'ve) hit your (?:usage )?limit)\b/u.test(value)) return "quota_exhausted";
  if (/\b(?:temporary throttl(?:e|ing)|temporarily (?:throttl(?:ed|ing)|limiting requests))\b/u.test(value)) return "throttled";
  if (/\b(?:rate limit(?:ed)?|too many requests|http 429)\b/u.test(value)) {
    return "rate_limit";
  }
  if (/\b(?:selected model is at capacity|provider is at capacity|service overloaded|resource exhausted)\b/u.test(value)) {
    return "capacity";
  }
  if (/\b(?:context window exceeded|maximum context length|context length exceeded|too many input tokens|pre-sampling compact)\b/u.test(value)) {
    return "context_length";
  }
  if (/\b(?:service unavailable|provider unavailable|temporarily unavailable|connection reset by peer|connection refused|request timed out|deadline exceeded)\b/u.test(value)) {
    return "unavailable";
  }
  return "unknown";
}

/** Structured adapter categories/codes win; provider prose is only a bounded hint. */
export function classifyProviderFailure(
  detail: string,
  structuredCategoryOrCode?: ProviderFailureCategory | string,
): ProviderFailureCategory {
  const structured = categoryFromStructuredCode(structuredCategoryOrCode);
  return structured && structured !== "unknown"
    ? structured
    : highConfidenceTextCategory(detail);
}

export function publicProviderFailure(input: {
  detail?: string;
  category?: ProviderFailureCategory | string;
  code?: string;
}): PublicProviderFailure {
  const explicitCategory = categoryFromStructuredCode(input.category);
  const structuredCode = categoryFromStructuredCode(input.code);
  const category = (explicitCategory && explicitCategory !== "unknown" ? explicitCategory : undefined)
    ?? (structuredCode && structuredCode !== "unknown" ? structuredCode : undefined)
    ?? explicitCategory
    ?? structuredCode
    ?? highConfidenceTextCategory(input.detail ?? "");
  return {
    category,
    ...(category === "authentication" && (input.code === "plan_entitlement" || input.detail === PLAN_ENTITLEMENT_SUMMARY)
      ? { summary: PLAN_ENTITLEMENT_SUMMARY, remediation: PLAN_ENTITLEMENT_REMEDIATION }
      : category === "invalid_request" && (input.code === "client_upgrade_required" || input.detail === CLIENT_UPGRADE_SUMMARY)
      ? { summary: CLIENT_UPGRADE_SUMMARY, remediation: CLIENT_UPGRADE_REMEDIATION }
      : category === "invalid_request" && (input.code === "invalid_model" || input.code === "model_not_found" || input.detail === INVALID_MODEL_SUMMARY)
      ? { summary: INVALID_MODEL_SUMMARY, remediation: INVALID_MODEL_REMEDIATION }
      : category === "invalid_request" && (input.code === "organization_policy"
      || input.category === "organization_policy" || organizationPolicyDetail(input.detail ?? ""))
      ? { summary: ORGANIZATION_POLICY_SUMMARY, remediation: ORGANIZATION_POLICY_REMEDIATION }
      : { summary: PUBLIC_PROVIDER_FAILURE_MESSAGES[category], remediation: PUBLIC_PROVIDER_FAILURE_REMEDIATIONS[category] }),
  };
}

/** Only structured provider timestamps; never parse reset times from prose or retry delays. */
export function providerResetAt(value: unknown): string | undefined {
  const iso = typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(value) ? value : undefined;
  const timestamp = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value * 1000 : iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 253402300799999) return undefined;
  const normalized = new Date(timestamp).toISOString();
  return iso && normalized.slice(0,19) !== iso.slice(0,19) ? undefined : normalized;
}

/** One bounded policy for delivery and required-reply recovery. The count
 * includes the just-ended attempt; an operator retry starts a new lineage. */
export const MAX_PROVIDER_RECOVERY_ATTEMPTS = 6;
export function providerRecoveryDelay(
  category: ProviderFailureCategory | undefined,
  attempts: number,
  retryable = true,
  retryAfterMs = 0,
  quotaResetAt?: string,
  now = Date.now(),
): number | null {
  if (!Number.isSafeInteger(attempts) || attempts < 0 || !retryable || attempts >= MAX_PROVIDER_RECOVERY_ATTEMPTS ||
      category === "authentication" || category === "invalid_request" || category === "context_length") return null;
  if (category === "quota_exhausted") {
    const reset = providerResetAt(quotaResetAt);
    return reset && Date.parse(reset) > now ? Date.parse(reset) - now : null;
  }
  const backoff = category === "rate_limit" || category === "throttled" || category === "capacity" || category === "unavailable"
    ? Math.min(120_000, 2_000 * 2 ** Math.min(Math.max(0, attempts - 1), 6))
    : 1_000;
  const delay = Math.round(backoff * (1 + Math.random() * 0.2));
  return Math.max(delay, Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 ? Math.min(retryAfterMs, 86_400_000) : 0);
}

/** Returns only a finite, code-owned message; provider prose is never echoed. */
export function publicProviderFailureSummary(
  detail: string | undefined,
  category?: ProviderFailureCategory | string,
): string | undefined {
  if (detail === undefined && category === undefined) return undefined;
  return publicProviderFailure({ detail, category }).summary;
}

export function publicProviderFailureCategorySummary(
  detail: string | undefined,
  category?: ProviderFailureCategory | string,
): string | undefined {
  return publicProviderFailureSummary(detail, category);
}

export function publicProviderFailureRemediation(
  detail: string | undefined,
  category?: ProviderFailureCategory | string,
): string | undefined {
  if (detail === undefined && category === undefined) return undefined;
  return publicProviderFailure({ detail, category }).remediation;
}
