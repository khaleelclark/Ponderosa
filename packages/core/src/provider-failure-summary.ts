export const MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS = 240;

const MAX_PROVIDER_FAILURE_INPUT_CHARACTERS = 64 * 1024;
const MAX_PROVIDER_FAILURE_DEPTH = 6;
const MAX_PROVIDER_FAILURE_ARRAY_ITEMS = 16;
const MAX_PROVIDER_FAILURE_NORMALIZATION_PASSES = 3;
const MAX_ENCODED_JSON_CHARACTERS = 8 * 1024;
const HUMAN_FAILURE_KEYS = ["message", "detail", "reason", "error"] as const;

function normalizeProviderText(value: string): string {
  let normalized = value;
  for (let pass = 0; pass < MAX_PROVIDER_FAILURE_NORMALIZATION_PASSES; pass += 1) {
    const decoded = normalized.replace(
      /\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|%([0-9a-f]{2})/giu,
      (escape, unicode: string | undefined, hex: string | undefined, percent: string | undefined) => {
        const codePoint = Number.parseInt(unicode ?? hex ?? percent ?? "", 16);
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) return escape;
        if (!unicode && (codePoint < 0x20 || codePoint > 0x7e)) return escape;
        return String.fromCodePoint(codePoint);
      },
    ).normalize("NFKC");
    if (decoded === normalized) break;
    normalized = decoded;
  }
  return normalized
    .replace(/\\udb40\\udd[0-9a-f]{2}|\\x(?:ad)|%e2%80%(?:8b|8c|8d)|%ef%bb%bf/giu, "")
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufe00-\ufe0f\ufeff\u{e0100}-\u{e01ef}]/gu, "")
    .replace(/\\\//gu, "/")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function providerClassificationSkeleton(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(
    /[\u0391\u0392\u0395\u0397\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a5\u03a7\u03b1\u03b5\u03b9\u03ba\u03bd\u03bf\u03c1\u03c4\u03c5\u03c7\u0406\u0408\u0410\u0412\u0415\u041a\u041c\u041d\u041e\u0420\u0421\u0422\u0425\u0430\u0435\u043a\u043c\u043e\u0440\u0441\u0442\u0445\u0455\u0456\u0458]/gu,
    (character) => ({
      "\u0391": "a", "\u0392": "b", "\u0395": "e", "\u0397": "h", "\u0399": "i", "\u039a": "k",
      "\u039c": "m", "\u039d": "n", "\u039f": "o", "\u03a1": "p", "\u03a4": "t", "\u03a5": "y",
      "\u03a7": "x", "\u03b1": "a", "\u03b5": "e", "\u03b9": "i", "\u03ba": "k", "\u03bd": "v",
      "\u03bf": "o", "\u03c1": "p", "\u03c4": "t", "\u03c5": "y", "\u03c7": "x", "\u0406": "i",
      "\u0408": "j", "\u0410": "a", "\u0412": "b", "\u0415": "e", "\u041a": "k", "\u041c": "m",
      "\u041d": "h", "\u041e": "o", "\u0420": "p", "\u0421": "c", "\u0422": "t", "\u0425": "x",
      "\u0430": "a", "\u0435": "e", "\u043a": "k", "\u043c": "m", "\u043e": "o", "\u0440": "p",
      "\u0441": "c", "\u0442": "t", "\u0445": "x", "\u0455": "s", "\u0456": "i", "\u0458": "j",
    })[character] ?? character,
  );
}

const RESTRICTED_ASSIGNMENT_KEY_FAMILIES = [
  "password", "passwd", "pwd", "sessionid", "accesstoken", "refreshtoken", "idtoken",
  "token", "apikey", "secretkey", "privatekey", "clientsecret", "clientid", "secret",
  "authorization", "authorizationcode", "oauthcode", "authcode", "callbackcode",
  "credential", "credentials", "awsaccesskeyid", "awssecretaccesskey", "githubtoken",
] as const;

function isRestrictedAssignmentKey(value: string): boolean {
  const compact = providerClassificationSkeleton(value).replace(/[^a-z0-9]/gu, "");
  return RESTRICTED_ASSIGNMENT_KEY_FAMILIES.some(
    (family) => compact === family || compact.endsWith(family),
  );
}

function containsRestrictedAssignment(value: string): boolean {
  const skeleton = providerClassificationSkeleton(value);
  const assignments = skeleton.matchAll(/(?:^|[^a-z0-9])([a-z0-9][a-z0-9_.\-\s]{0,47})\s*[:=]/gu);
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
    return containsRestrictedProviderData(normalizeProviderText(value), depth + 1);
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
    if (!candidate || candidate.length > MAX_PROVIDER_FAILURE_INPUT_CHARACTERS) return undefined;
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
  if (!normalized || normalized.length > MAX_PROVIDER_FAILURE_INPUT_CHARACTERS) return undefined;
  const extracted = extractProviderFailure(normalized);
  if (!extracted) return undefined;
  return extracted.length > MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS
    ? `${extracted.slice(0, MAX_PUBLIC_PROVIDER_FAILURE_CHARACTERS - 1)}…`
    : extracted;
}
