import { gzip, gunzip, gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import {
  AGENT_PACKAGE_MAX_BYTES, AGENT_PACKAGE_LIMIT_LABEL, agentPackageJsonPieces,
  type AgentPortablePackageDto, type ImportAgentPackageRequest, type PortableArtifactDto,
} from "@ponderosa/core";
import { MANAGED_ARTIFACT_MAX_BYTES } from "@ponderosa/agents";
import { stableJsonParts } from "@ponderosa/agents/canonical-json";

const CODEC_TIMEOUT_MS = 60_000;
// The JSON source and parsed UTF-16 strings can coexist. A single bounded
// parser, measured at the supported ceiling, needs more than the old 192 MiB.
export const AGENT_PACKAGE_CODEC_HEAP_MIB = 3072;
const CODEC_ADMISSION_BYTES = 6 * 1024 * 1024 * 1024;
let importTail: Promise<void> = Promise.resolve();
let codecTail: Promise<void> = Promise.resolve();
async function admission<T>(kind: "import" | "codec", work: () => Promise<T>): Promise<T> {
  const previous = kind === "import" ? importTail : codecTail;
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  if (kind === "import") importTail = tail;
  else codecTail = tail;
  await previous;
  try { return await work(); } finally { release(); }
}
/** One import holds admission through parse, validation, publication and commit. */
export function withAgentImportAdmission<T>(work: () => Promise<T>): Promise<T> {
  return admission("import", work);
}

/** Internal imports retain the same canonical identity without materializing
 * a whole JSON string or borrowing the live-runtime structural budget. */
export async function portableImportPayloadHash(value: unknown, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  let batchBytes = 0;
  for (const part of stableJsonParts(value, { maxDepth: 64, maxNodes: AGENT_PACKAGE_MAX_BYTES })) {
    signal?.throwIfAborted();
    hash.update(part);
    batchBytes += Buffer.byteLength(part, "utf8");
    if (batchBytes >= 256 * 1024) {
      batchBytes = 0;
      await yieldToLoop();
    }
  }
  return hash.digest("hex");
}
export type PackageWireEntry =
  | { kind: "array" | "object"; path: Array<string | number> }
  | { kind: "string"; path: Array<string | number>; value: string }
  | { kind: "value"; path: Array<string | number>; value: unknown };

export interface PackageCodecOptions {
  signal?: AbortSignal;
  packageOnly?: boolean;
  jsonEnvelope?: boolean;
  onMemory?: (memory: NodeJS.MemoryUsage) => void;
}
/** The serialized parser and all retained decoded originals must fit together.
 * Keep ordinary package imports serialized and refuse before allocating/writing. */
export function assertAgentPackageMemoryAvailable(decodedBytes = 0): void {
  const required = CODEC_ADMISSION_BYTES + 2 * decodedBytes;
  // Also respect a constrained/cgroup process memory allowance where Node
  // exposes it. Never remove the worker cap to make a large upload succeed.
  const constrained = process.constrainedMemory();
  const processAvailable = process.availableMemory();
  // Node 24 reports usable memory, including reclaimable pages, within cgroups.
  const available = Math.min(processAvailable, constrained || Infinity);
  if (!Number.isFinite(processAvailable) || !Number.isFinite(constrained) || constrained < 0
    || !Number.isFinite(available) || available < required) {
    throw Object.assign(new Error(`Agent package processing needs ${(required / (1024 ** 3)).toFixed(2)} GiB of available memory for its complete decoded originals; retry when capacity is available`), { statusCode: 503 });
  }
}

export async function parsePortablePackageFile(pathname: string, options: PackageCodecOptions = {}): Promise<{
  metadata: Omit<ImportAgentPackageRequest, "package">;
  portable: AgentPortablePackageDto;
  canonicalPayloadHash?: string;
}> {
  return admission("codec", async () => {
    options.signal?.throwIfAborted();
    assertAgentPackageMemoryAvailable();
    return new Promise((resolve, reject) => {
      const worker = new Worker(import.meta.url.endsWith(".ts")
        ? new URL("../dist/agent-package-codec-worker.js", import.meta.url)
        : new URL("./agent-package-codec-worker.js", import.meta.url), {
        workerData: { pathname, packageOnly: options.packageOnly, jsonEnvelope: options.jsonEnvelope },
        resourceLimits: { maxOldGenerationSizeMb: AGENT_PACKAGE_CODEC_HEAP_MIB, maxYoungGenerationSizeMb: 32 },
      });
      let result: unknown;
      let settled = false;
      const finish = async (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        worker.removeAllListeners();
        // Admission stays held until the worker has actually released its heap.
        await worker.terminate();
        if (error) reject(error);
        else resolve(result as Awaited<ReturnType<typeof parsePortablePackageFile>>);
      };
      const abort = () => void finish(new Error("Agent package processing cancelled"));
      const timeout = setTimeout(() => void finish(new Error("Agent package codec exceeded its 60 second processing budget")), CODEC_TIMEOUT_MS);
      timeout.unref();
      worker.on("message", (message: { entries?: PackageWireEntry[]; done?: boolean; error?: string; statusCode?: number; memory?: NodeJS.MemoryUsage }) => {
        if (settled) return;
        if (message.error) return void finish(Object.assign(new Error(message.error), { statusCode: message.statusCode }));
        if (message.done) {
          if (message.memory) options.onMemory?.(message.memory);
          return void finish();
        }
        try {
          for (const entry of message.entries ?? []) {
            let parent = result as Record<string | number, unknown>;
            for (const key of entry.path.slice(0, -1)) parent = parent[key] as typeof parent;
            const key = entry.path.at(-1)!;
            const value = entry.kind === "array" ? [] : entry.kind === "object" ? {} : "value" in entry ? entry.value : undefined;
            if (!entry.path.length) result = value;
            else if (entry.kind === "string") parent[key] = (parent[key] as string) + entry.value;
            // JSON __proto__ is an own data field, never prototype authority.
            else Object.defineProperty(parent, key, { value, writable: true, enumerable: true, configurable: true });
          }
          worker.postMessage({ acknowledged: true });
        } catch (error) { void finish(error instanceof Error ? error : new Error(String(error))); }
      });
      worker.once("error", error => void finish(error));
      worker.once("exit", code => { if (!settled) void finish(new Error(`Agent package codec worker exited without a result (code ${code})`)); });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  });
}

const CHUNK_BYTES = 192 * 1024; // divisible by 3 for independent base64 chunks
/** Package previews need exact sizes without allocating decoded artifacts. */
export function portableBase64ByteLength(dataBase64: string): number {
  if (dataBase64.length > Math.ceil(MANAGED_ARTIFACT_MAX_BYTES / 3) * 4) throw new Error("portable artifact exceeds the 64 MiB managed-file limit");
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  const length = dataBase64.length - padding;
  const bytes = Math.floor(length * 3 / 4);
  if (bytes > MANAGED_ARTIFACT_MAX_BYTES) throw new Error("portable artifact exceeds the 64 MiB managed-file limit");
  if (length % 4 === 1 || (padding && dataBase64.length % 4 !== 0)) throw new Error("portable artifact has invalid base64 data");
  for (let offset=0; offset<length; offset+=256*1024) {
    if (/[^A-Za-z0-9+/]/u.test(dataBase64.slice(offset,Math.min(length,offset+256*1024)))) throw new Error("portable artifact has invalid base64 data");
  }
  const tail=dataBase64.slice(length ? Math.floor((length-1)/4)*4 : 0,length);
  if (Buffer.from(tail,"base64").toString("base64").replace(/=+$/u,"") !== tail) throw new Error("portable artifact has invalid base64 data");
  return bytes;
}

export async function encodePortableArtifact(source: Buffer): Promise<string> {
  if (source.length > MANAGED_ARTIFACT_MAX_BYTES) throw new Error("portable artifact exceeds the 64 MiB managed-file limit");
  const pieces: string[] = [];
  for (let offset = 0; offset < source.length; offset += CHUNK_BYTES) {
    pieces.push(source.subarray(offset, offset + CHUNK_BYTES).toString("base64"));
    await yieldToLoop();
  }
  return pieces.join("");
}
export async function decodePortableArtifact(dataBase64: string): Promise<{ data: Buffer; sha256: string }> {
  // Preserve ordinary managed-file admission (64 MiB per artifact).
  if (dataBase64.length > Math.ceil(MANAGED_ARTIFACT_MAX_BYTES / 3) * 4) throw new Error("portable artifact exceeds the 64 MiB managed-file limit");
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  const unpaddedLength = dataBase64.length - padding;
  if (unpaddedLength % 4 === 1 || (padding && dataBase64.length % 4 !== 0)) throw new Error("portable artifact has invalid base64 data");
  const decodedLength = Math.floor(unpaddedLength * 3 / 4);
  if (decodedLength > MANAGED_ARTIFACT_MAX_BYTES) throw new Error("portable artifact exceeds the 64 MiB managed-file limit");
  const data = Buffer.allocUnsafe(decodedLength);
  const hash = createHash("sha256");
  let written = 0;
  for (let offset = 0; offset < dataBase64.length; offset += 256 * 1024) {
    const part = dataBase64.slice(offset, offset + 256 * 1024);
    if (offset + part.length < dataBase64.length && /[^A-Za-z0-9+/]/u.test(part)) throw new Error("portable artifact has invalid base64 data");
    const bytes = Buffer.from(part, "base64");
    if (bytes.toString("base64").replace(/=+$/u, "") !== part.replace(/=+$/u, "")) throw new Error("portable artifact has invalid base64 data");
    bytes.copy(data, written);
    written += bytes.length;
    hash.update(bytes);
    await yieldToLoop();
  }
  if (written !== data.length || data.length > MANAGED_ARTIFACT_MAX_BYTES) throw new Error("portable artifact has invalid base64 data or exceeds 64 MiB");
  return { data, sha256: hash.digest("hex") };
}

/** Chunk boundaries preserve surrogate pairs and UTF-8. */
export async function* portablePackageJsonChunks(portable: AgentPortablePackageDto): AsyncGenerator<string> {
  let bytes = 0;
  let batchBytes = 0;
  let batch: string[] = [];
  for (const chunk of agentPackageJsonPieces(portable)) {
    const size = Buffer.byteLength(chunk, "utf8");
    bytes += size;
    if (bytes > AGENT_PACKAGE_MAX_BYTES) throw Object.assign(new Error(`Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL} (${bytes} serialized UTF-8 bytes)`), { statusCode: 413 });
    batch.push(chunk);
    batchBytes += size;
    if (batchBytes >= 256 * 1024 || batch.length >= 1024) {
      yield batch.join("");
      batch = [];
      batchBytes = 0;
      await yieldToLoop();
    }
  }
  if (batch.length) yield batch.join("");
}

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
type ArtifactData = Pick<PortableArtifactDto, "dataBase64" | "dataEncoding" | "decodedSize">;
/** Previews charge the declared original size; import verifies it before mutation. */
export function portableArtifactByteLength(artifact: ArtifactData): number {
  const encodedBytes = portableBase64ByteLength(artifact.dataBase64);
  if (artifact.dataEncoding === undefined) {
    if (artifact.decodedSize !== undefined) throw new Error("Unencoded artifact cannot declare a decoded size");
    return encodedBytes;
  }
  if (artifact.dataEncoding !== "gzip" || !Number.isSafeInteger(artifact.decodedSize)
      || artifact.decodedSize! < 0 || artifact.decodedSize! > MANAGED_ARTIFACT_MAX_BYTES) {
    throw new Error("Invalid portable artifact encoding or decoded size (64 MiB per file)");
  }
  return artifact.decodedSize!;
}
export async function encodePortableArtifactData(source: Buffer): Promise<ArtifactData> {
  if (source.length > MANAGED_ARTIFACT_MAX_BYTES) throw new Error("portable artifact exceeds the 64 MiB managed-file limit");
  // Small originals keep their established representation. Compression is only
  // a wire/storage optimization and never changes metadata, refs or content.
  if (source.length >= 64 * 1024) {
    const compressed = await gzipAsync(source);
    if (compressed.length < source.length) return {
      dataBase64: await encodePortableArtifact(compressed), dataEncoding: "gzip", decodedSize: source.length,
    };
  }
  return { dataBase64: await encodePortableArtifact(source) };
}
export async function decodePortableArtifactData(artifact: ArtifactData): Promise<{ data: Buffer; sha256: string }> {
  const expected = portableArtifactByteLength(artifact);
  const decoded = await decodePortableArtifact(artifact.dataBase64);
  if (!artifact.dataEncoding) return decoded;
  let data: Buffer;
  try {
    // Bounds apply to the actual output, including concatenated gzip members.
    data = await gunzipAsync(decoded.data, { maxOutputLength: Math.max(1, expected) });
  } catch { throw new Error("Portable artifact gzip is corrupt or exceeds its declared decoded size"); }
  if (data.length !== expected) throw new Error("Portable artifact decoded size does not match its original");
  return { data, sha256: createHash("sha256").update(data).digest("hex") };
}

/** Canonical review metadata has synchronous validation callers. Inflate only
 * its separately bounded original; hashing/parsing must never use gzip bytes. */
export function decodePortableMetadataArtifact(artifact: ArtifactData): Buffer {
  const expected = portableArtifactByteLength(artifact);
  if (expected > 48 * 1024 * 1024) throw new Error("Reviewed user-data manifest exceeds 48 MiB");
  let data = Buffer.from(artifact.dataBase64, "base64");
  if (artifact.dataEncoding === "gzip") {
    try { data = gunzipSync(data, { maxOutputLength: Math.max(1, expected) }); }
    catch { throw new Error("Reviewed user-data gzip is corrupt or exceeds its declared original size"); }
  }
  if (data.length !== expected) throw new Error("Reviewed user-data original size differs");
  return data;
}
