export const MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS = 240;

const MAX_PROVIDER_FAILURE_INPUT_CHARACTERS = 64 * 1024;
const MAX_PROVIDER_FAILURE_DEPTH = 6;
const MAX_PROVIDER_FAILURE_ARRAY_ITEMS = 16;
const MAX_PROVIDER_FAILURE_NORMALIZATION_PASSES = 8;
const MAX_ENCODED_JSON_CHARACTERS = 8 * 1024;
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
    .normalize("NFKD")
    .replace(/\p{Cf}|\p{M}|\p{Variation_Selector}/gu, "")
    .normalize("NFKC")
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
  ...["Ο", "О", "ο", "о"].map((value) => [value, "o"] as const),
  ...["Ρ", "Р", "ρ", "р", "ϱ"].map((value) => [value, "p"] as const),
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
] as const;

function isRestrictedAssignmentKey(value: string): boolean {
  const skeleton = providerClassificationSkeleton(value);
  const compact = skeleton.replace(/[^a-z0-9]/gu, "");
  const semanticCharacters = [...skeleton.replace(/[\s_.\\/-]/gu, "")];
  return RESTRICTED_ASSIGNMENT_KEY_FAMILIES.some(
    (family) => {
      if (compact === family || compact.endsWith(family)) return true;
      if (semanticCharacters.length < family.length) return false;
      const suffix = semanticCharacters.slice(-family.length);
      return [...family].every((character, index) => {
        const observed = suffix[index];
        return observed === character || Boolean(observed && /[^\x00-\x7f]/u.test(observed));
      });
    },
  );
}

function containsRestrictedAssignment(value: string): boolean {
  const skeleton = providerClassificationSkeleton(value);
  const assignments = skeleton.matchAll(/([^:=\r\n]{1,64})\s*[:=]/gu);
  for (const assignment of assignments) {
    if (assignment[1] && isRestrictedAssignmentKey(assignment[1])) return true;
  }
  return false;
}

type EncodedJson =
  | { kind: "not-json" }
  | { kind: "malformed-json" }
  | { kind: "json"; value: unknown };

function decodeEncodedJsonCandidate(value: string): EncodedJson {
  if (
    value.length < 8
    || value.length > MAX_ENCODED_JSON_CHARACTERS
    || !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)
    || value.length % 4 === 1
  ) return { kind: "not-json" };
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  let decoded: string;
  try {
    const binary = globalThis.atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    return { kind: "not-json" };
  }
  if (!/^(?:\{|\[|")/u.test(decoded)) return { kind: "not-json" };
  try {
    return { kind: "json", value: JSON.parse(decoded) as unknown };
  } catch {
    return { kind: "malformed-json" };
  }
}

function containsOpaqueHighEntropyBlob(value: string): boolean {
  const tokens = value.match(/[A-Za-z0-9+/_=-]{32,}/gu) ?? [];
  return tokens.some((token) => {
    const frequencies = new Map<string, number>();
    for (const character of token) {
      frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
    }
    if (frequencies.size < 10) return false;
    const entropy = [...frequencies.values()].reduce((total, count) => {
      const probability = count / token.length;
      return total - probability * Math.log2(probability);
    }, 0);
    return entropy >= 3.5;
  });
}

function containsRestrictedProviderValue(value: unknown, depth: number): boolean {
  if (depth > MAX_PROVIDER_FAILURE_DEPTH) return true;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const normalized = normalizeProviderText(value);
    return normalized === undefined || containsRestrictedProviderData(normalized, depth + 1);
  }
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) {
    if (value.length > MAX_PROVIDER_FAILURE_ARRAY_ITEMS) return true;
    return value.some(
      (item) => containsRestrictedProviderValue(item, depth + 1),
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PROVIDER_FAILURE_ARRAY_ITEMS) return true;
  return entries.some(([key, child]) => (
    isRestrictedAssignmentKey(key) || containsRestrictedProviderValue(child, depth + 1)
  ));
}

function containsRestrictedEncodedJson(value: string, depth: number): boolean {
  if (depth > MAX_PROVIDER_FAILURE_DEPTH) return true;
  const candidates = value.match(/[A-Za-z0-9+/_-]{8,}={0,2}/gu) ?? [];
  if (candidates.length > MAX_PROVIDER_FAILURE_ARRAY_ITEMS) return true;
  return candidates.some((candidate) => {
    const decoded = decodeEncodedJsonCandidate(candidate);
    return decoded.kind === "malformed-json"
      || (decoded.kind === "json" && containsRestrictedProviderValue(decoded.value, depth + 1));
  });
}

function containsRestrictedProviderData(value: string, depth = 0): boolean {
  const skeleton = providerClassificationSkeleton(value);
  const pathView = skeleton.replace(/\\+/gu, "/");
  return /\b(?:session[_-]?id|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|client[_-]?id)\b/iu.test(skeleton)
    || containsRestrictedAssignment(skeleton)
    || /(?:^|[?&\s])(?:code|oauth[_-]?code|authorization[_-]?code|callback[_-]?code)\s*[:=]/iu.test(value)
    || /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/iu.test(value)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(value)
    || /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u.test(value)
    || /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/u.test(value)
    || /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/iu.test(value)
    || /\beyJ[A-Za-z0-9+/_=-]{12,}/u.test(value)
    || /(?:^|[\s"'(=])(?:~\/|\/(?!\/)(?:(?:[^/\s"'<>]+\/)+[^/\s"'<>]*|(?:home|root|etc|var|tmp|opt|srv|mnt|private|run)(?:\/[^/\s"'<>]*)?))/u.test(value)
    || /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]+[^\\/\s"'<>]+(?:[\\/]+[^\\/\s"'<>]+)*|[\\/]{2}[^\\/\s"'<>]+[\\/]+[^\\/\s"'<>]+)/u.test(value)
    || /(?:^|[\s"'(=])(?:\.{0,2}[\\/]+)?(?:\.ssh|\.aws|\.codex|\.claude|\.config[\\/]+gh)[\\/]+[^\s"'<>]*/iu.test(value)
    || /(?:^|[\s"'(=])(?:\$(?:home|\{home\})|%home%|~)(?:\/|\\)/iu.test(skeleton)
    || /(?:^|[\s"'(=])\/(?:$|[\s"')])/u.test(pathView)
    || /(?:^|[\s"'(=])\/(?:root|etc\/(?:passwd|shadow|sudoers(?:\.d)?|ssh)|run\/secrets|var\/run\/secrets)(?:\/|\b)/iu.test(pathView)
    || /(?:^|[\s"'(=/])(?:credentials?|auth\.json|config\.(?:json|ya?ml|toml)|\.env|id_(?:rsa|dsa|ecdsa|ed25519)|[^/\s"'<>]+\.(?:pem|key))(?:\b|$)/iu.test(pathView)
    || /(?:^|[\s"'(=])(?:\.{0,2}\/|~\/|(?:[^\s"'<>/]+\/)+)(?:\.config|\.ssh|\.aws|\.codex|\.claude|credentials?|secrets?|tokens?|auth|config)(?:\/|\b)/iu.test(pathView)
    || containsRestrictedEncodedJson(value, depth + 1)
    || containsOpaqueHighEntropyBlob(value);
}

function malformedHumanFailure(value: string, depth: number): string | undefined {
  const match = value.match(
    /["'](?:message|detail|reason|error)["']\s*:\s*["']([^"'\r\n]+)/iu,
  );
  return match?.[1] ? extractProviderFailure(match[1], depth + 1) : undefined;
}

function extractProviderFailure(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_PROVIDER_FAILURE_DEPTH || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const candidate = normalizeProviderText(value);
    if (!candidate) return undefined;
    if (/^(?:\{|\[|")/u.test(candidate)) {
      try {
        return extractProviderFailure(JSON.parse(candidate), depth + 1);
      } catch {
        return malformedHumanFailure(candidate, depth);
      }
    }
    const encoded = decodeEncodedJsonCandidate(candidate);
    if (encoded.kind === "malformed-json") return undefined;
    if (encoded.kind === "json") {
      if (containsRestrictedProviderValue(encoded.value, depth + 1)) return undefined;
      return extractProviderFailure(encoded.value, depth + 1);
    }
    return containsRestrictedProviderData(candidate, depth) ? undefined : candidate;
  }
  if (typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    if (value.length > MAX_PROVIDER_FAILURE_ARRAY_ITEMS) return undefined;
    for (const item of value) {
      const extracted = extractProviderFailure(item, depth + 1);
      if (extracted) return extracted;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of HUMAN_FAILURE_KEYS) {
    const extracted = extractProviderFailure(record[key], depth + 1);
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
