import { utf8ByteLength } from "./text-policy.js";

/** Portable packages use incremental JSON decoding, separate from ordinary messages. */
export const AGENT_PACKAGE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const AGENT_PACKAGE_MAX_STRING_LENGTH = 448 * 1024 * 1024;
export const AGENT_PACKAGE_MAX_AGENTS = 10_000;
// Originals stay bounded independently of their compressed wire size. Import
// reserves memory capacity for the admitted decoded aggregate before allocation.
// ponytail: 4 GiB originals remain in memory; larger imports need disk-backed publication.
export const AGENT_PACKAGE_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const AGENT_PACKAGE_STAGING_MAX_BYTES = 2 * AGENT_PACKAGE_MAX_BYTES;
export const AGENT_PACKAGE_METADATA_MAX_BYTES = 16 * 1024;
export const AGENT_PACKAGE_LIMIT_LABEL = "2 GiB";
export const AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL = "4 GiB decoded";

/** Portable text must survive UTF-8 storage without replacement characters. */
export function agentPackageTextIsWellFormed(value: string): boolean {
  return (value as string & { isWellFormed(): boolean }).isWellFormed();
}

/** Shared bounded serialization also admits text-only and remapped packages
 * without allocating a second, whole-package JSON string. */
export function* agentPackageJsonPieces(value: unknown, depth = 0): Generator<string> {
  if (depth > 64) throw new Error("Agent package nesting exceeds 64 levels");
  if (typeof value === "string") {
    if (value.length > AGENT_PACKAGE_MAX_STRING_LENGTH) throw Object.assign(new Error("Agent package JSON string exceeds 448 Mi UTF-16 code units"), { statusCode: 413 });
    yield '"';
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(value.length, offset + 32 * 1024);
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
      yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
      offset = end;
    }
    yield '"';
  } else if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      if (index) yield ",";
      yield* agentPackageJsonPieces(value[index] ?? null, depth + 1);
    }
    yield "]";
  } else if (value && typeof value === "object") {
    yield "{";
    let first = true;
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      if (!first) yield ",";
      first = false;
      yield JSON.stringify(key) + ":";
      yield* agentPackageJsonPieces(child, depth + 1);
    }
    yield "}";
  } else yield JSON.stringify(value) ?? "null";
}

/** Measure JSON bytes using the same bounded pieces as package serialization. */
export function agentPackageJsonUtf8Bytes(value: unknown, maximum = AGENT_PACKAGE_MAX_BYTES): number {
  let bytes = 0;
  for (const piece of agentPackageJsonPieces(value)) {
    bytes += utf8ByteLength(piece);
    if (bytes > maximum) throw Object.assign(new Error(`Agent package exceeds ${maximum === AGENT_PACKAGE_MAX_BYTES ? AGENT_PACKAGE_LIMIT_LABEL : `${maximum} bytes`} (${bytes} serialized UTF-8 bytes)`), { statusCode: 413 });
  }
  return bytes;
}
