import type { DraftPendingSubmissionDto } from "@ponderosa/core";

export interface IdempotentAttempt<T = undefined> {
  fingerprint: string;
  idempotencyKey: string;
  prepared: T;
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value: number, shift: number): number =>
  (value >>> shift) | (value << (32 - shift));

/** Browser-compatible SHA-256 for trusted HTTP deployments where SubtleCrypto
 * is unavailable. The result intentionally matches the native digest exactly. */
function fallbackSha256(bytes: Uint8Array): string {
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(paddedLength - 4, bytes.length << 3);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]!;
      const right = words[index - 2]!;
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const first = (h! + sum1 + choice + SHA256_ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const second = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
  return [...state].map(word => word.toString(16).padStart(8, "0")).join("");
}

export async function durableSubmissionFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (!globalThis.crypto?.subtle) return fallbackSha256(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
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

export const definitiveSubmissionStatus = (
  status: number,
  message = "",
): boolean =>
  status >= 400 && status < 500 &&
  !(status === 409 && message.toLocaleLowerCase().includes("collision"));

export const compoundCreationSettlesUnavailable = (
  creationCommitted: boolean,
  status: number,
  message: string,
): boolean => creationCommitted && status === 409 &&
  message === "No addressed Agent remains available";

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
