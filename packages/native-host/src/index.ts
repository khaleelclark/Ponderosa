import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

interface NativeJobBinding {
  windowsJobObjectsSupported(): boolean;
  darwinProcessBirthMarker(pid: number): string | null;
  createWindowsJob(): unknown;
  assignWindowsJob(job: unknown, pid: number): void;
  terminateWindowsJob(job: unknown): void;
  windowsJobActiveProcesses(job: unknown): number;
  closeWindowsJob(job: unknown): void;
  secureFileAuthoritySupported(): boolean;
  readSecureFile(root: string, relativePath: string, maxBytes: number, requireNonEmpty: boolean): Buffer | null;
  listSecureDirectory(root: string, relativePath: string): SecureDirectoryEntry[] | null;
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
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  loaded = createRequire(import.meta.url)(
    path.join(packageRoot, "build", "Release", "ponderosa_native.node"),
  ) as NativeJobBinding;
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
      input.maxBytes > 64 * 1024 * 1024) {
    throw new Error("secure file authority maxBytes must be between 0 and 64 MiB");
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
      input.maxBytes > 64 * 1024 * 1024) {
    throw new Error("secure file authority maxBytes must be between 0 and 64 MiB");
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
      input.body.length > 64 * 1024 * 1024) {
    throw new Error("secure publication body must contain 1 to 64 MiB");
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
