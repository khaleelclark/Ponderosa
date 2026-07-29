import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface NativeJobBinding {
  windowsJobObjectsSupported(): boolean;
  createWindowsJob(): unknown;
  assignWindowsJob(job: unknown, pid: number): void;
  terminateWindowsJob(job: unknown): void;
  windowsJobActiveProcesses(job: unknown): number;
  closeWindowsJob(job: unknown): void;
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
