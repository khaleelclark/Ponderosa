// Structured credential fields only: free-form history retains its exact text.
const secretField = /^(?:authorization|password|passwd|credentials|secrets?|secretBindings|token|authToken|capabilityToken|messageCapability|bearerToken|signingSecret|vapidPrivateKey|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)$/i;
const providerSecretFields = new Set([
  'openaiapikey', 'openaiadminkey', 'openaiaccesstoken', 'openaiauthtoken',
  'anthropicapikey', 'anthropicauthtoken', 'claudecodeoauthtoken', 'codexapikey',
  'azureopenaiapikey', 'azureopenaiadtoken', 'geminiapikey', 'googleapikey',
  'googleapplicationcredentials', 'awsaccesskeyid', 'awssecretaccesskey', 'awssessiontoken',
  'ponderosavapidprivatekey',
]);
export const PORTABLE_SECRET_MAX_BYTES = 64 * 1024 * 1024;
export const PORTABLE_SECRET_MAX_DEPTH = 64;

export function isPortableSecretField(key:string):boolean {
  return secretField.test(key) || providerSecretFields.has(key.replace(/[_-]/g,'').toLowerCase());
}

/** One budget follows every decoded value and embedded diagnostic span. */
function portableSecretInspection(maxBytes: number, diagnostic = false) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Portable structured data byte limit is invalid');
  let remaining = Math.min(maxBytes, PORTABLE_SECRET_MAX_BYTES);
  const charge = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) throw Object.assign(new Error('Portable structured data exceeds the inspection byte limit'), { statusCode: 413 });
  };
  const checkDepth = (depth: number) => {
    if (depth > PORTABLE_SECRET_MAX_DEPTH) throw new Error('Portable structured data exceeds the supported nesting depth');
  };

  function spanEnd(text: string, start: number, depth: number): number {
    const first = text[start];
    let quote = first === '"' || first === "'" ? first : '';
    let nesting = quote ? 0 : 1;
    let end = start + 1;
    for (; end < text.length; end++) {
      charge(1);
      const character = text[end];
      if (quote) {
        if (character === '\\') { charge(1); end++; continue; }
        if (character === quote) { quote = ''; if (!nesting) return end + 1; }
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '{' || character === '[') { nesting++; checkDepth(depth + nesting); }
      else if ((character === '}' || character === ']') && --nesting === 0) return end + 1;
    }
    return text.length;
  }

  function redactText(text: string, depth: number): string {
    charge(Buffer.byteLength(text));
    const token = /(?:"([a-zA-Z][a-zA-Z0-9_-]*)"|'([a-zA-Z][a-zA-Z0-9_-]*)'|\b([a-zA-Z][a-zA-Z0-9_-]*))\s*[:=]\s*|["'\[{]/g;
    let result = '', start = 0;
    for (let match; (match = token.exec(text));) {
      const field = match[1] ?? match[2] ?? match[3];
      if (field && !isPortableSecretField(field)) continue;
      const valueStart = field ? token.lastIndex : match.index;
      let end = valueStart;
      if (/^["'\[{]$/.test(text[end] ?? '')) end = spanEnd(text, end, depth);
      else {
        while (end < text.length && !/[\s,;&#}\]]/.test(text[end]!)) { charge(1); end++; }
        if (field?.toLowerCase() === 'authorization' && /^(?:Bearer|Basic)$/i.test(text.slice(valueStart, end))) {
          while (end < text.length && /[ \t]/.test(text[end]!)) { charge(1); end++; }
          while (end < text.length && !/[\s,;&#}\]]/.test(text[end]!)) { charge(1); end++; }
        }
      }
      let replacement = '[REDACTED]';
      if (!field) {
        const original = text.slice(valueStart, end);
        let parsed: unknown;
        try { parsed = JSON.parse(original); }
        catch { continue; } // Keep scanning malformed prose for named fields.
        const safe = visit(parsed, depth + 1);
        if (JSON.stringify(parsed) === JSON.stringify(safe)) {
          token.lastIndex = end;
          continue;
        }
        replacement = JSON.stringify(safe);
      }
      result += text.slice(start, valueStart) + replacement;
      start = end;
      token.lastIndex = end;
    }
    return (result + text.slice(start)).replace(/(\bbearer\s+)[a-z0-9._~+/=-]+/gi, '$1[REDACTED]');
  }

  function visit(item: unknown, depth: number): unknown {
    checkDepth(depth);
    charge(8);
    if (typeof item === 'string') {
      if (diagnostic) return redactText(item, depth);
      charge(Buffer.byteLength(item));
      if (!/^[\s]*[\[{"]/.test(item)) return item;
      let parsed: unknown;
      try { parsed = JSON.parse(item); } catch { return item; }
      const safe = visit(parsed, depth + 1);
      return JSON.stringify(parsed) === JSON.stringify(safe) ? item : JSON.stringify(safe);
    }
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).flatMap(([key, child]) => {
      charge(Buffer.byteLength(key));
      return isPortableSecretField(key) ? [] : [[key, visit(child, depth + 1)]];
    }));
    return item;
  }
  return (value: unknown) => visit(value, 0);
}

/** Shared export scrub/import check. Unchanged strings retain their original bytes. */
export function withoutPortableSecrets(value: unknown, maxBytes = PORTABLE_SECRET_MAX_BYTES): unknown {
  return portableSecretInspection(maxBytes)(value);
}

/** Validate metadata only; user-authored text remains outside this policy. */
export function assertPortableSecretsAbsent(value: unknown, label = 'Portable structured data'): void {
  if (JSON.stringify(withoutPortableSecrets(value)) !== JSON.stringify(value)) throw new Error(`${label} cannot contain known credential fields`);
}

/** Provider text includes embedded JSON, not just a whole JSON document. */
export function redactPortableDiagnostic(text: string): string {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) return '[Provider diagnostic omitted: exceeds 4 MiB inspection limit]';
  try { return portableSecretInspection(16 * 1024 * 1024, true)(text) as string; }
  catch { return '[Provider diagnostic omitted: structured inspection limit exceeded]'; }
}
