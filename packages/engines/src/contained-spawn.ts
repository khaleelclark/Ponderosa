import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { NativeProcessTreeAuthority } from "./process-termination.js";
import { spawnWindowsContainedProcess } from "./windows-job-process.js";

export interface ContainedSpawn {
  child: ChildProcess;
  authority?: NativeProcessTreeAuthority;
}

/**
 * One process-tree boundary for provider CLIs and every helper they launch.
 * Windows processes start behind the Job-assignment gate; POSIX processes
 * receive their own detached group.
 */
export function spawnContainedCli(input: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "ignore" | "pipe";
}): ContainedSpawn {
  const contained = process.platform === "win32"
    ? spawnWindowsContainedProcess(input)
    : {
    child: nodeSpawn(input.bin, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: [input.stdin, "pipe", "pipe"],
      detached: true,
    }),
  };
  // Provider executables are optional host dependencies. Always keep a
  // baseline observer installed so a missing Claude or Codex binary can be
  // reported by the calling discovery/auth/runtime boundary without Node
  // treating the ChildProcess `error` event as an uncaught daemon failure.
  // Callers retain their own listeners to preserve the operation-specific
  // unavailable/error response.
  contained.child.on("error", () => undefined);
  return contained;
}
