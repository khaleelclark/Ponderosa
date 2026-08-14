export const MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS = 240;

const MAX_PROVIDER_FAILURE_INPUT_CHARACTERS = 64 * 1024;
const MAX_PROVIDER_FAILURE_DEPTH = 6;
const MAX_PROVIDER_FAILURE_ARRAY_ITEMS = 16;
const MAX_PROVIDER_FAILURE_NORMALIZATION_PASSES = 8;
const MAX_ENCODED_PROVIDER_CHARACTERS = 8 * 1024;
const MAX_ENCODED_PROVIDER_CANDIDATES = 16;
const HUMAN_FAILURE_KEYS = ["message", "detail", "reason", "error"] as const;

function normalizedProviderPass(value: string): string | undefined {
  let invalidEncoding = false;
  const collapsedEscapes = value.replace(
    /\\{2,}(?=(?:u[0-9a-f]{4}|x[0-9a-f]{2}))/giu,
    "\\",
  );
  const decodedSurrogates = collapsedEscapes.replace(
    /\\u(d[89ab][0-9a-f]{2})\\u(d[cdef][0-9a-f]{2})/giu,
    (_escape, high: string, low: string) => String.fromCodePoint(
      ((Number.parseInt(high, 16) - 0xd800) * 0x400)
        + Number.parseInt(low, 16) - 0xdc00 + 0x10000,
    ),
  );
  const decodedEscapes = decodedSurrogates.replace(
    /\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/giu,
    (escape, unicode: string | undefined, hex: string | undefined) => {
      const codePoint = Number.parseInt(unicode ?? hex ?? "", 16);
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        invalidEncoding = true;
        return escape;
      }
      return String.fromCodePoint(codePoint);
    },
  );
  const decodedPercentSurrogates = decodedEscapes.replace(
    /%u(d[89ab][0-9a-f]{2})%u(d[cdef][0-9a-f]{2})/giu,
    (_escape, high: string, low: string) => String.fromCodePoint(
      ((Number.parseInt(high, 16) - 0xd800) * 0x400)
        + Number.parseInt(low, 16) - 0xdc00 + 0x10000,
    ),
  );
  const decodedPercentUnicode = decodedPercentSurrogates.replace(
    /%u([0-9a-f]{4})/giu,
    (escape, unicode: string) => {
      const codePoint = Number.parseInt(unicode, 16);
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        invalidEncoding = true;
        return escape;
      }
      return String.fromCodePoint(codePoint);
    },
  );
  const decodedPercent = decodedPercentUnicode.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      invalidEncoding = true;
      return encoded;
    }
  });
  if (invalidEncoding) return undefined;
  const normalized = decodedPercent
    .normalize("NFKC")
    .replace(/\p{Cf}|\p{Variation_Selector}/gu, "")
    .replace(/\\\//gu, "/")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length <= MAX_PROVIDER_FAILURE_INPUT_CHARACTERS
    && new TextEncoder().encode(normalized).byteLength <= MAX_PROVIDER_FAILURE_INPUT_CHARACTERS
    ? normalized
    : undefined;
}

function normalizeProviderText(value: string): string | undefined {
  if (value.length > MAX_PROVIDER_FAILURE_INPUT_CHARACTERS
      || new TextEncoder().encode(value).byteLength > MAX_PROVIDER_FAILURE_INPUT_CHARACTERS) {
    return undefined;
  }
  let normalized = value;
  for (let pass = 0; pass < MAX_PROVIDER_FAILURE_NORMALIZATION_PASSES; pass += 1) {
    const decoded = normalizedProviderPass(normalized);
    if (decoded === undefined) return undefined;
    if (decoded === normalized) return decoded;
    normalized = decoded;
  }
  const convergenceCheck = normalizedProviderPass(normalized);
  return convergenceCheck === normalized ? normalized : undefined;
}

const PROVIDER_CONFUSABLE_ASCII = new Map<string, string>([
  ...["Α", "А", "α", "а"].map((value) => [value, "a"] as const),
  ...["Β", "В", "β", "Ь", "ь"].map((value) => [value, "b"] as const),
  ...["Ϲ", "С", "ϲ", "с"].map((value) => [value, "c"] as const),
  ...["ԁ", "ժ"].map((value) => [value, "d"] as const),
  ...["Ε", "Е", "ε", "е", "ϵ"].map((value) => [value, "e"] as const),
  ...["Ϝ", "Ғ", "ғ"].map((value) => [value, "f"] as const),
  ...["Ԍ", "ԍ"].map((value) => [value, "g"] as const),
  ...["Η", "Н", "һ"].map((value) => [value, "h"] as const),
  ...["Ι", "І", "Ӏ", "і"].map((value) => [value, "i"] as const),
  ...["Ј", "ј"].map((value) => [value, "j"] as const),
  ...["Κ", "К", "κ", "к"].map((value) => [value, "k"] as const),
  ...["ᒪ", "ӏ"].map((value) => [value, "l"] as const),
  ...["Μ", "М", "м"].map((value) => [value, "m"] as const),
  ...["Ν", "п", "ո"].map((value) => [value, "n"] as const),
  ...["Ο", "О", "ο", "о", "օ"].map((value) => [value, "o"] as const),
  ...["Ρ", "Р", "ρ", "р", "ϱ", "ƿ"].map((value) => [value, "p"] as const),
  ...["Ԛ", "ԛ"].map((value) => [value, "q"] as const),
  ...["Г", "г"].map((value) => [value, "r"] as const),
  ...["Ѕ", "ѕ"].map((value) => [value, "s"] as const),
  ...["Τ", "Т", "τ", "т"].map((value) => [value, "t"] as const),
  ...["Ս", "ս"].map((value) => [value, "u"] as const),
  ...["ν"].map((value) => [value, "v"] as const),
  ...["Ԝ", "ԝ", "ω"].map((value) => [value, "w"] as const),
  ...["Χ", "Х", "χ", "х"].map((value) => [value, "x"] as const),
  ...["Υ", "У", "γ", "у"].map((value) => [value, "y"] as const),
  ...["Ζ", "ζ"].map((value) => [value, "z"] as const),
]);

function providerClassificationSkeleton(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Cf}|\p{M}|\p{Variation_Selector}/gu, "")
    .replace(/[^\x00-\x7f]/gu, (character) => PROVIDER_CONFUSABLE_ASCII.get(character) ?? character)
    .toLowerCase();
}

const RESTRICTED_ASSIGNMENT_KEY_FAMILIES = [
  "password", "passwd", "pwd", "sessionid", "accesstoken", "refreshtoken", "idtoken",
  "token", "apikey", "secretkey", "privatekey", "clientsecret", "clientid", "secret",
  "authorization", "authorizationcode", "oauthcode", "authcode", "callbackcode",
  "credential", "credentials", "awsaccesskeyid", "awssecretaccesskey", "githubtoken",
  "code", "passphrase", "signingkey", "keysigning", "encryptionkey", "keyencryption",
  "sshkey", "keyssh", "secretvalue", "valuesecret", "passwordvalue", "valuepassword",
  "sessioncookie", "cookiesession", "accesskeyid", "idaccesskey", "keyapi",
] as const;

function isRestrictedAssignmentKey(value: string): boolean {
  const skeleton = providerClassificationSkeleton(value);
  return skeleton.split(/[^\x00-\x7f]+/gu).some((asciiSegment) => {
    const compact = asciiSegment.replace(/[^a-z0-9]/gu, "");
    return RESTRICTED_ASSIGNMENT_KEY_FAMILIES.some(
      (family) => compact === family || compact.startsWith(family) || compact.endsWith(family),
    );
  });
}

function containsRestrictedAssignment(value: string): boolean {
  const skeleton = providerClassificationSkeleton(value);
  const assignments = skeleton.matchAll(/([^:=\r\n]{1,64})\s*[:=]/gu);
  for (const assignment of assignments) {
    if (assignment[1] && isRestrictedAssignmentKey(assignment[1])) return true;
  }
  return false;
}

type EncodedProviderText =
  | { kind: "not-encoded" }
  | { kind: "text"; value: string };

interface ProviderInspectionBudget {
  remainingEncodedCandidates: number;
}

function decodeEncodedProviderCandidate(value: string): EncodedProviderText {
  if (
    value.length < 8
    || value.length > MAX_ENCODED_PROVIDER_CHARACTERS
    || !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)
    || value.length % 4 === 1
  ) return { kind: "not-encoded" };
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  try {
    const binary = globalThis.atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const canonical = globalThis.btoa(binary).replace(/=+$/u, "");
    if (canonical !== base64.replace(/=+$/u, "")) return { kind: "not-encoded" };
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    if (!decoded || /[\p{Cc}\p{Cs}]/u.test(decoded.replace(/[\t\r\n]/gu, ""))) {
      return { kind: "not-encoded" };
    }
    return { kind: "text", value: decoded };
  } catch {
    return { kind: "not-encoded" };
  }
}

function containsStructuredOpaqueCredential(value: string): boolean {
  const tokens = value.match(/[A-Za-z0-9+/_=-]{32,}/gu) ?? [];
  return tokens.some((token) => /[a-z]/u.test(token) && /[A-Z]/u.test(token) && /[0-9]/u.test(token));
}

function containsRestrictedProviderValue(
  value: unknown,
  depth: number,
  budget: ProviderInspectionBudget,
): boolean {
  if (depth > MAX_PROVIDER_FAILURE_DEPTH) return true;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const normalized = normalizeProviderText(value);
    return normalized === undefined || containsRestrictedProviderData(normalized, depth + 1, budget);
  }
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) {
    if (value.length > MAX_PROVIDER_FAILURE_ARRAY_ITEMS) return true;
    return value.some(
      (item) => containsRestrictedProviderValue(item, depth + 1, budget),
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PROVIDER_FAILURE_ARRAY_ITEMS) return true;
  return entries.some(([key, child]) => (
    isRestrictedAssignmentKey(key) || containsRestrictedProviderValue(child, depth + 1, budget)
  ));
}

function containsRestrictedEncodedProviderText(
  value: string,
  depth: number,
  budget: ProviderInspectionBudget,
): boolean {
  if (depth > MAX_PROVIDER_FAILURE_DEPTH) return true;
  for (const match of value.matchAll(/[A-Za-z0-9+/_-]{8,}={0,2}/gu)) {
    const candidate = match[0];
    const decoded = decodeEncodedProviderCandidate(candidate);
    if (decoded.kind === "not-encoded") continue;
    budget.remainingEncodedCandidates -= 1;
    if (budget.remainingEncodedCandidates < 0) return true;
    const normalized = normalizeProviderText(decoded.value);
    if (normalized === undefined) return true;
    if (/^(?:\{|\[|")/u.test(normalized)) {
      try {
        if (containsRestrictedProviderValue(JSON.parse(normalized), depth + 1, budget)) return true;
      } catch {
        // A reversible UTF-8 payload is not sensitive merely because it resembles malformed JSON.
      }
    }
    if (containsRestrictedProviderData(normalized, depth + 1, budget)) return true;
  }
  return false;
}

function containsRestrictedSecurityLabel(
  value: string,
  depth: number,
  budget: ProviderInspectionBudget,
): boolean {
  for (const match of value.matchAll(/([^\s:=]{4,24})\s+([A-Za-z0-9+/_-]{4,}={0,2})/gu)) {
    const labelSkeleton = providerClassificationSkeleton(match[1] ?? "");
    if (/[^\x00-\x7f]/u.test(labelSkeleton)) continue;
    const label = labelSkeleton.replace(/[^a-z]/gu, "");
    const payload = match[2];
    if (!payload || (label !== "bearer" && label !== "basic")) continue;
    const decoded = decodeEncodedProviderCandidate(payload);
    if (label === "bearer") return true;
    if (decoded.kind === "not-encoded") continue;
    budget.remainingEncodedCandidates -= 1;
    if (budget.remainingEncodedCandidates < 0) return true;
    const normalized = normalizeProviderText(decoded.value);
    if (normalized === undefined) return true;
    if (normalized.includes(":")) return true;
    if (containsRestrictedProviderData(normalized, depth + 1, budget)) return true;
  }
  return false;
}

function containsRestrictedProviderData(
  value: string,
  depth = 0,
  budget: ProviderInspectionBudget = {
    remainingEncodedCandidates: MAX_ENCODED_PROVIDER_CANDIDATES,
  },
): boolean {
  if (depth > MAX_PROVIDER_FAILURE_DEPTH) return true;
  const skeleton = providerClassificationSkeleton(value);
  const pathView = skeleton.replace(/\\+/gu, "/");
  return /\b(?:session[_-]?id|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|client[_-]?id)\b/iu.test(skeleton)
    || containsRestrictedAssignment(skeleton)
    || containsRestrictedSecurityLabel(value, depth, budget)
    || /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/?#@]{1,256}@/iu.test(skeleton)
    || /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/iu.test(value)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(value)
    || /\bgh[pousr]_[A-Za-z0-9]{6,}\b/u.test(value)
    || /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{6,}|xox[baprs]-[A-Za-z0-9-]{6,})\b/u.test(value)
    || /\beyJ[A-Za-z0-9+/_=-]{12,}/u.test(value)
    || /(?:^|[\s"'(=])(?:~\/|\/(?!\/)(?:(?:[^/\s"'<>]+\/)+[^/\s"'<>]*|(?:home|root|etc|var|tmp|opt|srv|mnt|private|run)(?:\/[^/\s"'<>]*)?))/u.test(value)
    || /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]+[^\\/\s"'<>]+(?:[\\/]+[^\\/\s"'<>]+)*|[\\/]{2}[^\\/\s"'<>]+[\\/]+[^\\/\s"'<>]+)/u.test(value)
    || /(?:^|[\s"'(=])(?:\.{0,2}[\\/]+)?(?:\.ssh|\.aws|\.codex|\.claude|\.config[\\/]+gh)[\\/]+[^\s"'<>]*/iu.test(value)
    || /(?:^|[\s"'(=])(?:\$(?:home|\{home\})|%home%|~)(?:\/|\\)/iu.test(skeleton)
    || pathView === "/"
    || /(?:^|[\s"'(=])\/(?:root|etc\/(?:passwd|shadow|sudoers(?:\.d)?|ssh)|run\/secrets|var\/run\/secrets)(?:\/|\b)/iu.test(pathView)
    || /(?:^|[\s"'(=/])(?:credentials?|auth\.json|config\.(?:json|ya?ml|toml)|\.env|id_(?:rsa|dsa|ecdsa|ed25519)|[^/\s"'<>]+\.(?:pem|key))(?:\b|$)/iu.test(pathView)
    || /(?:^|[\s"'(=])(?:\.{0,2}\/|~\/|(?:[^\s"'<>/]+\/)+)(?:\.config|\.ssh|\.aws|\.codex|\.claude|credentials?|secrets?|tokens?|auth|config)(?:\/|\b)/iu.test(pathView)
    || containsRestrictedEncodedProviderText(value, depth + 1, budget)
    || containsStructuredOpaqueCredential(value);
}

function malformedHumanFailure(
  value: string,
  depth: number,
  budget: ProviderInspectionBudget,
): string | undefined {
  const match = value.match(
    /["'](?:message|detail|reason|error)["']\s*:\s*["']([^"'\r\n]+)/iu,
  );
  return match?.[1] ? extractProviderFailure(match[1], depth + 1, budget) : undefined;
}

function extractProviderFailure(
  value: unknown,
  depth = 0,
  budget: ProviderInspectionBudget = {
    remainingEncodedCandidates: MAX_ENCODED_PROVIDER_CANDIDATES,
  },
): string | undefined {
  if (depth > MAX_PROVIDER_FAILURE_DEPTH || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const candidate = normalizeProviderText(value);
    if (!candidate) return undefined;
    if (/^(?:\{|\[|")/u.test(candidate)) {
      try {
        return extractProviderFailure(JSON.parse(candidate), depth + 1, budget);
      } catch {
        return malformedHumanFailure(candidate, depth, budget);
      }
    }
    const encoded = decodeEncodedProviderCandidate(candidate);
    if (encoded.kind === "text" && /^(?:\{|\[|")/u.test(encoded.value)) {
      try {
        const decodedValue = JSON.parse(encoded.value) as unknown;
        if (containsRestrictedProviderValue(decodedValue, depth + 1, budget)) return undefined;
        return extractProviderFailure(decodedValue, depth + 1, budget);
      } catch {
        // Treat malformed encoded JSON as plaintext; parse failure alone is not sensitive.
      }
    }
    return containsRestrictedProviderData(candidate, depth, budget) ? undefined : candidate;
  }
  if (typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    if (value.length > MAX_PROVIDER_FAILURE_ARRAY_ITEMS) return undefined;
    for (const item of value) {
      const extracted = extractProviderFailure(item, depth + 1, budget);
      if (extracted) return extracted;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of HUMAN_FAILURE_KEYS) {
    const extracted = extractProviderFailure(record[key], depth + 1, budget);
    if (extracted) return extracted;
  }
  return undefined;
}

/** A bounded, fail-closed summary safe for DTOs, notifications, and model context. */
export function publicProviderFailureSummary(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const normalized = normalizeProviderText(detail);
  if (!normalized) return undefined;
  const extracted = extractProviderFailure(normalized);
  if (!extracted) return undefined;
  return extracted.length > MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS
    ? `${extracted.slice(0, MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS - 1)}…`
    : extracted;
}

export type ProviderFailureKind = "capacity" | "rate_limit" | "authentication" | "context" | "unknown";

/** One category classifier shared by engines, server projections, and browser remediation. */
export function classifyProviderFailure(errorMessage: string): ProviderFailureKind {
  const normalized = normalizeProviderText(errorMessage);
  if (!normalized) return "unknown";
  const value = providerClassificationSkeleton(normalized);
  if (/selected model is at capacity|model.*capacity|overloaded|no capacity|resource exhausted/iu.test(value)) {
    return "capacity";
  }
  if (/rate.?limit|too many requests|\b429\b|session.?limit|usage.?limit|quota (?:is )?(?:exhausted|reached)|(?:you(?:'|’)ve|you have) hit your limit|limit resets?|\b0 weighted tokens left\b/iu.test(value)) {
    return "rate_limit";
  }
  if (/unauthori[sz]ed|authentication|sign.?in|oauth|invalid.*credential|subscription (?:access|expired|inactive)|organization has disabled/iu.test(value)) {
    return "authentication";
  }
  if (/context window|too many tokens|maximum context|pre-sampling compact/iu.test(value)) {
    return "context";
  }
  return "unknown";
}

export function publicProviderFailureCategorySummary(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const kind = classifyProviderFailure(detail);
  if (kind === "authentication") return "Provider authentication was rejected.";
  if (kind === "rate_limit") return "Provider usage limit was reached.";
  if (kind === "capacity") return "Provider is temporarily at capacity.";
  return undefined;
}
