import {isProxy} from 'node:util/types';
import {safeWorkingCopyFailure} from '@ponderosa/agents';
import {isPortableSecretField} from './portable-secrets.js';
import {redactKnownProviderValues,redactProviderDiagnostic} from './provider-failure-event.js';

// Process-local credential-shaped environment values,
// not a credential store. Values from external helpers/config are not known here.
function knownDiagnosticValues(): string[] {
  return Object.entries(process.env).flatMap(([name,value]) =>
    value && (isPortableSecretField(name) || /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY)$/i.test(name)) ? [value] : []);
}
export function redactKnownDiagnosticValues(text: string): string {
  return redactKnownProviderValues(text,knownDiagnosticValues());
}
const captured = new WeakMap<object,string>();
function ownText(error: unknown, key: 'message' | 'stderr'): string | undefined {
  if (!error || typeof error !== 'object' || isProxy(error)) return undefined;
  try {
    const field=Object.getOwnPropertyDescriptor(error,key);
    return field && 'value' in field && typeof field.value==='string' && field.value.length<=1024*1024 ? field.value : undefined;
  } catch { return undefined; }
}
/** Format a fresh local failure without consulting stored legacy diagnostics. */
export function freshFailureDiagnostic(error: unknown, fallback: string): string {
  const values=knownDiagnosticValues();
  const safeBase=redactKnownProviderValues(fallback,values);
  const detail=ownText(error,'stderr')?.trim() || ownText(error,'message')?.trim();
  if (!detail) return safeBase;
  const safe=redactKnownProviderValues(redactProviderDiagnostic(redactKnownProviderValues(detail,values)),values);
  return redactKnownProviderValues(safe && safe!==safeBase ? `${safeBase} ${safe}` : safeBase,values);
}
export function workingCopyDiagnostic(error: unknown): string {
  if (error && typeof error==='object' && captured.has(error)) return captured.get(error)!;
  const base=safeWorkingCopyFailure(error);
  const detail=ownText(error,'stderr')?.trim() || ownText(error,'message')?.trim();
  if (!detail) return redactKnownProviderValues(base,knownDiagnosticValues());
  const values=knownDiagnosticValues();
  const safe=redactKnownProviderValues(redactProviderDiagnostic(redactKnownProviderValues(detail,values)),values);
  if (!safe) return redactKnownProviderValues(base,values);
  if (safe===base) return safe;
  const prefix=base==='The working folder could not be changed safely; unverified error details were withheld.'
    ? 'The working folder could not be changed safely.'
    : base.replace(' Additional Git details are not shown because they may contain credentials.','');
  return redactKnownProviderValues(`${prefix}\n${safe}`,values);
}
/** Preserve the already-redacted diagnostic when a native error is wrapped. */
export function rememberWorkingCopyDiagnostic(error: unknown, message=workingCopyDiagnostic(error)): void {
  if (error && typeof error==='object' && !isProxy(error)) captured.set(error,message);
}
