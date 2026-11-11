import { publicProviderFailureEvent } from '@ponderosa/core';
import { redactBrowserText } from './browser-security.js';
import { redactPortableDiagnostic } from './portable-secrets.js';

export function redactProviderDiagnostic(text: string): string {
  return redactBrowserText(redactPortableDiagnostic(text));
}

/** Canonical Activity keeps the short headline and safely inspected original cause.
 * This runs before persistence, never as a UI-only redaction. */
export function canonicalProviderFailureEvent(event: Parameters<typeof publicProviderFailureEvent>[0]) {
  const failure = publicProviderFailureEvent(event);
  const diagnostic = redactProviderDiagnostic(event.message);
  return { ...failure, message: diagnostic === failure.message || diagnostic.startsWith(failure.message + '\n')
    ? diagnostic : `${failure.message}\n${diagnostic}` };
}

/** Redact only values already known to the current Run. No values are stored. */
export function redactKnownProviderValues(text: string, values: readonly (string | undefined)[]): string {
  const secrets = [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort((a, b) => b.length - a.length);
  if (!secrets.some(secret => text.includes(secret))) return text;
  const marker = ["[REDACTED]", "[hidden]", "*"].find(value => secrets.every(secret => !value.includes(secret))) ?? "";
  let result = "", offset = 0;
  while (offset < text.length) {
    let position = text.length, match = "";
    for (const secret of secrets) {
      const found = text.indexOf(secret, offset);
      if (found >= 0 && (found < position || found === position && secret.length > match.length)) { position = found; match = secret; }
    }
    if (!match) { result += text.slice(offset); break; }
    result += text.slice(offset, position) + marker;
    offset = position + match.length;
  }
  // If removing overlapping or very short values could join another secret,
  // fail closed instead of persisting a partial disclosure.
  if (secrets.some(secret => result.includes(secret))) {
    const withheld = "[Provider diagnostic omitted: known value could not be safely redacted]";
    return secrets.some(secret => withheld.includes(secret)) ? "" : withheld;
  }
  return result;
}
