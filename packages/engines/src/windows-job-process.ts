import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WindowsProcessJob, windowsJobObjectsSupported } from "@ponderosa/native-host";
import type { NativeProcessTreeAuthority } from "./process-termination.js";

interface SpawnInput {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "ignore" | "pipe";
  /** Reserve stdin/stdout for Chrome's remote-debugging pipe. */
  browserPipe?: boolean;
}

export interface WindowsContainedProcess {
  child: ChildProcess;
  authority: NativeProcessTreeAuthority;
}

export class JobAuthority implements NativeProcessTreeAuthority {
  #assigned = false;
  #terminationRequested = false;
  #closed = false;
  #drained = false;

  constructor(
    readonly child: ChildProcess,
    readonly job: WindowsProcessJob,
  ) {}

  assigned(): void {
    this.#assigned = true;
    if (this.#terminationRequested) this.job.terminate();
  }

  assignmentFailed(): void {
    this.#terminationRequested = true;
    try { this.child.kill(); } catch { /* root exit is observed below */ }
    this.job.close();
    this.#closed = true;
  }

  isAlive(): boolean {
    if (this.#closed) {
      return !this.#drained && this.child.exitCode === null && this.child.signalCode === null;
    }
    if (!this.#assigned) {
      return this.child.exitCode === null && this.child.signalCode === null;
    }
    return this.job.activeProcesses() > 0;
  }

  terminate(): void {
    this.#terminationRequested = true;
    if (this.#assigned && !this.#closed) this.job.terminate();
  }

  close(): void {
    if (this.#closed) return;
    // A verified empty Job stays terminal even before Node delivers root exit.
    this.#drained = this.#assigned && this.job.activeProcesses() === 0;
    this.#closed = true;
    this.job.close();
  }
}

/**
 * Start a gate process that cannot create the provider until the gate belongs
 * to its exact Job Object. Provider children inherit the Job and cannot
 * silently break away because no breakaway limit is configured.
 */
export function spawnWindowsContainedProcess(input: SpawnInput): WindowsContainedProcess {
  if (process.platform !== "win32" || !windowsJobObjectsSupported()) {
    throw new Error("Windows Job Object process containment is unavailable");
  }
  const job = new WindowsProcessJob();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./windows-job-wrapper.js", import.meta.url))], {
    cwd: input.cwd,
    env: input.env,
    stdio: [input.stdin, "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const authority = new JobAuthority(child, job);
  child.once("spawn", () => {
    try {
      if (!child.pid) throw new Error("Windows containment gate started without a process id");
      job.assign(child.pid);
      authority.assigned();
      child.send?.({ type: "start", bin: input.bin, args: input.args, cwd: input.cwd, browserPipe: input.browserPipe === true });
    } catch (error) {
      authority.assignmentFailed();
      queueMicrotask(() => child.emit("error", error));
    }
  });
  child.once("error", () => authority.assignmentFailed());
  return { child, authority };
}
