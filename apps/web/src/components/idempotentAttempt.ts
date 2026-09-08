import type { DraftPendingSubmissionDto } from "@ponderosa/core";

export interface IdempotentAttempt<T = undefined> {
  fingerprint: string;
  idempotencyKey: string;
  prepared: T;
}

export async function durableSubmissionFingerprint(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function selectDurableSubmission(
  current: DraftPendingSubmissionDto | undefined,
  fingerprint: string,
  createId: () => string,
): DraftPendingSubmissionDto {
  return current &&
    (current.intentFingerprint ?? current.fingerprint) === fingerprint
    ? current
    : { fingerprint, intentFingerprint: fingerprint, idempotencyKey: createId() };
}

export async function withPendingAgentTitle(
  pending: DraftPendingSubmissionDto,
  agentTitle: string,
): Promise<DraftPendingSubmissionDto> {
  if (pending.agentTitle === agentTitle) return pending;
  const intentFingerprint = pending.intentFingerprint ?? pending.fingerprint;
  return {
    ...pending,
    intentFingerprint,
    fingerprint: await durableSubmissionFingerprint({ intentFingerprint, agentTitle }),
    agentTitle,
  };
}

export const definitiveSubmissionStatus = (status: number): boolean =>
  status >= 400 && status < 500;

/** Release a prepared operation when the user changes its submission intent. */
export const abandonIdempotentAttempt = <T>(
  current: IdempotentAttempt<T> | undefined,
): { current: undefined; abandoned: IdempotentAttempt<T>[] } => ({
  current: undefined,
  abandoned: current ? [current] : [],
});

/** Keep one operation identity and its prepared inputs until the action changes. */
export const retainIdempotentAttempt = <T>(
  current: IdempotentAttempt<T> | undefined,
  fingerprint: string,
  createId: () => string,
  prepare: () => T,
): IdempotentAttempt<T> => current?.fingerprint === fingerprint
  ? current
  : { fingerprint, idempotencyKey: createId(), prepared: prepare() };

/** Select an ambiguous prepared operation before consulting any mutable
 * recipient, runtime, or projection state. */
export const preparedIdempotentAttemptForRetry = <T>(
  current: IdempotentAttempt<T> | undefined,
  retryPrepared: boolean,
): IdempotentAttempt<T> | undefined => retryPrepared && current
  ? current
  : undefined;

/** Resolve an ambiguous retry before evaluating any live request inputs. */
export const selectIdempotentAttempt = <T>(
  current: IdempotentAttempt<T> | undefined,
  retryPrepared: boolean,
  fingerprint: () => string,
  createId: () => string,
  prepare: () => T,
): IdempotentAttempt<T> => preparedIdempotentAttemptForRetry(
  current,
  retryPrepared,
) ?? retainIdempotentAttempt(current, fingerprint(), createId, prepare);
