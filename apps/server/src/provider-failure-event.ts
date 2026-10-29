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
