import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  listSecureDirectory,
  readSecureFile,
  readSecureFileAsync,
  removeSecureFile,
  writeSecureFileAtomic,
} from "@ponderosa/native-host";
import { managedArtifactContentPath } from "./paths.js";

export const MANAGED_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

export interface ManagedArtifactFile {
  path: string;
  body: Buffer;
  size: number;
  sha256: string;
}

export interface ManagedArtifactContentHandle {
  path: string;
  size: number;
  sha256: string;
  readRange(maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
  createReadStream(signal?: AbortSignal): Readable;
  close(): Promise<void>;
}

export interface ManagedArtifactBatchInput {
  artifactId: string;
  input: Buffer | string;
}

export interface ManagedArtifactReadInput {
  artifactId: string;
  expectedSize: number;
  expectedSha256: string;
}

const SAFE_LEAF = /^[A-Za-z0-9_-]{1,128}$/u;
const activePublications = new Set<string>();

function publicationKey(dataDir: string, projectId: string, artifactId: string): string {
  return `${path.resolve(dataDir)}\0${projectId}\0${artifactId}`;
}

function publicationLeafIsActive(dataDir: string, projectId: string, leaf: string): boolean {
  const prefix = `${path.resolve(dataDir)}\0${projectId}\0`;
  for (const key of activePublications) {
    if (!key.startsWith(prefix)) continue;
    const artifactId = key.slice(prefix.length);
    if (leaf === artifactId || leaf.startsWith(`.${artifactId}.`)) return true;
  }
  return false;
}

function safeProjectId(projectId: string): boolean {
  return SAFE_LEAF.test(projectId) && path.basename(projectId) === projectId;
}

function safeArtifactId(artifactId: string): boolean {
  return Boolean(artifactId) && path.basename(artifactId) === artifactId && artifactId !== "." && artifactId !== "..";
}

function nativeManagedDirectory(projectId: string): string {
  return path.posix.join("projects", projectId, "artifacts", "content");
}

function nativeManagedFile(projectId: string, artifactId: string): string {
  return path.posix.join(nativeManagedDirectory(projectId), artifactId);
}

function publicationWorkerUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("../dist/managed-artifact-publication-worker.js", import.meta.url)
    : new URL("./managed-artifact-publication-worker.js", import.meta.url);
}

function readWorkerUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("../dist/managed-artifact-read-worker.js", import.meta.url)
    : new URL("./managed-artifact-read-worker.js", import.meta.url);
}

/** Verify many small immutable blobs off the event loop without a new worker
 * for every file. A missing or changed blob remains undefined (fail closed). */
export async function readManagedArtifactContentsAsync(
  dataDir: string,
  projectId: string,
  inputs: readonly ManagedArtifactReadInput[],
): Promise<Array<Buffer | undefined>> {
  if (!safeProjectId(projectId)) throw new Error("managed artifact Project id must be a single safe leaf");
  const chunks: Array<{ start: number; entries: ManagedArtifactReadInput[] }> = [];
  let entries: ManagedArtifactReadInput[] = [];
  let bytes = 0;
  let start = 0;
  for (const input of inputs) {
    if (!safeArtifactId(input.artifactId) ||
        !Number.isSafeInteger(input.expectedSize) || input.expectedSize < 1 ||
        input.expectedSize > MANAGED_ARTIFACT_MAX_BYTES ||
        !/^[a-f0-9]{64}$/u.test(input.expectedSha256)) {
      throw new Error("managed artifact read identity is invalid");
    }
    if (entries.length && (entries.length >= 128 || bytes + input.expectedSize > 8 * 1024 * 1024)) {
      chunks.push({ start, entries });
      start += entries.length;
      entries = [];
      bytes = 0;
    }
    entries.push(input);
    bytes += input.expectedSize;
  }
  if (entries.length) chunks.push({ start, entries });
  const result = new Array<Buffer | undefined>(inputs.length);
  let next = 0;
  const readChunk = (chunk: typeof chunks[number]): Promise<void> => new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(readWorkerUrl(), {
        workerData: { dataDir, projectId, entries: chunk.entries },
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const finish = (outcome: { bodies?: Array<Uint8Array | undefined>; error?: string }): void => {
      if (settled) return;
      settled = true;
      worker.removeAllListeners();
      void worker.terminate().then(() => {
        if (outcome.error) return reject(new Error(outcome.error));
        if (outcome.bodies?.length !== chunk.entries.length) {
          return reject(new Error("managed artifact read worker returned incomplete results"));
        }
        outcome.bodies.forEach((body, index) => {
          result[chunk.start + index] = body ? Buffer.from(body) : undefined;
        });
        resolve();
      }, reject);
    };
    worker.once("message", finish);
    worker.once("error", (error) => finish({ error: error.message }));
    worker.once("exit", (code) => {
      if (!settled) finish({ error: `managed artifact read worker exited without a result (code ${code})` });
    });
  });
  const readNext = async (): Promise<void> => {
    while (next < chunks.length) await readChunk(chunks[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, () => readNext()));
  return result;
}

function publishManagedArtifactContentNative(
  dataDir: string,
  projectId: string,
  artifactId: string,
  body: Buffer,
  sha256: string,
): { created: boolean; result: Omit<ManagedArtifactFile, "body"> } {
  const destination = managedArtifactContentPath(dataDir, projectId, artifactId);
  const temporaryLeaf = `.${artifactId}.${randomUUID()}.tmp`;
  try {
    writeSecureFileAtomic({
      root: dataDir,
      relativeDirectory: nativeManagedDirectory(projectId),
      leaf: artifactId,
      temporaryLeaf,
      body,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const concurrent = readManagedArtifactContent(
      dataDir,
      projectId,
      artifactId,
      body.length,
      sha256,
    );
    if (!concurrent) {
      throw new Error(
        "managed artifact identity collision or unsafe existing leaf",
        { cause: error },
      );
    }
    return {
      created: false,
      result: { path: destination, size: body.length, sha256 },
    };
  }
  const published = readManagedArtifactContent(
    dataDir,
    projectId,
    artifactId,
    body.length,
    sha256,
  );
  if (!published) {
    // The installed identity is no longer trusted. Never delete the current
    // name without that exact identity: leave the uncatalogued leaf for repair.
    throw new Error("managed artifact changed during atomic publication");
  }
  return {
    created: true,
    result: { path: destination, size: body.length, sha256 },
  };
}

/** Worker-only entry point. It deliberately uses the cross-platform native
 * authority so concurrent isolates still meet atomic no-replace semantics. */
export function publishManagedArtifactContentInWorker(
  dataDir: string,
  projectId: string,
  artifactId: string,
  body: Buffer,
): Omit<ManagedArtifactFile, "body"> {
  if (!safeArtifactId(artifactId) || !safeProjectId(projectId)) {
    throw new Error("managed artifact worker received an unsafe identity");
  }
  if (!Buffer.isBuffer(body) || body.length < 1 ||
      body.length > MANAGED_ARTIFACT_MAX_BYTES) {
    throw new Error("managed artifact must contain 1 to 64 MiB");
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  return publishManagedArtifactContentNative(
    dataDir,
    projectId,
    artifactId,
    body,
    sha256,
  ).result;
}

/** Publish bounded immutable bytes without running native hashing, writes, or
 * durability waits on the server event loop. Aborted workers may leave only an
 * uncatalogued immutable leaf, which startup repair is authorized to reclaim. */
export function publishManagedArtifactContentAsync(
  dataDir: string,
  projectId: string,
  artifactId: string,
  input: Buffer | string,
  signal?: AbortSignal,
): Promise<Omit<ManagedArtifactFile, "body">> {
  if (!safeArtifactId(artifactId)) {
    throw new Error("managed artifact id must be a single safe leaf");
  }
  if (!safeProjectId(projectId)) {
    throw new Error("managed artifact Project id must be a single safe leaf");
  }
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  if (source.length < 1 || source.length > MANAGED_ARTIFACT_MAX_BYTES) {
    throw new Error("managed artifact must contain 1 to 64 MiB");
  }
  const body = new Uint8Array(source.length);
  body.set(source);
  const activeKey = publicationKey(dataDir, projectId, artifactId);
  if (activePublications.has(activeKey)) {
    throw new Error("managed artifact publication is already active");
  }
  activePublications.add(activeKey);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      signal?.throwIfAborted();
      worker = new Worker(publicationWorkerUrl(), {
        workerData: {
          dataDir,
          projectId,
          artifactId,
          body,
        },
        transferList: [body.buffer],
      });
    } catch (error) {
      activePublications.delete(activeKey);
      reject(error);
      return;
    }
    let settled = false;
    const detachListeners = (): void => {
      signal?.removeEventListener("abort", abort);
      worker.removeAllListeners();
    };
    const release = (): void => {
      activePublications.delete(activeKey);
    };
    const finish = (
      outcome: {
        result?: Omit<ManagedArtifactFile, "body">;
        error?: string;
      },
      workerExited = false,
    ): void => {
      if (settled) return;
      settled = true;
      detachListeners();
      const settle = (): void => {
        release();
        if (outcome.error) reject(new Error(outcome.error));
        else if (outcome.result) resolve(outcome.result);
        else reject(new Error("managed artifact publication worker returned no result"));
      };
      if (workerExited) settle();
      else {
        void worker.terminate().then(
          settle,
          (error: unknown) => {
            release();
            reject(error instanceof Error
              ? error
              : new Error("managed artifact publication worker termination failed"));
          },
        );
      }
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      detachListeners();
      const reason = signal?.reason instanceof Error
        ? signal.reason
        : new Error("managed artifact publication aborted");
      void worker.terminate().then(
        () => {
          release();
          reject(reason);
        },
        (error: unknown) => {
          release();
          reject(error instanceof Error ? error : reason);
        },
      );
    };
    worker.once("message", finish);
    worker.once("error", (error) => finish({ error: error.message }));
    worker.once("exit", (code) => {
      if (!settled) {
        finish({
          error: `managed artifact publication worker exited without a result (code ${code})`,
        }, true);
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Keep one worker busy with a bounded group instead of starting a worker for
 * every small artifact in a large import. */
function publishManagedArtifactChunkAsync(
  dataDir: string,
  projectId: string,
  inputs: readonly ManagedArtifactBatchInput[],
  signal?: AbortSignal,
): Promise<Array<Omit<ManagedArtifactFile, "body">>> {
  if (!safeProjectId(projectId)) {
    throw new Error("managed artifact Project id must be a single safe leaf");
  }
  signal?.throwIfAborted();
  const entries: Array<{ artifactId: string; body: Uint8Array }> = [];
  const keys: string[] = [];
  for (const { artifactId, input } of inputs) {
    if (!safeArtifactId(artifactId)) {
      throw new Error("managed artifact id must be a single safe leaf");
    }
    const source = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
    if (source.length < 1 || source.length > MANAGED_ARTIFACT_MAX_BYTES) {
      throw new Error("managed artifact must contain 1 to 64 MiB");
    }
    const key = publicationKey(dataDir, projectId, artifactId);
    if (activePublications.has(key)) {
      throw new Error("managed artifact publication is already active");
    }
    const body = new Uint8Array(source.length);
    body.set(source);
    entries.push({ artifactId, body });
    keys.push(key);
  }
  for (const key of keys) activePublications.add(key);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      signal?.throwIfAborted();
      worker = new Worker(publicationWorkerUrl(), {
        workerData: { dataDir, projectId, entries },
        transferList: entries.map(({ body }) => body.buffer as ArrayBuffer),
      });
    } catch (error) {
      for (const key of keys) activePublications.delete(key);
      reject(error);
      return;
    }
    let settled = false;
    const release = (): void => {
      for (const key of keys) activePublications.delete(key);
    };
    const detachListeners = (): void => {
      signal?.removeEventListener("abort", abort);
      worker.removeAllListeners();
    };
    const finish = (
      outcome: { results?: Array<Omit<ManagedArtifactFile, "body">>; error?: string },
      workerExited = false,
    ): void => {
      if (settled) return;
      settled = true;
      detachListeners();
      const settle = (): void => {
        release();
        if (outcome.error) reject(new Error(outcome.error));
        else if (outcome.results?.length === inputs.length) resolve(outcome.results);
        else reject(new Error("managed artifact publication worker returned incomplete results"));
      };
      if (workerExited) settle();
      else void worker.terminate().then(settle, (error: unknown) => {
        release();
        reject(error instanceof Error ? error : new Error("managed artifact publication worker termination failed"));
      });
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      detachListeners();
      const reason = signal?.reason instanceof Error
        ? signal.reason
        : new Error("managed artifact publication aborted");
      void worker.terminate().then(() => {
        release();
        reject(reason);
      }, (error: unknown) => {
        release();
        reject(error instanceof Error ? error : reason);
      });
    };
    worker.once("message", finish);
    worker.once("error", error => finish({ error: error.message }));
    worker.once("exit", code => {
      if (!settled) finish({ error: `managed artifact publication worker exited without a result (code ${code})` }, true);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Publish an immutable group in bounded worker concurrency. A failure aborts
 * and observes every outstanding worker before returning; installed leaves
 * remain uncatalogued for identity-bound orphan repair. */
export async function publishManagedArtifactContentsAsync(
  dataDir: string,
  projectId: string,
  inputs: readonly ManagedArtifactBatchInput[],
  concurrency = 4,
  signal?: AbortSignal,
): Promise<Array<Omit<ManagedArtifactFile, "body">>> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("managed artifact worker concurrency must be between 1 and 16");
  }
  const ids = new Set<string>();
  for (const { artifactId } of inputs) {
    if (ids.has(artifactId)) {
      throw new Error("managed artifact batch identities must be unique");
    }
    ids.add(artifactId);
  }
  if (inputs.length === 0) return [];
  const chunks: Array<{ start: number; inputs: ManagedArtifactBatchInput[] }> = [];
  let chunk: ManagedArtifactBatchInput[] = [];
  let chunkBytes = 0;
  let chunkStart = 0;
  for (const item of inputs) {
    const bytes = Buffer.isBuffer(item.input)
      ? item.input.length
      : Buffer.byteLength(item.input, "utf8");
    if (chunk.length && (chunk.length >= 128 || chunkBytes + bytes > 8 * 1024 * 1024)) {
      chunks.push({ start: chunkStart, inputs: chunk });
      chunkStart += chunk.length;
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(item);
    chunkBytes += bytes;
  }
  if (chunk.length) chunks.push({ start: chunkStart, inputs: chunk });
  const controller = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const results =
    new Array<Omit<ManagedArtifactFile, "body">>(inputs.length);
  let nextIndex = 0;
  let firstError: unknown;
  const publishNext = async (): Promise<void> => {
    while (!firstError) {
      const index = nextIndex++;
      if (index >= chunks.length) return;
      const chunk = chunks[index]!;
      try {
        const published = await publishManagedArtifactChunkAsync(
          dataDir,
          projectId,
          chunk.inputs,
          combinedSignal,
        );
        published.forEach((result, offset) => { results[chunk.start + offset] = result; });
      } catch (error) {
        firstError ??= error;
        controller.abort(error);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, chunks.length) },
      () => publishNext(),
    ),
  );
  if (firstError) throw firstError;
  return results;
}

/**
 * Publish immutable Project-owned bytes before any catalog metadata can point
 * at them. A completed call has fsynced the file, atomically installed it, and
 * fsynced its parent directory. Repeating the same identity is idempotent;
 * conflicting bytes fail closed.
 */
export function publishManagedArtifactContent(
  dataDir: string,
  projectId: string,
  artifactId: string,
  input: Buffer | string,
): Omit<ManagedArtifactFile, "body"> {
  if (!safeArtifactId(artifactId)) throw new Error("managed artifact id must be a single safe leaf");
  if (!safeProjectId(projectId)) throw new Error("managed artifact Project id must be a single safe leaf");
  const body = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  if (body.length < 1 || body.length > MANAGED_ARTIFACT_MAX_BYTES) {
    throw new Error("managed artifact must contain 1 to 64 MiB");
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  const activeKey = publicationKey(dataDir, projectId, artifactId);
  if (activePublications.has(activeKey)) throw new Error("managed artifact publication is already active");
  activePublications.add(activeKey);
  try {
    return publishManagedArtifactContentNative(
      dataDir,
      projectId,
      artifactId,
      body,
      sha256,
    ).result;
  } finally {
    activePublications.delete(activeKey);
  }
}

/** Publish immutable blobs through the native cross-platform authority before
 * catalog metadata can point at them. Each leaf is independently durable. */
export async function publishManagedArtifactContents(
  dataDir: string,
  projectId: string,
  inputs: readonly ManagedArtifactBatchInput[],
  concurrency = 12,
): Promise<Array<Omit<ManagedArtifactFile, "body">>> {
  if (!safeProjectId(projectId)) {
    throw new Error("managed artifact Project id must be a single safe leaf");
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("managed artifact publication concurrency must be between 1 and 32");
  }
  const ids = new Set<string>();
  const planned = inputs.map(({ artifactId, input }) => {
    if (!safeArtifactId(artifactId)) {
      throw new Error("managed artifact id must be a single safe leaf");
    }
    if (ids.has(artifactId)) {
      throw new Error("managed artifact batch identities must be unique");
    }
    ids.add(artifactId);
    const body = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
    if (body.length < 1 || body.length > MANAGED_ARTIFACT_MAX_BYTES) {
      throw new Error("managed artifact must contain 1 to 64 MiB");
    }
    return {
      artifactId,
      body,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  });
  if (planned.length === 0) return [];
  const activeKeys = planned.map((item) =>
    publicationKey(dataDir, projectId, item.artifactId)
  );
  if (activeKeys.some((key) => activePublications.has(key))) {
    throw new Error("managed artifact publication is already active");
  }
  for (const key of activeKeys) activePublications.add(key);
  try {
    return planned.map((item) => publishManagedArtifactContentNative(
      dataDir,
      projectId,
      item.artifactId,
      item.body,
      item.sha256,
    ).result);
  } finally {
    for (const key of activeKeys) activePublications.delete(key);
  }
}

/** Remove one uncatalogued publication only when its retained identity and
 * immutable contents still match the caller's completed publication. */
export function removeManagedArtifactContent(
  dataDir: string,
  projectId: string,
  artifactId: string,
  expectedSize: number,
  expectedSha256: string,
): boolean {
  if (!safeProjectId(projectId) || !safeArtifactId(artifactId) ||
      activePublications.has(publicationKey(dataDir, projectId, artifactId))) {
    return false;
  }
  const entries = listSecureDirectory({
    root: dataDir,
    relativePath: nativeManagedDirectory(projectId),
  });
  const entry = entries?.find((candidate) =>
    candidate.kind === "file" && candidate.name === artifactId
  );
  if (!entry || !readManagedArtifactContent(
    dataDir,
    projectId,
    artifactId,
    expectedSize,
    expectedSha256,
  )) {
    return false;
  }
  return removeSecureFile({
    root: dataDir,
    relativeDirectory: nativeManagedDirectory(projectId),
    leaf: artifactId,
    expectedIdentity: entry.identity,
  });
}

/** Remove aged regular blobs not owned by any rebuilt durable reference. The
 * retained directory descriptor and in-process publication reservation close
 * both ancestor-swap and startup/concurrent-publication deletion windows. */
export function repairManagedArtifactContent(
  dataDir: string,
  projectId: string,
  referencedArtifactIds: ReadonlySet<string>,
  graceBoundaryMs: number,
): string[] {
  if (!safeProjectId(projectId)) return [];
  const entries = listSecureDirectory({
    root: dataDir,
    relativePath: nativeManagedDirectory(projectId),
  });
  if (!entries) return [];
  const removed: string[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (entry.kind !== "file" || !safeArtifactId(name) ||
        referencedArtifactIds.has(name) ||
        publicationLeafIsActive(dataDir, projectId, name) ||
        entry.modifiedMs >= graceBoundaryMs) continue;
    try {
      if (referencedArtifactIds.has(name) ||
          publicationLeafIsActive(dataDir, projectId, name)) continue;
      if (removeSecureFile({
        root: dataDir,
        relativeDirectory: nativeManagedDirectory(projectId),
        leaf: name,
        expectedIdentity: entry.identity,
      })) {
        removed.push(name);
      }
    } catch {
      // A concurrent publication, repair, or Project teardown may resolve it.
      // Identity mismatches preserve the replacement and any quarantined leaf.
    }
  }
  return removed;
}

/** Read immutable managed bytes only through verified retained descriptors. */
export function readManagedArtifactContent(
  dataDir: string,
  projectId: string,
  artifactId: string,
  expectedSize: number,
  expectedSha256: string,
): ManagedArtifactFile | undefined {
  if (!safeArtifactId(artifactId) || !safeProjectId(projectId)) return undefined;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MANAGED_ARTIFACT_MAX_BYTES ||
      !/^[a-f0-9]{64}$/u.test(expectedSha256)) return undefined;
  try {
    const file = managedArtifactContentPath(dataDir, projectId, artifactId);
    const body = readSecureFile({
      root: dataDir,
      relativePath: nativeManagedFile(projectId, artifactId),
      maxBytes: expectedSize,
      requireNonEmpty: true,
    });
    if (!body || body.length !== expectedSize) return undefined;
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 !== expectedSha256) return undefined;
    return { path: file, body, size: body.length, sha256 };
  } catch {
    return undefined;
  }
}

const MANAGED_ARTIFACT_READ_CHUNK_BYTES = 256 * 1024;

/**
 * Read and verify one managed blob into retained in-memory bytes. Secure reading
 * enforces the expected size and SHA-256 digest before the handle is returned,
 * so every later range or stream comes from those exact verified bytes even if
 * the source file changes afterward.
 */
export async function openManagedArtifactContent(
  dataDir: string,
  projectId: string,
  artifactId: string,
  expectedSize: number,
  expectedSha256: string,
  options?: { signal?: AbortSignal },
): Promise<ManagedArtifactContentHandle | undefined> {
  if (!safeArtifactId(artifactId) || !safeProjectId(projectId)) return undefined;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MANAGED_ARTIFACT_MAX_BYTES ||
      !/^[a-f0-9]{64}$/u.test(expectedSha256)) return undefined;
  const signal = options?.signal;
  signal?.throwIfAborted();
  const file = managedArtifactContentPath(dataDir, projectId, artifactId);
  const body = await readSecureFileAsync({
    root: dataDir,
    relativePath: nativeManagedFile(projectId, artifactId),
    maxBytes: expectedSize,
    requireNonEmpty: true,
    expectedSize,
    expectedSha256,
  }, signal);
  if (!body) return undefined;
  signal?.throwIfAborted();
  let closed = false;
  const close = async (): Promise<void> => {
    closed = true;
  };
  const readRange = async (
    maxBytes: number,
    readSignal?: AbortSignal,
  ): Promise<Buffer> => {
    if (closed) throw new Error("managed artifact handle is closed");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error("managed artifact range must be bounded");
    }
    readSignal?.throwIfAborted();
    const range = Buffer.from(
      body.subarray(0, Math.min(expectedSize, maxBytes)),
    );
    readSignal?.throwIfAborted();
    return range;
  };
  const createReadStream = (readSignal?: AbortSignal): Readable => {
    if (closed) throw new Error("managed artifact handle is closed");
    const stream = Readable.from(
      (async function* streamVerifiedManagedArtifact() {
        for (let offset = 0; offset < body.length;
          offset += MANAGED_ARTIFACT_READ_CHUNK_BYTES) {
          readSignal?.throwIfAborted();
          await new Promise<void>((resolve) => setImmediate(resolve));
          yield body.subarray(
            offset,
            Math.min(body.length, offset + MANAGED_ARTIFACT_READ_CHUNK_BYTES),
          );
        }
      })(),
    );
    const abort = (): void => {
      stream.destroy(readSignal?.reason instanceof Error
        ? readSignal.reason
        : new Error("managed artifact transfer aborted"));
    };
    if (readSignal?.aborted) abort();
    else readSignal?.addEventListener("abort", abort, { once: true });
    const cleanup = (): void => {
      readSignal?.removeEventListener("abort", abort);
    };
    stream.once("close", cleanup).once("error", cleanup);
    return stream;
  };
  return {
    path: file,
    size: expectedSize,
    sha256: expectedSha256,
    readRange,
    createReadStream,
    close,
  };
}
