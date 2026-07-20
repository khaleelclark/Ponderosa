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
} from "node:fs";
import path from "node:path";
import { managedArtifactContentPath } from "./paths.js";

export const MANAGED_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

export interface ManagedArtifactFile {
  path: string;
  body: Buffer;
  size: number;
  sha256: string;
}

export interface ManagedArtifactPublicationFaults {
  afterTemporaryOpen?: (path: string) => void;
  beforeRename?: (path: string) => void;
  afterRename?: (path: string) => void;
}

interface OpenedManagedDirectory {
  descriptors: number[];
  identities: Array<{ dev: number; ino: number }>;
  directoryDescriptor: number;
  nominalPath: string;
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
          publicationLeafIsActive(dataDir, projectId, name)) continue;
      let descriptor: number | undefined;
      try {
        descriptor = openSync(
          descriptorPath(opened.directoryDescriptor, name),
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        const info = fstatSync(descriptor);
        if (!info.isFile() || info.mtimeMs >= graceBoundaryMs) continue;
        if (!sameManagedDirectory(dataDir, projectId, opened) || referencedArtifactIds.has(name) ||
            publicationLeafIsActive(dataDir, projectId, name)) continue;
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
    if (!before.isFile() || before.nlink !== 1 || before.size !== expectedSize) return undefined;
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
