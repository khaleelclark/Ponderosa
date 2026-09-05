export interface IdempotentAttempt<T = undefined> {
  fingerprint: string;
  idempotencyKey: string;
  prepared: T;
}

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
