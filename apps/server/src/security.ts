import { createHash, timingSafeEqual } from "node:crypto";

function derivedRunActionKey(runId: string, action: string, payload: unknown): string {
  return `auto:${createHash("sha256").update(`${runId}\0${action}\0${JSON.stringify(payload)}`).digest("hex")}`;
}

function secretEqual(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export {
  derivedRunActionKey,
  secretEqual,
};
