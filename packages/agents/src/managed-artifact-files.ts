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
 * independently written and fsynced before any destination name is installed;
 * all destination entries are then made durable by one parent-directory fsync.
 * A failed in-process publication removes every new leaf before returning.
 *
 * The bounded writers overlap independent data fsync latency without weakening
 * the guarantee provided by publishManagedArtifactContent.
 */
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
      size: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      temporaryLeaf: undefined as string | undefined,
      installed: false,
      existing: false,
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
): string[] {
  if (!existsSync(path.dirname(managedArtifactContentPath(dataDir, projectId, "leaf")))) return [];
  let opened: OpenedManagedDirectory | undefined;
  const removed: string[] = [];
  try {
    opened = openManagedDirectory(dataDir, projectId, false);
    for (const name of readdirSync(descriptorPath(opened.directoryDescriptor))) {
      if (!safeArtifactId(name) || referencedArtifactIds.has(name) ||
          managedLeafIsActive(dataDir, projectId, name)) continue;
      let descriptor: number | undefined;
      try {
        descriptor = openSync(
          descriptorPath(opened.directoryDescriptor, name),
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        const info = fstatSync(descriptor);
        if (!info.isFile() || info.dev !== opened.identities[0]!.dev ||
            info.mtimeMs >= graceBoundaryMs) continue;
        if (!sameManagedDirectory(dataDir, projectId, opened) || referencedArtifactIds.has(name) ||
            managedLeafIsActive(dataDir, projectId, name)) continue;
        rmSync(descriptorPath(opened.directoryDescriptor, name));
        fsyncSync(opened.directoryDescriptor);
        removed.push(name);
      } catch {
        // A concurrent publication or repair may have resolved the leaf.
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    return removed;
  } finally {
    closeManagedDirectory(opened);
  }
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
  if (!safeArtifactId(artifactId)) return undefined;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MANAGED_ARTIFACT_MAX_BYTES ||
      !/^[a-f0-9]{64}$/u.test(expectedSha256)) return undefined;
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
