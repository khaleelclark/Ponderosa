import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  promises as fs,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
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

export interface ManagedArtifactAsyncReadFaults {
  afterOpen?: (path: string) => void | Promise<void>;
  afterSnapshotOpen?: (path: string) => void | Promise<void>;
  afterVerification?: (path: string) => void | Promise<void>;
}

export interface ManagedArtifactPublicationFaults {
  afterTemporaryOpen?: (path: string) => void;
  beforeRename?: (path: string) => void;
  afterRename?: (path: string) => void;
}

export interface ManagedArtifactBatchInput {
  artifactId: string;
  input: Buffer | string;
}

export interface ManagedArtifactBatchFaults {
  afterItem?: (artifactId: string, path: string) => void;
}

interface OpenedManagedDirectory {
  descriptors: number[];
  identities: Array<{ dev: number; ino: number }>;
  directoryDescriptor: number;
  nominalPath: string;
}

const SAFE_LEAF = /^[A-Za-z0-9_-]{1,128}$/u;
const activePublications = new Set<string>();
const activeSnapshots = new Set<string>();

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

function snapshotKey(dataDir: string, projectId: string, leaf: string): string {
  return `${path.resolve(dataDir)}\0${projectId}\0${leaf}`;
}

function managedLeafIsActive(dataDir: string, projectId: string, leaf: string): boolean {
  return publicationLeafIsActive(dataDir, projectId, leaf) ||
    activeSnapshots.has(snapshotKey(dataDir, projectId, leaf));
}

function descriptorPath(descriptor: number, leaf?: string): string {
  const root = `/proc/self/fd/${descriptor}`;
  return leaf === undefined ? root : path.join(root, leaf);
}

function safeProjectId(projectId: string): boolean {
  return SAFE_LEAF.test(projectId) && path.basename(projectId) === projectId;
}

function closeManagedDirectory(opened: OpenedManagedDirectory | undefined): void {
  if (!opened) return;
  for (const descriptor of [...opened.descriptors].reverse()) {
    try { closeSync(descriptor); }
    catch { /* already closed after a failed open */ }
  }
}

/**
 * Open every managed-path component relative to a retained parent descriptor.
 * Node does not expose openat(2), so Linux procfs descriptor links are the only
 * supported equivalent. Failing closed on other platforms is intentional: a
 * pathname-only check cannot make an ancestor swap safe.
 */
function openManagedDirectory(dataDir: string, projectId: string, create: boolean): OpenedManagedDirectory {
  if (process.platform !== "linux" || !existsSync("/proc/self/fd") || !safeProjectId(projectId)) {
    throw new Error("safe managed artifact paths require Linux descriptor-relative filesystem access");
  }
  const descriptors: number[] = [];
  const identities: Array<{ dev: number; ino: number }> = [];
  try {
    const rootDescriptor = openSync(
      dataDir,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    descriptors.push(rootDescriptor);
    const actualRoot = realpathSync(descriptorPath(rootDescriptor));
    if (actualRoot !== realpathSync(dataDir)) throw new Error("managed artifact root changed while opening");
    const rootInfo = fstatSync(rootDescriptor);
    if (!rootInfo.isDirectory()) throw new Error("managed artifact root is not a directory");
    identities.push({ dev: rootInfo.dev, ino: rootInfo.ino });

    let parentDescriptor = rootDescriptor;
    for (const component of ["projects", projectId, "artifacts", "content"]) {
      const childPath = descriptorPath(parentDescriptor, component);
      if (create) {
        try { mkdirSync(childPath, { mode: 0o700 }); }
        catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
        }
      }
      const childDescriptor = openSync(
        childPath,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      descriptors.push(childDescriptor);
      const childInfo = fstatSync(childDescriptor);
      if (!childInfo.isDirectory()) throw new Error("managed artifact path component is not a directory");
      if (childInfo.dev !== rootInfo.dev) {
        throw new Error("managed artifact path crosses a filesystem boundary");
      }
      identities.push({ dev: childInfo.dev, ino: childInfo.ino });
      parentDescriptor = childDescriptor;
    }
    return {
      descriptors,
      identities,
      directoryDescriptor: parentDescriptor,
      nominalPath: path.dirname(managedArtifactContentPath(dataDir, projectId, "leaf")),
    };
  } catch (error) {
    closeManagedDirectory({ descriptors, identities, directoryDescriptor: -1, nominalPath: "" });
    throw error;
  }
}

function sameManagedDirectory(
  dataDir: string,
  projectId: string,
  expected: OpenedManagedDirectory,
): boolean {
  let current: OpenedManagedDirectory | undefined;
  try {
    current = openManagedDirectory(dataDir, projectId, false);
    return current.identities.length === expected.identities.length && current.identities.every((identity, index) =>
      identity.dev === expected.identities[index]!.dev && identity.ino === expected.identities[index]!.ino);
  } catch {
    return false;
  } finally {
    closeManagedDirectory(current);
  }
}

function writeAll(descriptor: number, body: Buffer): void {
  let offset = 0;
  while (offset < body.length) {
    const written = writeSync(descriptor, body, offset, body.length - offset);
    if (written <= 0) throw new Error("managed artifact write made no progress");
    offset += written;
  }
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

function useNativeManagedAuthority(): boolean {
  return process.platform !== "linux" ||
    process.env.NODE_ENV !== "test" ||
    process.env.PONDEROSA_TEST_LEGACY_LINUX_MANAGED_AUTHORITY !== "1";
}

function publicationWorkerUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("../dist/managed-artifact-publication-worker.js", import.meta.url)
    : new URL("./managed-artifact-publication-worker.js", import.meta.url);
}

function publishManagedArtifactContentNative(
  dataDir: string,
  projectId: string,
  artifactId: string,
  body: Buffer,
  sha256: string,
  faults?: ManagedArtifactPublicationFaults,
): { created: boolean; result: Omit<ManagedArtifactFile, "body"> } {
  const destination = managedArtifactContentPath(dataDir, projectId, artifactId);
  const temporaryLeaf = `.${artifactId}.${randomUUID()}.tmp`;
  faults?.afterTemporaryOpen?.(
    managedArtifactContentPath(dataDir, projectId, temporaryLeaf),
  );
  faults?.beforeRename?.(destination);
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
  faults?.afterRename?.(destination);

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
      if (index >= inputs.length) return;
      const item = inputs[index]!;
      try {
        results[index] = await publishManagedArtifactContentAsync(
          dataDir,
          projectId,
          item.artifactId,
          item.input,
          combinedSignal,
        );
      } catch (error) {
        firstError ??= error;
        controller.abort(error);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, inputs.length) },
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
  faults?: ManagedArtifactPublicationFaults,
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
  const destination = managedArtifactContentPath(dataDir, projectId, artifactId);
  if (useNativeManagedAuthority()) {
    try {
      return publishManagedArtifactContentNative(
        dataDir,
        projectId,
        artifactId,
        body,
        sha256,
        faults,
      ).result;
    } finally {
      activePublications.delete(activeKey);
    }
  }
  let opened: OpenedManagedDirectory | undefined;
  let descriptor: number | undefined;
  let temporaryLeaf: string | undefined;
  try {
    opened = openManagedDirectory(dataDir, projectId, true);
    if (destination !== path.join(opened.nominalPath, artifactId)) {
      throw new Error("managed artifact destination escaped its Project directory");
    }
    const destinationByDescriptor = descriptorPath(opened.directoryDescriptor, artifactId);
    try {
      const existingDescriptor = openSync(destinationByDescriptor, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      closeSync(existingDescriptor);
      const existing = readManagedArtifactContent(dataDir, projectId, artifactId, body.length, sha256);
      if (!existing) throw new Error("managed artifact identity collision or unsafe existing leaf");
      return { path: destination, size: body.length, sha256 };
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }

    temporaryLeaf = `.${artifactId}.${randomUUID()}.tmp`;
    const temporaryByDescriptor = descriptorPath(opened.directoryDescriptor, temporaryLeaf);
    descriptor = openSync(
      temporaryByDescriptor,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    faults?.afterTemporaryOpen?.(path.join(opened.nominalPath, temporaryLeaf));
    writeAll(descriptor, body);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (!sameManagedDirectory(dataDir, projectId, opened)) {
      throw new Error("managed artifact directory changed before atomic publication");
    }
    faults?.beforeRename?.(destination);
    renameSync(temporaryByDescriptor, destinationByDescriptor);
    temporaryLeaf = undefined;
    faults?.afterRename?.(destination);
    fsyncSync(opened.directoryDescriptor);
    if (!sameManagedDirectory(dataDir, projectId, opened)) {
      throw new Error("managed artifact directory changed during atomic publication");
    }
    const published = readManagedArtifactContent(dataDir, projectId, artifactId, body.length, sha256);
    if (!published) throw new Error("managed artifact changed during atomic publication");
    return { path: destination, size: body.length, sha256 };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryLeaf && opened) {
      try { rmSync(descriptorPath(opened.directoryDescriptor, temporaryLeaf), { force: true }); }
      catch { /* the retained directory may already have been removed */ }
    }
    closeManagedDirectory(opened);
    activePublications.delete(activeKey);
  }
}

/**
 * Publish a set of immutable blobs as one durability group. Every file is
 * independently written and fsynced. Linux stages every body before installing
 * destination names; the native authority installs each immutable leaf as one
 * transaction. No caller can advance catalog metadata until the group returns,
 * and a failed in-process publication leaves every native leaf uncatalogued for
 * identity-bound orphan repair. The test-only legacy Linux branch may
 * best-effort remove retained-directory leaves. Neither branch presents
 * rollback as an atomic filesystem group.
 *
 * The bounded writers overlap independent data fsync latency without weakening
 * the guarantee provided by publishManagedArtifactContent.
 */
export async function publishManagedArtifactContents(
  dataDir: string,
  projectId: string,
  inputs: readonly ManagedArtifactBatchInput[],
  concurrency = 12,
  faults?: ManagedArtifactBatchFaults,
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
      size: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      temporaryLeaf: undefined as string | undefined,
      installed: false,
      existing: false,
    };
  });
  if (planned.length === 0) return [];

  if (useNativeManagedAuthority()) {
    const nativeActiveKeys = planned.map((item) =>
      publicationKey(dataDir, projectId, item.artifactId)
    );
    if (nativeActiveKeys.some((key) => activePublications.has(key))) {
      throw new Error("managed artifact publication is already active");
    }
    for (const key of nativeActiveKeys) activePublications.add(key);
    try {
      return planned.map((item) => {
        const published = publishManagedArtifactContentNative(
          dataDir,
          projectId,
          item.artifactId,
          item.body,
          item.sha256,
        );
        faults?.afterItem?.(item.artifactId, published.result.path);
        return published.result;
      });
    } finally {
      // On failure, every newly installed leaf remains uncatalogued. Do not
      // delete by current name without the identity created by this batch;
      // durable orphan repair will enumerate and bind the exact identity.
      for (const key of nativeActiveKeys) activePublications.delete(key);
    }
  }

  const activeKeys = planned.map((item) =>
    publicationKey(dataDir, projectId, item.artifactId)
  );
  if (activeKeys.some((key) => activePublications.has(key))) {
    throw new Error("managed artifact publication is already active");
  }
  for (const key of activeKeys) activePublications.add(key);

  let opened: OpenedManagedDirectory | undefined;
  try {
    opened = openManagedDirectory(dataDir, projectId, true);
    for (const item of planned) {
      const destination = managedArtifactContentPath(
        dataDir,
        projectId,
        item.artifactId,
      );
      if (destination !== path.join(opened.nominalPath, item.artifactId)) {
        throw new Error("managed artifact destination escaped its Project directory");
      }
      let existingDescriptor: number | undefined;
      try {
        existingDescriptor = openSync(
          descriptorPath(opened.directoryDescriptor, item.artifactId),
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        const existing = readManagedArtifactContent(
          dataDir,
          projectId,
          item.artifactId,
          item.size,
          item.sha256,
        );
        if (!existing) {
          throw new Error("managed artifact identity collision or unsafe existing leaf");
        }
        item.existing = true;
      } catch (error) {
        if (
          !error
          || typeof error !== "object"
          || !("code" in error)
          || error.code !== "ENOENT"
        ) throw error;
      } finally {
        if (existingDescriptor !== undefined) closeSync(existingDescriptor);
      }
    }

    let nextIndex = 0;
    const stage = async (): Promise<void> => {
      while (nextIndex < planned.length) {
        const item = planned[nextIndex++]!;
        if (item.existing) continue;
        const temporaryLeaf = `.${item.artifactId}.${randomUUID()}.tmp`;
        item.temporaryLeaf = temporaryLeaf;
        const handle = await fs.open(
          descriptorPath(opened!.directoryDescriptor, temporaryLeaf),
          fsConstants.O_CREAT
            | fsConstants.O_EXCL
            | fsConstants.O_WRONLY
            | fsConstants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(item.body);
          const written = await handle.stat();
          if (!written.isFile() || written.size !== item.size) {
            throw new Error("managed artifact batch write was incomplete");
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    };
    const writers = Array.from(
      { length: Math.min(concurrency, planned.length) },
      () => stage(),
    );
    const staged = await Promise.allSettled(writers);
    const stageFailure = staged.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (stageFailure) throw stageFailure.reason;

    if (!sameManagedDirectory(dataDir, projectId, opened)) {
      throw new Error("managed artifact directory changed before atomic publication");
    }
    for (const item of planned) {
      if (!item.temporaryLeaf) continue;
      renameSync(
        descriptorPath(opened.directoryDescriptor, item.temporaryLeaf),
        descriptorPath(opened.directoryDescriptor, item.artifactId),
      );
      item.temporaryLeaf = undefined;
      item.installed = true;
    }
    fsyncSync(opened.directoryDescriptor);
    if (!sameManagedDirectory(dataDir, projectId, opened)) {
      throw new Error("managed artifact directory changed during atomic publication");
    }
    return planned.map((item) => ({
      path: managedArtifactContentPath(dataDir, projectId, item.artifactId),
      size: item.size,
      sha256: item.sha256,
    }));
  } catch (error) {
    if (opened) {
      let directoryChanged = false;
      for (const item of planned) {
        for (const leaf of [
          item.temporaryLeaf,
          item.installed ? item.artifactId : undefined,
        ]) {
          if (!leaf) continue;
          try {
            await fs.rm(descriptorPath(opened.directoryDescriptor, leaf), {
              force: true,
            });
            directoryChanged = true;
          } catch {
            // The retained directory can disappear during Project teardown.
          }
        }
      }
      if (directoryChanged) {
        try { fsyncSync(opened.directoryDescriptor); }
        catch { /* teardown owns the now-unreachable directory */ }
      }
    }
    throw error;
  } finally {
    closeManagedDirectory(opened);
    for (const key of activeKeys) activePublications.delete(key);
  }
}

/** Remove aged regular blobs not owned by any rebuilt durable reference. The
 * retained directory descriptor and in-process publication reservation close
 * both ancestor-swap and startup/concurrent-publication deletion windows. */
export function repairManagedArtifactContent(
  dataDir: string,
  projectId: string,
  referencedArtifactIds: ReadonlySet<string>,
  graceBoundaryMs: number,
  faults?: { beforeRemove?: (path: string) => void },
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
        managedLeafIsActive(dataDir, projectId, name) ||
        entry.modifiedMs >= graceBoundaryMs) continue;
    try {
      if (referencedArtifactIds.has(name) ||
          managedLeafIsActive(dataDir, projectId, name)) continue;
      faults?.beforeRemove?.(
        managedArtifactContentPath(dataDir, projectId, name),
      );
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
  faults?: { afterOpen?: (path: string) => void },
): ManagedArtifactFile | undefined {
  if (!safeArtifactId(artifactId) || !safeProjectId(projectId)) return undefined;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MANAGED_ARTIFACT_MAX_BYTES ||
      !/^[a-f0-9]{64}$/u.test(expectedSha256)) return undefined;
  if (useNativeManagedAuthority()) {
    try {
      const file = managedArtifactContentPath(dataDir, projectId, artifactId);
      faults?.afterOpen?.(file);
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
  let opened: OpenedManagedDirectory | undefined;
  let descriptor: number | undefined;
  try {
    opened = openManagedDirectory(dataDir, projectId, false);
    const file = managedArtifactContentPath(dataDir, projectId, artifactId);
    if (file !== path.join(opened.nominalPath, artifactId)) return undefined;
    descriptor = openSync(
      descriptorPath(opened.directoryDescriptor, artifactId),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.dev !== opened.identities[0]!.dev ||
        before.nlink !== 1 || before.size !== expectedSize) return undefined;
    faults?.afterOpen?.(file);
    const body = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || body.length !== before.size) return undefined;
    if (!sameManagedDirectory(dataDir, projectId, opened)) return undefined;
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 !== expectedSha256) return undefined;
    return { path: file, body, size: body.length, sha256 };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    closeManagedDirectory(opened);
  }
}

const MANAGED_ARTIFACT_READ_CHUNK_BYTES = 256 * 1024;

function sameOpenedFile(
  before: Awaited<ReturnType<FileHandle["stat"]>>,
  after: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return after.isFile() && after.nlink === 1 && after.dev === before.dev && after.ino === before.ino &&
    after.size === before.size;
}

async function writeAllAsync(handle: FileHandle, body: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < body.length) {
    const { bytesWritten } = await handle.write(body, offset, body.length - offset, position + offset);
    if (bytesWritten < 1) throw new Error("managed artifact snapshot write made no progress");
    offset += bytesWritten;
  }
}

function sameSnapshotFile(
  expected: Awaited<ReturnType<FileHandle["stat"]>>,
  current: Awaited<ReturnType<FileHandle["stat"]>>,
  expectedSize: number,
): boolean {
  return current.isFile() && current.nlink === 0 && current.dev === expected.dev && current.ino === expected.ino &&
    current.size === expectedSize;
}

/**
 * Copy and verify one managed blob into a private, pathless snapshot inode.
 * Copying, SHA-256 work, bounded reads, and transfer streaming remain chunked
 * through libuv. The snapshot's writable handle is closed before this function
 * returns, so every later byte comes from the exact stable inode whose copied
 * bytes matched the ledger digest, even if the source inode is changed in place.
 */
export async function openManagedArtifactContent(
  dataDir: string,
  projectId: string,
  artifactId: string,
  expectedSize: number,
  expectedSha256: string,
  options?: { signal?: AbortSignal; faults?: ManagedArtifactAsyncReadFaults },
): Promise<ManagedArtifactContentHandle | undefined> {
  if (!safeArtifactId(artifactId) || !safeProjectId(projectId)) return undefined;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MANAGED_ARTIFACT_MAX_BYTES ||
      !/^[a-f0-9]{64}$/u.test(expectedSha256)) return undefined;
  const signal = options?.signal;
  if (useNativeManagedAuthority()) {
    signal?.throwIfAborted();
    const file = managedArtifactContentPath(dataDir, projectId, artifactId);
    await options?.faults?.afterOpen?.(file);
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
    try {
      await options?.faults?.afterSnapshotOpen?.(file);
      await options?.faults?.afterVerification?.(file);
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
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
  let opened: OpenedManagedDirectory | undefined;
  let sourceHandle: FileHandle | undefined;
  let snapshotWriter: FileHandle | undefined;
  let snapshotReader: FileHandle | undefined;
  let snapshotLeaf: string | undefined;
  let snapshotActiveKey: string | undefined;
  try {
    signal?.throwIfAborted();
    opened = openManagedDirectory(dataDir, projectId, false);
    const file = managedArtifactContentPath(dataDir, projectId, artifactId);
    if (file !== path.join(opened.nominalPath, artifactId)) return undefined;
    sourceHandle = await fs.open(
      descriptorPath(opened.directoryDescriptor, artifactId),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.dev !== opened.identities[0]!.dev ||
        before.nlink !== 1 || before.size !== expectedSize) return undefined;

    snapshotLeaf = `.${artifactId}.${randomUUID()}.snapshot`;
    snapshotActiveKey = snapshotKey(dataDir, projectId, snapshotLeaf);
    activeSnapshots.add(snapshotActiveKey);
    const snapshotPath = descriptorPath(opened.directoryDescriptor, snapshotLeaf);
    snapshotWriter = await fs.open(
      snapshotPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    snapshotReader = await fs.open(snapshotPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const emptySnapshot = await snapshotReader.stat();
    const writerIdentity = await snapshotWriter.stat();
    if (!emptySnapshot.isFile() || emptySnapshot.nlink !== 1 || emptySnapshot.size !== 0 ||
        writerIdentity.dev !== emptySnapshot.dev || writerIdentity.ino !== emptySnapshot.ino) return undefined;
    await options?.faults?.afterSnapshotOpen?.(path.join(opened.nominalPath, snapshotLeaf));
    await fs.rm(snapshotPath);
    snapshotLeaf = undefined;
    await options?.faults?.afterOpen?.(file);

    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(MANAGED_ARTIFACT_READ_CHUNK_BYTES, expectedSize));
    let position = 0;
    while (position < expectedSize) {
      signal?.throwIfAborted();
      const requested = Math.min(chunk.length, expectedSize - position);
      const { bytesRead } = await sourceHandle.read(chunk, 0, requested, position);
      if (bytesRead < 1) return undefined;
      await writeAllAsync(snapshotWriter, chunk.subarray(0, bytesRead), position);
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    signal?.throwIfAborted();
    const after = await sourceHandle.stat();
    if (!sameOpenedFile(before, after) || position !== expectedSize ||
        !sameManagedDirectory(dataDir, projectId, opened) || digest.digest("hex") !== expectedSha256) return undefined;
    const completedSnapshot = await snapshotReader.stat();
    if (!sameSnapshotFile(emptySnapshot, completedSnapshot, expectedSize)) return undefined;
    await snapshotWriter.close();
    snapshotWriter = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;
    signal?.throwIfAborted();
    await options?.faults?.afterVerification?.(file);

    const retainedHandle = snapshotReader;
    snapshotReader = undefined;
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try { await retainedHandle.close(); }
      catch { /* a stream may already have closed the descriptor */ }
    };
    const readRange = async (maxBytes: number, readSignal?: AbortSignal): Promise<Buffer> => {
      if (closed) throw new Error("managed artifact handle is closed");
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("managed artifact range must be bounded");
      const length = Math.min(expectedSize, maxBytes);
      const body = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        readSignal?.throwIfAborted();
        const { bytesRead } = await retainedHandle.read(body, offset, length - offset, offset);
        if (bytesRead < 1) throw new Error("managed artifact changed during bounded read");
        offset += bytesRead;
      }
      readSignal?.throwIfAborted();
      const current = await retainedHandle.stat();
      if (!sameSnapshotFile(emptySnapshot, current, expectedSize)) {
        throw new Error("managed artifact changed during bounded read");
      }
      return body;
    };
    const createReadStream = (readSignal?: AbortSignal): Readable => {
      if (closed) throw new Error("managed artifact handle is closed");
      const stream = retainedHandle.createReadStream({ autoClose: true, start: 0, end: expectedSize - 1 });
      const abort = (): void => {
        stream.destroy(readSignal?.reason instanceof Error
          ? readSignal.reason
          : new Error("managed artifact transfer aborted"));
      };
      if (readSignal?.aborted) abort();
      else readSignal?.addEventListener("abort", abort, { once: true });
      const cleanup = (): void => {
        readSignal?.removeEventListener("abort", abort);
        void close();
      };
      stream.once("close", cleanup).once("error", cleanup);
      return stream;
    };
    return { path: file, size: expectedSize, sha256: expectedSha256, readRange, createReadStream, close };
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  } finally {
    await sourceHandle?.close().catch(() => undefined);
    await snapshotWriter?.close().catch(() => undefined);
    await snapshotReader?.close().catch(() => undefined);
    if (snapshotLeaf && opened) {
      await fs.rm(descriptorPath(opened.directoryDescriptor, snapshotLeaf), { force: true }).catch(() => undefined);
    }
    if (snapshotActiveKey) activeSnapshots.delete(snapshotActiveKey);
    closeManagedDirectory(opened);
  }
}
