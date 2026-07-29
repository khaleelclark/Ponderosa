import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ReadinessCheckDto } from "@ponderosa/core";
import {
  listSecureDirectory,
  readSecureFile,
  removeSecureFile,
  secureFileAuthoritySupported,
  writeSecureFileAtomic,
} from "@ponderosa/native-host";

export type WorkspaceArtifactReadPurpose = "generated_capture" | "legacy_pdf";

export interface WorkspaceArtifactReadFaults {
  afterPathValidation?: (context: WorkspaceArtifactReadContext) => void;
  afterFileOpen?: (context: WorkspaceArtifactReadContext) => void;
}

export interface WorkspaceArtifactReadContext {
  purpose: WorkspaceArtifactReadPurpose;
  rootPath: string;
  relativePath: string;
}

export interface SafeProjectFile {
  body: Buffer;
  name: string;
  relativePath: string;
}

interface OpenedProjectPath {
  descriptors: number[];
  identities: Array<{ dev: number; ino: number }>;
  fileDescriptor: number;
}

interface OpenedProjectRoot {
  descriptor: number;
  identity: { dev: number; ino: number };
  realPath: string;
}

function descriptorPath(descriptor: number, leaf?: string): string {
  const root = `/proc/self/fd/${descriptor}`;
  return leaf === undefined ? root : path.join(root, leaf);
}

function closeDescriptors(descriptors: readonly number[]): void {
  for (const descriptor of [...descriptors].reverse()) {
    try { closeSync(descriptor); }
    catch { /* a failed open may already have released the descriptor */ }
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function relativeProjectPath(rootPath: string, rootReal: string, requestedPath: string): string | undefined {
  const nominalRoot = path.resolve(rootPath);
  const requested = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(rootReal, requestedPath);
  const relative = isWithin(rootReal, requested)
    ? path.relative(rootReal, requested)
    : isWithin(nominalRoot, requested)
      ? path.relative(nominalRoot, requested)
      : undefined;
  if (!relative || path.isAbsolute(relative)) return undefined;
  const components = relative.split(path.sep);
  if (components.some((component) => !component || component === "." || component === "..")) return undefined;
  return components.join(path.sep);
}

function openProjectRoot(rootPath: string): OpenedProjectRoot {
  if (process.platform !== "linux") {
    throw new Error("safe Project file reads require Linux descriptor-relative filesystem access");
  }
  const descriptor = openSync(
    rootPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const realPath = realpathSync(descriptorPath(descriptor));
    if (realPath !== realpathSync(rootPath)) throw new Error("Project root changed while opening");
    const rootInfo = fstatSync(descriptor);
    if (!rootInfo.isDirectory()) throw new Error("Project root is not a directory");
    return { descriptor, identity: { dev: rootInfo.dev, ino: rootInfo.ino }, realPath };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function openProjectPathFromRoot(root: OpenedProjectRoot, relativePath: string): OpenedProjectPath {
  const descriptors = [root.descriptor];
  const identities = [root.identity];
  try {
    const components = relativePath.split(path.sep);
    let parentDescriptor = root.descriptor;
    for (const component of components.slice(0, -1)) {
      const descriptor = openSync(
        descriptorPath(parentDescriptor, component),
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      descriptors.push(descriptor);
      const info = fstatSync(descriptor);
      if (!info.isDirectory()) throw new Error("Project path component is not a directory");
      if (info.dev !== root.identity.dev) {
        throw new Error("Project path crosses a filesystem boundary");
      }
      identities.push({ dev: info.dev, ino: info.ino });
      parentDescriptor = descriptor;
    }

    const fileDescriptor = openSync(
      descriptorPath(parentDescriptor, components.at(-1)!),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    descriptors.push(fileDescriptor);
    const fileInfo = fstatSync(fileDescriptor);
    if (fileInfo.dev !== root.identity.dev) {
      throw new Error("Project file crosses a filesystem boundary");
    }
    identities.push({ dev: fileInfo.dev, ino: fileInfo.ino });
    return { descriptors, identities, fileDescriptor };
  } catch (error) {
    closeDescriptors(descriptors);
    throw error;
  }
}

function openProjectPath(rootPath: string, relativePath: string): OpenedProjectPath {
  return openProjectPathFromRoot(openProjectRoot(rootPath), relativePath);
}

function projectPathStillCurrent(rootReal: string, relativePath: string, expected: OpenedProjectPath): boolean {
  let current: OpenedProjectPath | undefined;
  try {
    current = openProjectPath(rootReal, relativePath);
    return current.identities.length === expected.identities.length && current.identities.every((identity, index) =>
      identity.dev === expected.identities[index]!.dev && identity.ino === expected.identities[index]!.ino);
  } catch {
    return false;
  } finally {
    if (current) closeDescriptors(current.descriptors);
  }
}

/**
 * Read one workspace-derived file through a retained Project-root descriptor.
 * Every ancestor is opened component-by-component with O_DIRECTORY/O_NOFOLLOW,
 * and the complete chain is revalidated after the read. Pathname validation is
 * never used as authority for the bytes returned.
 */
export function readWorkspaceArtifactFile(input: {
  rootPath: string;
  requestedPath: string;
  purpose: WorkspaceArtifactReadPurpose;
  maxBytes: number;
  requireNonEmpty?: boolean;
  faults?: WorkspaceArtifactReadFaults;
}): SafeProjectFile | undefined {
  if (process.platform !== "linux") {
    if (!secureFileAuthoritySupported()) return undefined;
    try {
      const rootReal = realpathSync(input.rootPath);
      const relativePath = relativeProjectPath(
        input.rootPath,
        rootReal,
        input.requestedPath,
      );
      if (!relativePath) return undefined;
      const context = {
        purpose: input.purpose,
        rootPath: rootReal,
        relativePath,
      } as const;
      input.faults?.afterPathValidation?.(context);
      const body = readSecureFile({
        root: input.rootPath,
        relativePath,
        maxBytes: input.maxBytes,
        requireNonEmpty: input.requireNonEmpty,
      });
      if (!body) return undefined;
      input.faults?.afterFileOpen?.(context);
      return {
        body,
        name: path.basename(relativePath),
        relativePath: relativePath.replaceAll(path.sep, "/"),
      };
    } catch {
      return undefined;
    }
  }
  let root: OpenedProjectRoot | undefined;
  let opened: OpenedProjectPath | undefined;
  try {
    root = openProjectRoot(input.rootPath);
    const rootReal = root.realPath;
    const relativePath = relativeProjectPath(input.rootPath, rootReal, input.requestedPath);
    if (!relativePath) return undefined;
    const context = { purpose: input.purpose, rootPath: rootReal, relativePath } as const;
    input.faults?.afterPathValidation?.(context);
    const retainedRoot = root;
    root = undefined;
    opened = openProjectPathFromRoot(retainedRoot, relativePath);
    const before = fstatSync(opened.fileDescriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > input.maxBytes ||
        (input.requireNonEmpty === true && before.size < 1)) return undefined;
    input.faults?.afterFileOpen?.(context);
    const body = readFileSync(opened.fileDescriptor);
    const after = fstatSync(opened.fileDescriptor);
    if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || body.length !== before.size) return undefined;
    if (!projectPathStillCurrent(rootReal, relativePath, opened)) return undefined;
    return { body, name: path.basename(relativePath), relativePath: relativePath.replaceAll(path.sep, "/") };
  } catch {
    return undefined;
  } finally {
    if (opened) closeDescriptors(opened.descriptors);
    else if (root) closeSync(root.descriptor);
  }
}

/** Production preflight for retained-root Project reads plus managed
 * publication, enumeration, and removal on the current native host. */
export function descriptorRelativeFilesystemCapability(dataDir: string): ReadinessCheckDto {
  if (!secureFileAuthoritySupported()) {
    return { ok: false, detail: `secure artifact filesystem is unsupported on ${process.platform}` };
  }
  const generation = randomUUID();
  const leaf = `.ponderosa-authority-${generation}`;
  const temporaryLeaf = `${leaf}.tmp`;
  let installed = false;
  try {
    writeSecureFileAtomic({
      root: dataDir,
      leaf,
      temporaryLeaf,
      body: Buffer.from("ponderosa-secure-authority\n"),
    });
    installed = true;
    const body = readSecureFile({
      root: dataDir,
      relativePath: leaf,
      maxBytes: 64,
      requireNonEmpty: true,
    });
    if (body?.toString() !== "ponderosa-secure-authority\n") {
      throw new Error("retained-root read did not return the exact published bytes");
    }
    if (!listSecureDirectory({ root: dataDir })?.some((entry) =>
      entry.name === leaf && entry.kind === "file")) {
      throw new Error("retained-root enumeration did not observe the published leaf");
    }
    if (!removeSecureFile({ root: dataDir, leaf })) {
      throw new Error("retained-root removal did not remove the published leaf");
    }
    installed = false;
    return {
      ok: true,
      detail: `${process.platform} retained-root no-follow read/write/list/remove authority is available`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `secure artifact filesystem authority failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (installed) {
      try { removeSecureFile({ root: dataDir, leaf }); }
      catch { /* readiness remains failed and the dot-prefixed leaf is inert */ }
    }
  }
}
