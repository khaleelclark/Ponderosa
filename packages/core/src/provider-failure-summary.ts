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

export const PUBLIC_PROVIDER_FAILURE_MESSAGES = {
  authentication: "Provider authentication was rejected.",
  rate_limit: "Provider usage limit was reached.",
  capacity: "Provider is temporarily at capacity.",
  context_length: "Provider context limit was reached.",
  invalid_request: "Provider rejected the request.",
  unavailable: "Provider is temporarily unavailable.",
  unknown: "Provider execution failed.",
} as const satisfies Record<ProviderFailureCategory, string>;

export const PUBLIC_PROVIDER_FAILURE_REMEDIATIONS = {
  authentication: "Check the provider subscription and sign-in, then retry.",
  rate_limit: "Wait for the provider usage limit to reset, then retry.",
  capacity: "Retry when provider capacity is available.",
  context_length: "Start a new provider session or reduce the request context, then retry.",
  invalid_request: "Review the request settings, then retry.",
  unavailable: "Retry when the provider is available.",
  unknown: "Review the restricted server logs, then retry the provider operation.",
} as const satisfies Record<ProviderFailureCategory, string>;

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
  ["capacity", "capacity"],
  ["context", "context_length"],
  ["context_length", "context_length"],
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

function categoryFromStructuredCode(code: string | undefined): ProviderFailureCategory | undefined {
  if (!code || code.length > 64 || !/^[a-z][a-z0-9_-]*$/u.test(code)) return undefined;
  return STRUCTURED_PROVIDER_FAILURE_CODES.get(code);
}

function highConfidenceTextCategory(detail: string): ProviderFailureCategory {
  if (
    detail.length === 0
    || detail.length > MAX_PROVIDER_FAILURE_CLASSIFICATION_CHARACTERS
    || /[^\x09\x0a\x0d\x20-\x7e]/u.test(detail)
  ) return "unknown";
  const value = detail.trim().toLowerCase();
  if (!value || /^(?:\{|\[|")|\\u[0-9a-f]{4}|%[0-9a-f]{2}/iu.test(value)) return "unknown";
  if (/^[a-z0-9+/_-]{16,}={0,2}$/iu.test(value)) return "unknown";

  const ownedCategory = (Object.entries(PUBLIC_PROVIDER_FAILURE_MESSAGES) as Array<
    [ProviderFailureCategory, string]
  >).find(([, message]) => message.toLowerCase() === value)?.[0];
  if (ownedCategory) return ownedCategory;

  if (/\b(?:subscription (?:expired|inactive)|unauthori[sz]ed|authentication (?:failed|rejected|required)|not authenticated|sign[- ]?in required|invalid credentials?)\b/u.test(value)) {
    return "authentication";
  }
  if (/\b(?:0 weighted tokens left|rate limit(?:ed)?|too many requests|usage limit reached|quota (?:exhausted|reached)|http 429)\b/u.test(value)) {
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
  return categoryFromStructuredCode(structuredCategoryOrCode)
    ?? highConfidenceTextCategory(detail);
}

export function publicProviderFailure(input: {
  detail?: string;
  category?: ProviderFailureCategory | string;
  code?: string;
}): PublicProviderFailure {
  const category = categoryFromStructuredCode(input.category)
    ?? categoryFromStructuredCode(input.code)
    ?? highConfidenceTextCategory(input.detail ?? "");
  return {
    category,
    summary: PUBLIC_PROVIDER_FAILURE_MESSAGES[category],
    remediation: PUBLIC_PROVIDER_FAILURE_REMEDIATIONS[category],
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
