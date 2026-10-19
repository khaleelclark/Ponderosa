import type { AgentEvent, ProviderErrorCode } from "./events.js";
import type { EngineModelValidationError } from "./adapter.js";

export const MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS = 240;
export const MAX_PROVIDER_FAILURE_CLASSIFICATION_CHARACTERS = 2_048;

export const PROVIDER_FAILURE_CATEGORIES = [
  "authentication",
  "rate_limit",
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
  "invalid_model",
  "model_not_found",
  "authentication",
  "rate_limit",
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
  capacity: "Provider is temporarily at capacity.",
  context_length: "Provider context limit was reached.",
  invalid_request: "Provider rejected the request.",
  unavailable: "Provider is temporarily unavailable.",
  unknown: "Provider execution failed.",
} as const satisfies Record<ProviderFailureCategory, string>;

export const PUBLIC_PROVIDER_FAILURE_REMEDIATIONS = {
  authentication: "Check the provider subscription and sign-in, then retry.",
  rate_limit: "Wait before retrying; check provider usage information for any reset time.",
  capacity: "Retry when provider capacity is available.",
  context_length: "Start a new provider session or reduce the request context, then retry.",
  invalid_request: "Review the request settings, then retry.",
  unavailable: "Retry when the provider is available.",
  unknown: "Review the restricted server logs, then retry the provider operation.",
} as const satisfies Record<ProviderFailureCategory, string>;

const ORGANIZATION_POLICY_SUMMARY = "Organization policy blocks provider access.";
const ORGANIZATION_POLICY_REMEDIATION = "Ask your organization administrator to enable provider access, then recheck.";

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
  ["usage_limit", "rate_limit"],
  ["quota_exhausted", "rate_limit"],
  ["rate_limit_error", "rate_limit"],
  ["capacity", "capacity"],
  ["overloaded_error", "capacity"],
  ["context", "context_length"],
  ["context_length", "context_length"],
  ["context_length_exceeded", "context_length"],
  ["context_window_exceeded", "context_length"],
  ["invalid_request", "invalid_request"],
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
  "invalid_model",
  "model_not_found",
  "authentication_failed",
  "rate_limit",
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
}): {
  type: "error";
  message: string;
  code?: ProviderErrorCode;
  category: ProviderFailureCategory;
  remediation: string;
  terminalStatus?: Extract<AgentEvent, { type: "error" }>["terminalStatus"];
} {
  const failure = publicProviderFailure({
    detail: event.message,
    category: event.category,
    code: event.code,
  });
  const code = publicProviderErrorCode(event.code);
  return {
    type: "error",
    ...(code ? { code } : {}),
    message: failure.summary,
    category: failure.category,
    remediation: failure.remediation,
    ...(event.terminalStatus !== undefined ? { terminalStatus: event.terminalStatus } : {}),
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
  if (/[^\x09\x0a\x0d\x20-\x7e]/u.test(detail)) return "unknown";
  const value = detail.trim().toLowerCase();
  if (!value || /^(?:\{|\[|")|\\u[0-9a-f]{4}|%[0-9a-f]{2}/iu.test(value)) return "unknown";
  if (/^[a-z0-9+/_-]{16,}={0,2}$/iu.test(value)) return "unknown";

  const ownedCategory = (Object.entries(PUBLIC_PROVIDER_FAILURE_MESSAGES) as Array<
    [ProviderFailureCategory, string]
  >).find(([, message]) => message.toLowerCase() === value)?.[0];
  if (ownedCategory) return ownedCategory;

  if (/\b(?:subscription (?:expired|inactive)|oauth session expired|failed to authenticate|unauthori[sz]ed|authentication (?:failed|rejected|required)|not authenticated|sign[- ]?in required|invalid credentials?)\b/u.test(value)) {
    return "authentication";
  }
  if (/\b(?:0 weighted tokens left|rate limit(?:ed)?|too many requests|usage limit (?:was )?reached|quota (?:exhausted|reached)|http 429)\b/u.test(value)) {
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
    ...(category === "invalid_request" && (input.code === "organization_policy"
      || input.category === "organization_policy" || organizationPolicyDetail(input.detail ?? ""))
      ? { summary: ORGANIZATION_POLICY_SUMMARY, remediation: ORGANIZATION_POLICY_REMEDIATION }
      : { summary: PUBLIC_PROVIDER_FAILURE_MESSAGES[category], remediation: PUBLIC_PROVIDER_FAILURE_REMEDIATIONS[category] }),
  };
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
