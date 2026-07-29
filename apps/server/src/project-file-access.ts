import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import type { ReadinessCheckDto } from "@ponderosa/core";

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
  // macOS and Windows remain fail-closed until Project registration owns a
  // retained native root authority. Reopening a validated root pathname here
  // would permit rename-and-replacement races.
  if (process.platform !== "linux") return undefined;
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

/** Production preflight for the Linux procfs descriptor bridge used by all
 * managed and workspace-derived artifact operations. */
export function descriptorRelativeFilesystemCapability(dataDir: string): ReadinessCheckDto {
  if (process.platform === "darwin") {
    return {
      ok: false,
      detail: "macOS retained-root Project and managed-artifact filesystem authority is not yet implemented",
    };
  }
  if (process.platform === "win32") {
    return {
      ok: false,
      detail: "Windows retained-handle reparse-safe filesystem authority is not yet implemented",
    };
  }
  if (process.platform !== "linux") {
    return { ok: false, detail: `secure artifact filesystem is unsupported on ${process.platform}` };
  }
  let descriptor: number | undefined;
  let relativeDescriptor: number | undefined;
  try {
    const rootReal = realpathSync(dataDir);
    descriptor = openSync(
      rootReal,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const descriptorReal = realpathSync(descriptorPath(descriptor));
    if (descriptorReal !== rootReal) throw new Error("descriptor did not resolve to the opened data directory");
    const info = fstatSync(descriptor);
    if (!info.isDirectory()) throw new Error("opened data directory is not a directory");
    relativeDescriptor = openSync(
      `${descriptorPath(descriptor)}/.`,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const relativeInfo = fstatSync(relativeDescriptor);
    if (!relativeInfo.isDirectory() || relativeInfo.dev !== info.dev || relativeInfo.ino !== info.ino) {
      throw new Error("descriptor-relative procfs traversal did not preserve the opened directory");
    }
    return { ok: true, detail: "Linux /proc/self/fd descriptor-relative artifact access is available" };
  } catch (error) {
    return {
      ok: false,
      detail: `artifact filesystem requires visible Linux /proc/self/fd: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (relativeDescriptor !== undefined) closeSync(relativeDescriptor);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
