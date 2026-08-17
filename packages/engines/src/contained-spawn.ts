import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { NativeProcessTreeAuthority } from "./process-termination.js";
import { spawnWindowsContainedProcess } from "./windows-job-process.js";

export interface ContainedSpawn {
  child: ChildProcess;
  authority?: NativeProcessTreeAuthority;
}

interface ContainedSpawnInput {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "ignore" | "pipe";
}

function environmentValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const exact = environment[key];
  if (exact !== undefined || process.platform !== "win32") return exact;
  const matched = Object.keys(environment).find((candidate) =>
    candidate.toLocaleLowerCase() === key.toLocaleLowerCase());
  return matched ? environment[matched] : undefined;
}

function executableFile(candidate: string): boolean {
  try {
    accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function executableAvailable(input: ContainedSpawnInput): boolean {
  const explicitPath = path.isAbsolute(input.bin) || input.bin.includes("/") ||
    (process.platform === "win32" && input.bin.includes("\\"));
  const bases = explicitPath
    ? [path.resolve(input.cwd, input.bin)]
    : (environmentValue(input.env, "PATH") ??
      (process.platform === "win32" ? process.env.PATH ?? "" : "/usr/bin:/bin"))
      .split(path.delimiter)
      .map((entry) => entry.replace(/^"|"$/gu, ""))
      .map((entry) => path.resolve(input.cwd, entry || ".", input.bin));
  if (process.platform !== "win32") return bases.some(executableFile);

  const extensions = (environmentValue(input.env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  const hasExtension = path.extname(input.bin) !== "";
  return bases.some((base) => executableFile(base) ||
    (!hasExtension && extensions.some((extension) => executableFile(`${base}${extension}`))));
}

function missingExecutable(input: ContainedSpawnInput): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${input.bin} ENOENT`), {
    code: "ENOENT",
    errno: -2,
    syscall: `spawn ${input.bin}`,
    path: input.bin,
    spawnargs: input.args,
  });
}

/**
 * One process-tree boundary for provider CLIs and every helper they launch.
 * Windows processes start behind the Job-assignment gate; POSIX processes
 * receive their own detached group.
 */
export function spawnContainedCli(input: ContainedSpawnInput): ContainedSpawn {
  // Missing providers are an expected host configuration, not a process-level
  // failure. Resolve them before creating ChildProcess helpers whose rejected
  // discovery races could otherwise outlive the public unavailable response.
  if (!executableAvailable(input)) throw missingExecutable(input);
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
