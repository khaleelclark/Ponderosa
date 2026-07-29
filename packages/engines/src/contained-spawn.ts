import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { NativeProcessTreeAuthority } from "./process-termination.js";
import { spawnWindowsContainedProcess } from "./windows-job-process.js";

export interface ContainedSpawn {
  child: ChildProcess;
  authority?: NativeProcessTreeAuthority;
}

/**
 * One process-tree boundary for provider CLIs and every helper they launch.
 * Production Windows processes start behind the Job-assignment gate; POSIX
 * processes receive their own detached group. Injected test spawners remain
 * observable without attempting to attach fake PIDs to a native Job.
 */
export function spawnContainedCli(input: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "ignore" | "pipe";
  spawnFn?: typeof nodeSpawn;
}): ContainedSpawn {
  const spawnFn = input.spawnFn ?? nodeSpawn;
  if (process.platform === "win32" && spawnFn === nodeSpawn) {
    return spawnWindowsContainedProcess(input);
  }
  return {
    child: spawnFn(input.bin, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: [input.stdin, "pipe", "pipe"],
      detached: process.platform !== "win32",
    }),
  };
}
