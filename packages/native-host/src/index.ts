import { createRequire } from "node:module";
import { storageNativePath } from "./storage-binding.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

interface NativeJobBinding {
  offlineMetadata(sourceDescriptor: number, targetDescriptor?: number): boolean;
  offlineWorkspaceMetadata(sourceDescriptor: number, targetDescriptor?: number): boolean;
  offlineDirectoryBatch(descriptor: number, cookie: bigint): { names: Buffer[]; next: bigint; done: boolean };
  offlineOpenSpecial(parent: number, leaf: string): number;
  offlineSpecialMetadata(descriptor: number, parent: number, leaf: string): boolean;
  offlineCopySpecial(descriptor: number, parent: number, leaf: string, destinationParent: number, destinationLeaf: string): boolean;
  offlineLinkFile(descriptor: number, parent: number, leaf: string, destinationParent: number, destinationLeaf: string): boolean;
  offlineMountIdentity(descriptor: number): bigint;
  offlineLinkReadMountFlags(descriptor: number): bigint;
  offlineOpenLink(parent: number, leaf: string): number;
  offlineReadLink(descriptor: number, parent: number, leaf: string): Buffer;
  offlineCopyLink(descriptor: number, parent: number, leaf: string, destinationParent: number, destinationLeaf: string, target: Buffer): boolean;
  windowsJobObjectsSupported(): boolean;
  darwinProcessBirthMarker(pid: number): string | null;
  windowsProcessBirthMarker(pid: number): string | null;
  windowsBootIdentity(): string | null;
  createWindowsJob(): unknown;
  assignWindowsJob(job: unknown, pid: number): void;
  terminateWindowsJob(job: unknown): void;
  windowsJobActiveProcesses(job: unknown): number;
  closeWindowsJob(job: unknown): void;
  secureFileAuthoritySupported(): boolean;
  dataDirectoryAuthoritySupported(): boolean;
  acquirePortableDataDirectory(root: string, capabilityPath: string, readOnly?: boolean): unknown;
  adoptPortableDataDirectory(root: string, fd: number, lease?: WindowsDirectoryLeaseTransfer): unknown;
  portableDirectoryLeaseTransfer(value: unknown): WindowsDirectoryLeaseTransfer | null;
  exportPortableDataDirectory(value: unknown): number;
  portableDataDirectoryPath(value: unknown): string;
  releasePortableDataDirectory(value: unknown): void;
  acquireDataDirectoryAuthority(root: string): unknown;
  exportDataDirectoryDescriptor(authority: unknown): number;
  adoptDataDirectoryDescriptor(descriptor: number, root: string): unknown;
  dataDirectoryAuthorityPath(authority: unknown): string;
  releaseDataDirectoryAuthority(authority: unknown): void;
  readSecureFile(root: string, relativePath: string, maxBytes: number, requireNonEmpty: boolean): Buffer | null;
  listSecureDirectory(root: string, relativePath: string): SecureDirectoryEntry[] | null;
  ensureSecureDirectory(root: string, relativePath: string): boolean;
  secureDirectoryIdentity(root: string, relativePath: string): string | null;
  writeSecureFileAtomic(
    root: string,
    relativeDirectory: string,
    leaf: string,
    temporaryLeaf: string,
    body: Buffer,
  ): boolean;
  removeSecureFile(
    root: string,
    relativeDirectory: string,
    leaf: string,
    quarantineLeaf: string,
    expectedIdentity: string,
  ): boolean;
}

export interface SecureDirectoryEntry {
  name: string;
  kind: "file" | "directory";
  size?: number;
  modifiedMs: number;
  identity: string;
}

let loaded: NativeJobBinding | undefined;

function binding(): NativeJobBinding {
  if (loaded) return loaded;
  loaded = createRequire(import.meta.url)(storageNativePath) as NativeJobBinding;
  return loaded;
}

export function windowsJobObjectsSupported(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  try {
    return binding().windowsJobObjectsSupported();
  } catch {
    return false;
  }
}

/** High-resolution, immutable Darwin process start time from proc_pidinfo. */
export function darwinProcessBirthMarker(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "darwin" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const marker = binding().darwinProcessBirthMarker(pid);
    return marker && /^\d+:\d{1,6}$/u.test(marker) ? marker : undefined;
  } catch {
    return undefined;
  }
}

/** Process identity shared by launcher and runtime recovery. A missing or
 * unsupported platform marker must never authorize signalling a reused PID. */
export function hostProcessBirthMarker(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return undefined;
      // The suffix begins at field 3 (state); starttime is field 22.
      const startTime = stat.slice(commandEnd + 2).trim().split(/\s+/u)[19];
      return startTime ? `linux:${startTime}` : undefined;
    } catch { return undefined; }
  }
  if (platform === "darwin") {
    const marker = darwinProcessBirthMarker(pid, platform);
    return marker ? `darwin:${marker}` : undefined;
  }
  if (platform === "win32" && pid <= 0xffffffff) {
    try {
      const marker = binding().windowsProcessBirthMarker(pid);
      return marker && /^[1-9]\d*$/u.test(marker) ? `win32:${marker}` : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

/** System process creation identity, stable through clock changes and PID reuse. */
export function hostBootIdentity(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32") return undefined;
  try {
    const value = binding().windowsBootIdentity();
    return value && /^win32-system:[1-9]\d{0,18}$/u.test(value) ? value : undefined;
  } catch { return undefined; }
}

/**
 * Exact authority over one Windows process tree. The Job is configured with
 * KILL_ON_JOB_CLOSE and does not permit breakaway. Call terminate(), observe
 * activeProcesses() reach zero, and only then close().
 */
export class WindowsProcessJob {
  readonly #authority: unknown;
  #closed = false;

  constructor() {
    if (!windowsJobObjectsSupported()) {
      throw new Error("Windows Job Object process containment is unavailable");
    }
    this.#authority = binding().createWindowsJob();
  }

  assign(pid: number): void {
    if (this.#closed) throw new Error("Windows Job Object is closed");
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Windows Job Object requires a valid process id");
    binding().assignWindowsJob(this.#authority, pid);
  }

  terminate(): void {
    if (!this.#closed) binding().terminateWindowsJob(this.#authority);
  }

  activeProcesses(): number {
    return this.#closed ? 0 : binding().windowsJobActiveProcesses(this.#authority);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    binding().closeWindowsJob(this.#authority);
  }
}

export function dataDirectoryAuthoritySupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!["linux", "darwin", "win32"].includes(platform)) return false;
  try {
    const native = binding();
    return native.dataDirectoryAuthoritySupported() &&
      typeof native.exportDataDirectoryDescriptor === "function" &&
      typeof native.adoptDataDirectoryDescriptor === "function";
  } catch {
    return false;
  }
}

/**
 * A kernel-held exclusive lease on one physical data-directory inode.
 * rootPath is descriptor-backed, so later pathname or ancestor replacement
 * cannot redirect storage opened through this authority.
 */
export interface WindowsDirectoryLeaseTransfer { sourcePid: number; handle: string }
export class DataDirectoryAuthority {
  readonly #authority: unknown;
  get rootPath(): string { return DataDirectoryAuthority.ownedRoot(this); }
  #closed = false;
  readonly #portable = process.platform !== "linux";

  constructor(root: string, inheritedDescriptor?: number, inheritedLease?: WindowsDirectoryLeaseTransfer) {
    if (!dataDirectoryAuthoritySupported()) {
      throw new Error("descriptor-rooted data-directory authority is unavailable");
    }
    assertSafeRoot(root);
    this.#authority = this.#portable
      ? inheritedDescriptor === undefined
        ? binding().acquirePortableDataDirectory(root, path.resolve(path.sep, ".__ponderosa_storage__", randomUUID()))
        : process.platform === "win32" ? binding().adoptPortableDataDirectory(root, inheritedDescriptor, inheritedLease)
          : binding().adoptPortableDataDirectory(root, inheritedDescriptor)
      : inheritedDescriptor === undefined
        ? binding().acquireDataDirectoryAuthority(root)
        : binding().adoptDataDirectoryDescriptor(inheritedDescriptor, root);
    DataDirectoryAuthority.ownedRoot(this);
  }

  static ownedRoot(value: DataDirectoryAuthority): string {
    if (value.#closed) throw new Error("data-directory authority is closed");
    return value.#portable ? binding().portableDataDirectoryPath(value.#authority)
      : binding().dataDirectoryAuthorityPath(value.#authority);
  }

  /** Export for stdio inheritance. All later parent disposal is close-only. */
  exportDescriptor(): number {
    if (this.#closed) throw new Error("data-directory authority is closed");
    return this.#portable ? binding().exportPortableDataDirectory(this.#authority)
      : binding().exportDataDirectoryDescriptor(this.#authority);
  }

  exportLeaseTransfer(): WindowsDirectoryLeaseTransfer | undefined {
    if (this.#closed) throw new Error("data-directory authority is closed");
    return process.platform === "win32" ? binding().portableDirectoryLeaseTransfer(this.#authority) ?? undefined : undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#portable) binding().releasePortableDataDirectory(this.#authority);
    else binding().releaseDataDirectoryAuthority(this.#authority);
  }
}

/** Descriptor-only metadata check/copy for the explicit Linux offline tool.
 * Refuses xattrs/ACLs and special mode bits; preserves uid/gid/mode and exact
 * atime/mtime. Immutable ctime/birth identity is recorded by the tool instead. */
export function offlineMetadata(sourceDescriptor: number, targetDescriptor?: number): void {
  if (process.platform !== "linux" || !Number.isSafeInteger(sourceDescriptor) || sourceDescriptor < 0 ||
      targetDescriptor !== undefined && (!Number.isSafeInteger(targetDescriptor) || targetDescriptor < 0)) {
    throw new Error("invalid offline metadata descriptors");
  }
  const accepted = targetDescriptor === undefined
    ? binding().offlineMetadata(sourceDescriptor)
    : binding().offlineMetadata(sourceDescriptor, targetDescriptor);
  if (!accepted) throw new Error("offline metadata refused");
}

function offlineDescriptor(fd: number): void {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("invalid offline descriptor");
}
function offlineLeaf(leaf: string): void {
  if (!leaf || leaf === "." || leaf === ".." || /[\\/\u0000-\u001f]/u.test(leaf) || Buffer.byteLength(leaf) > 255) throw new Error("invalid offline leaf");
}
export function offlineWorkspaceMetadata(source: number, target?: number): void {
  offlineDescriptor(source); if (target !== undefined) offlineDescriptor(target);
  const accepted = target === undefined ? binding().offlineWorkspaceMetadata(source) : binding().offlineWorkspaceMetadata(source, target);
  if (accepted !== true) throw new Error("offline workspace metadata refused");
}
export function offlineDirectoryBatch(descriptor: number, cookie: bigint): { names: Buffer[]; next: bigint; done: boolean } {
  offlineDescriptor(descriptor);
  if (typeof cookie !== "bigint" || cookie < 0n) throw new Error("invalid offline cookie");
  const page = binding().offlineDirectoryBatch(descriptor, cookie);
  if (!page || !Array.isArray(page.names) || page.names.length > 128 || !page.names.every(value => Buffer.isBuffer(value) && value.length <= 255) ||
      typeof page.next !== "bigint" || page.next < 0n || typeof page.done !== "boolean") throw new Error("invalid offline directory batch evidence");
  return page;
}
export function offlineOpenSpecial(parent: number, leaf: string): number {
  offlineDescriptor(parent); offlineLeaf(leaf); const fd = binding().offlineOpenSpecial(parent, leaf); offlineDescriptor(fd); return fd;
}
export function offlineSpecialMetadata(fd: number, parent: number, leaf: string): void {
  offlineDescriptor(fd); offlineDescriptor(parent); offlineLeaf(leaf);
  if (binding().offlineSpecialMetadata(fd, parent, leaf) !== true) throw new Error("offline special metadata refused");
}
export function offlineCopySpecial(fd: number, parent: number, leaf: string, destination: number, output: string): void {
  offlineDescriptor(fd); offlineDescriptor(parent); offlineDescriptor(destination); offlineLeaf(leaf); offlineLeaf(output);
  if (binding().offlineCopySpecial(fd, parent, leaf, destination, output) !== true) throw new Error("offline special copy refused");
}
export function offlineLinkFile(fd: number, parent: number, leaf: string, destination: number, output: string): void {
  offlineDescriptor(fd); offlineDescriptor(parent); offlineDescriptor(destination); offlineLeaf(leaf); offlineLeaf(output);
  if (binding().offlineLinkFile(fd, parent, leaf, destination, output) !== true) throw new Error("offline clone link refused");
}

/** Physically derived Linux statx mount ID under a held descriptor. Unsupported
 * kernels/headers/filesystems refuse; callers cannot supply admission truth. */
export function offlineMountIdentity(descriptor: number): bigint {
  if (process.platform !== "linux" || !Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new Error("invalid offline mount descriptor");
  }
  const identity = binding().offlineMountIdentity(descriptor);
  if (typeof identity !== "bigint" || identity <= 0n) throw new Error("offline mount evidence unavailable");
  return identity;
}

/** Offline workspace links are retained as inode/link bytes, never followed.
 * Ordinary secure-file and data-directory authority do not use these helpers. */
export function offlineLinkReadMountFlags(descriptor: number): bigint {
  const flags = binding().offlineLinkReadMountFlags(descriptor);
  if (typeof flags !== "bigint" || (flags & 1025n) === 0n) throw new Error("offline link mount policy unavailable");
  return flags;
}
export function offlineOpenLink(parent: number, leaf: string): number {
  const fd = binding().offlineOpenLink(parent, leaf);
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("offline link descriptor unavailable");
  return fd;
}
export function offlineReadLink(descriptor: number, parent: number, leaf: string): Buffer {
  const target = binding().offlineReadLink(descriptor, parent, leaf);
  if (!Buffer.isBuffer(target) || !target.length || target.length > 4096) throw new Error("offline link evidence unavailable");
  return target;
}
export function offlineCopyLink(descriptor: number, parent: number, leaf: string, destinationParent: number, destinationLeaf: string, target: Buffer): void {
  if (!binding().offlineCopyLink(descriptor, parent, leaf, destinationParent, destinationLeaf, target)) throw new Error("offline link copy refused");
}

function assertSafeRoot(root: string): void {
  if (root.includes("\0")) {
    throw new Error("secure file authority root must not contain NUL");
  }
}

function assertSafeRelativePath(relativePath: string): void {
  if (!relativePath || relativePath.length > 4_096 || relativePath.includes("\0") ||
      relativePath.startsWith("/") || relativePath.startsWith("\\") ||
      /^[A-Za-z]:/u.test(relativePath) || relativePath.startsWith("//") ||
      relativePath.startsWith("\\\\")) {
    throw new Error("secure file authority requires a bounded relative path");
  }
  const components = relativePath.split(/[\\/]/u);
  if (components.some((component) =>
    !component || component === "." || component === ".." ||
    (process.platform === "win32" && component.includes(":"))
  )) {
    throw new Error("secure file authority rejects empty, current, and parent path components");
  }
}

function assertSafeRelativeDirectory(relativePath: string): void {
  if (relativePath === "") return;
  assertSafeRelativePath(relativePath);
}

function assertSafeLeaf(leaf: string, label: string): void {
  if (!leaf || leaf.length > 255 || leaf === "." || leaf === ".." ||
      /[\\/\u0000]/u.test(leaf) ||
      (process.platform === "win32" && leaf.includes(":"))) {
    throw new Error(`${label} must be one bounded path leaf`);
  }
}

export function secureFileAuthoritySupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") return false;
  try {
    return binding().secureFileAuthoritySupported();
  } catch {
    return false;
  }
}

/**
 * Read bytes only through descriptors retained from the registered root.
 * Absolute paths, parent traversal, symlinks, mount crossings, hard links,
 * ancestor replacement, and unstable final identities fail closed.
 */
export function readSecureFile(input: {
  root: string;
  relativePath: string;
  maxBytes: number;
  requireNonEmpty?: boolean;
}): Buffer | undefined {
  if (!secureFileAuthoritySupported()) return undefined;
  assertSafeRoot(input.root);
  assertSafeRelativePath(input.relativePath);
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0 ||
      input.maxBytes > 80 * 1024 * 1024) {
    throw new Error("secure file authority maxBytes must be between 0 and 80 MiB");
  }
  return binding().readSecureFile(
    input.root,
    input.relativePath,
    input.maxBytes,
    input.requireNonEmpty === true,
  ) ?? undefined;
}

export function readSecureFileAsync(
  input: {
    root: string;
    relativePath: string;
    maxBytes: number;
    requireNonEmpty?: boolean;
    expectedSize?: number;
    expectedSha256?: string;
  },
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  if (!secureFileAuthoritySupported()) return Promise.resolve(undefined);
  assertSafeRoot(input.root);
  assertSafeRelativePath(input.relativePath);
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0 ||
      input.maxBytes > 80 * 1024 * 1024) {
    throw new Error("secure file authority maxBytes must be between 0 and 80 MiB");
  }
  if (input.expectedSize !== undefined &&
      (!Number.isSafeInteger(input.expectedSize) ||
       input.expectedSize < 0 ||
       input.expectedSize > input.maxBytes)) {
    throw new Error("secure file authority expectedSize is invalid");
  }
  if (input.expectedSha256 !== undefined &&
      !/^[a-f0-9]{64}$/u.test(input.expectedSha256)) {
    throw new Error("secure file authority expectedSha256 is invalid");
  }
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(
      new URL("./secure-file-worker.js", import.meta.url),
      { workerData: input },
    );
    let settled = false;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
      worker.removeAllListeners();
    };
    const finish = (
      outcome: { body?: Uint8Array; error?: string },
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      if (outcome.error) reject(new Error(outcome.error));
      else resolve(outcome.body ? Buffer.from(outcome.body) : undefined);
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const reason = signal?.reason instanceof Error
        ? signal.reason
        : new Error("secure file read aborted");
      void worker.terminate().then(
        () => reject(reason),
        (error: unknown) => reject(
          error instanceof Error ? error : reason,
        ),
      );
    };
    worker.once("message", finish);
    worker.once("error", (error) => finish({ error: error.message }));
    worker.once("exit", (code) => {
      if (!settled) {
        finish({ error: `secure file worker exited without a result (code ${code})` });
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Enumerate only regular files and directories below a retained secure root. */
export function listSecureDirectory(input: {
  root: string;
  relativePath?: string;
}): SecureDirectoryEntry[] | undefined {
  if (!secureFileAuthoritySupported()) return undefined;
  assertSafeRoot(input.root);
  const relativePath = input.relativePath ?? "";
  assertSafeRelativeDirectory(relativePath);
  return binding().listSecureDirectory(input.root, relativePath) ?? undefined;
}

/** Create and verify a directory chain without following a replacement path. */
export function ensureSecureDirectory(input: {
  root: string;
  relativePath: string;
}): void {
  if (!secureFileAuthoritySupported()) {
    throw new Error("secure directory authority is unavailable");
  }
  assertSafeRoot(input.root);
  assertSafeRelativePath(input.relativePath);
  if (!binding().ensureSecureDirectory(input.root, input.relativePath)) {
    throw new Error("secure directory could not be established");
  }
}

/** Stable volume/file identity for an existing secure directory chain. */
export function secureDirectoryIdentity(input: {
  root: string;
  relativePath?: string;
}): string | undefined {
  if (!secureFileAuthoritySupported()) return undefined;
  assertSafeRoot(input.root);
  const relativePath = input.relativePath ?? "";
  assertSafeRelativeDirectory(relativePath);
  return binding().secureDirectoryIdentity(input.root, relativePath) ?? undefined;
}

/**
 * Write and fsync one temporary regular file, then atomically install it
 * without replacement below a retained directory chain.
 */
export function writeSecureFileAtomic(input: {
  root: string;
  relativeDirectory?: string;
  leaf: string;
  temporaryLeaf: string;
  body: Buffer;
}): void {
  if (!secureFileAuthoritySupported()) {
    throw new Error("secure file publication authority is unavailable");
  }
  assertSafeRoot(input.root);
  const relativeDirectory = input.relativeDirectory ?? "";
  assertSafeRelativeDirectory(relativeDirectory);
  assertSafeLeaf(input.leaf, "secure publication leaf");
  assertSafeLeaf(input.temporaryLeaf, "secure temporary leaf");
  if (!Buffer.isBuffer(input.body) || input.body.length < 1 ||
      input.body.length > 80 * 1024 * 1024) {
    throw new Error("secure publication body must contain 1 to 80 MiB");
  }
  if (!binding().writeSecureFileAtomic(
    input.root,
    relativeDirectory,
    input.leaf,
    input.temporaryLeaf,
    input.body,
  )) {
    throw new Error("secure file publication was not installed");
  }
}

/** Remove one verified regular leaf below a retained secure directory chain. */
export function removeSecureFile(input: {
  root: string;
  relativeDirectory?: string;
  leaf: string;
  expectedIdentity?: string;
}): boolean {
  if (!secureFileAuthoritySupported()) {
    throw new Error("secure file removal authority is unavailable");
  }
  assertSafeRoot(input.root);
  const relativeDirectory = input.relativeDirectory ?? "";
  assertSafeRelativeDirectory(relativeDirectory);
  assertSafeLeaf(input.leaf, "secure removal leaf");
  if (input.expectedIdentity !== undefined &&
      (!input.expectedIdentity || input.expectedIdentity.length > 128 ||
       /[^A-Fa-f0-9:-]/u.test(input.expectedIdentity))) {
    throw new Error("secure removal expected identity is invalid");
  }
  const quarantineLeaf = `.remove-${randomUUID()}`;
  assertSafeLeaf(quarantineLeaf, "secure removal quarantine leaf");
  return binding().removeSecureFile(
    input.root,
    relativeDirectory,
    input.leaf,
    quarantineLeaf,
    input.expectedIdentity ?? "",
  );
}

/** A held physical read reference is not mutable data admission or a lease. */
export class DataDirectoryReadReference {
  readonly #authority: unknown;
  #closed = false;
  constructor(root: string) {
    if (process.platform === "linux") throw new Error("Linux uses its existing descriptor read pin");
    this.#authority = binding().acquirePortableDataDirectory(root,
      path.resolve(path.sep, ".__ponderosa_storage__", randomUUID()), true);
  }
  get rootPath(): string {
    if (this.#closed) throw new Error("read reference is closed");
    return binding().portableDataDirectoryPath(this.#authority);
  }
  close(): void {
    if (!this.#closed) { binding().releasePortableDataDirectory(this.#authority); this.#closed = true; }
  }
}

/** Physical directory identity, including the full Windows volume/file ID. */
export function physicalDirectoryIdentity(root: string): string {
  const identity = secureDirectoryIdentity({ root, relativePath: "" });
  if (!identity) throw new Error("physical directory identity is unavailable");
  return identity;
}
