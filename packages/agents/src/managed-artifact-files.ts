import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { managedArtifactContentPath, managedArtifactsDir } from "./paths.js";

export const MANAGED_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

export interface ManagedArtifactFile {
  path: string;
  body: Buffer;
  size: number;
  sha256: string;
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function verifiedContentDirectory(dataDir: string, projectId: string): string | undefined {
  try {
    const contentDirectory = path.join(managedArtifactsDir(dataDir, projectId), "content");
    const root = realpathSync(dataDir);
    const actualDirectory = realpathSync(contentDirectory);
    if (actualDirectory !== path.join(root, "projects", projectId, "artifacts", "content")) return undefined;
    for (const ancestor of [
      path.join(dataDir, "projects"),
      path.join(dataDir, "projects", projectId),
      managedArtifactsDir(dataDir, projectId),
      contentDirectory,
    ]) {
      const info = lstatSync(ancestor);
      if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    }
    return actualDirectory;
  } catch {
    return undefined;
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
  if (!artifactId || path.basename(artifactId) !== artifactId || artifactId === "." || artifactId === "..") {
    throw new Error("managed artifact id must be a single safe leaf");
  }
  const body = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  if (body.length < 1 || body.length > MANAGED_ARTIFACT_MAX_BYTES) {
    throw new Error("managed artifact must contain 1 to 64 MiB");
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  const destination = managedArtifactContentPath(dataDir, projectId, artifactId);
  const directory = path.dirname(destination);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const actualDirectory = verifiedContentDirectory(dataDir, projectId);
  if (!actualDirectory || destination !== path.join(actualDirectory, artifactId)) {
    throw new Error("managed artifact directory is unsafe");
  }

  let destinationExists = false;
  try { lstatSync(destination); destinationExists = true; }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (destinationExists) {
    const existing = readManagedArtifactContent(dataDir, projectId, artifactId, body.length, sha256);
    if (!existing) throw new Error("managed artifact identity collision or unsafe existing leaf");
    return { path: destination, size: body.length, sha256 };
  }

  const temporary = path.join(directory, `.${artifactId}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeAll(descriptor, body);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    fsyncDirectory(directory);
    return { path: destination, size: body.length, sha256 };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Read immutable managed bytes only through the verified opened descriptor. */
export function readManagedArtifactContent(
  dataDir: string,
  projectId: string,
  artifactId: string,
  expectedSize: number,
  expectedSha256: string,
  faults?: { afterOpen?: (path: string) => void },
): ManagedArtifactFile | undefined {
  if (!artifactId || path.basename(artifactId) !== artifactId || artifactId === "." || artifactId === "..") {
    return undefined;
  }
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MANAGED_ARTIFACT_MAX_BYTES ||
      !/^[a-f0-9]{64}$/u.test(expectedSha256)) return undefined;
  let descriptor: number | undefined;
  try {
    const actualDirectory = verifiedContentDirectory(dataDir, projectId);
    if (!actualDirectory) return undefined;
    const file = managedArtifactContentPath(dataDir, projectId, artifactId);
    if (file !== path.join(actualDirectory, artifactId)) return undefined;
    descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size !== expectedSize) return undefined;
    faults?.afterOpen?.(file);
    const body = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || body.length !== before.size) return undefined;
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 !== expectedSha256) return undefined;
    return { path: file, body, size: body.length, sha256 };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
