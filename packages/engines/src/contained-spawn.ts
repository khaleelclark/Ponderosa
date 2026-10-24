import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerSystemdScope } from "./systemd-scope.js";
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

/**
 * A systemd user scope moves the provider and its tool descendants out of the
 * daemon's service cgroup. The scope is an operational memory boundary, not a
 * security boundary: Agents intentionally retain the host user's shell access.
 *
 * This is explicit because a system service, container, or non-systemd Linux
 * installation might not have a usable user manager. Other platforms keep
 * their existing process containment unchanged.
 */
export function containedCliInvocation(
  input: ContainedSpawnInput,
  platform: NodeJS.Platform = process.platform,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
): { bin: string; args: string[] } {
  if (platform !== "linux" || environmentValue(hostEnvironment, "PONDEROSA_AGENT_SCOPE_MODE") !== "systemd") {
    return { bin: input.bin, args: input.args };
  }
  const parentUnit = environmentValue(hostEnvironment, "PONDEROSA_AGENT_PARENT_UNIT");
  if (!parentUnit || parentUnit.length > 255 || !/^[a-zA-Z0-9_.@-]+\.service$/u.test(parentUnit)) {
    throw new Error("systemd Agent scope mode requires a valid PONDEROSA_AGENT_PARENT_UNIT service name");
  }
  const slice = environmentValue(hostEnvironment, "PONDEROSA_AGENT_WORKLOAD_SLICE") ?? "ponderosa-agent-workloads.slice";
  if (slice.length > 255 || !/^[a-zA-Z0-9_.-]+\.slice$/u.test(slice)) throw new Error("invalid Agent workload slice");
  const memoryMiB = environmentValue(hostEnvironment, "PONDEROSA_AGENT_MEMORY_MAX_MIB") ?? "8192";
  if (!/^[1-9]\d*$/u.test(memoryMiB) || Number(memoryMiB) > 1024 ** 2) {
    throw new Error("PONDEROSA_AGENT_MEMORY_MAX_MIB must be a positive integer no greater than 1048576");
  }
  const memoryMax = Number(memoryMiB) * 1024 ** 2;
  return {
    bin: "systemd-run",
    args: [
      "--user",
      "--scope",
      "--quiet",
      // Provider arguments may contain ${...}; never let systemd reinterpret
      // them as environment substitutions.
      "--expand-environment=no",
      `--slice=${slice}`,
      `--property=MemoryMax=${memoryMax}`,
      "--property=MemorySwapMax=0",
      "--property=OOMPolicy=kill",
      "--property=TimeoutStopSec=2s",
      // A normal app stop/restart must also stop scopes that outlive a crashed
      // provider root. Restart recovery remains responsible for exact process
      // group teardown if a daemon dies without an orderly unit transition.
      `--property=PartOf=${parentUnit}`,
      "--",
      input.bin,
      ...input.args,
    ],
  };
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

export function executableAvailable(input: Pick<ContainedSpawnInput, "bin" | "cwd" | "env">): boolean {
  return executablePath(input) !== undefined;
}

export function executablePath(input: Pick<ContainedSpawnInput, "bin" | "cwd" | "env">): string | undefined {
  const explicitPath = path.isAbsolute(input.bin) || input.bin.includes("/") ||
    (process.platform === "win32" && input.bin.includes("\\"));
  const bases = explicitPath
    ? [path.resolve(input.cwd, input.bin)]
    : (environmentValue(input.env, "PATH") ??
      (process.platform === "win32" ? process.env.PATH ?? "" : "/usr/bin:/bin"))
      .split(path.delimiter)
      .map((entry) => entry.replace(/^"|"$/gu, ""))
      .map((entry) => path.resolve(input.cwd, entry || ".", input.bin));
  if (process.platform !== "win32") return bases.find(executableFile);

  const extensions = (environmentValue(input.env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  const hasExtension = path.extname(input.bin) !== "";
  return bases.flatMap(base => hasExtension ? [base] : [base, ...extensions.map(extension => `${base}${extension}`)])
    .find(executableFile);
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
export function spawnContainedCli(
  input: ContainedSpawnInput,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
): ContainedSpawn {
  // Missing providers are an expected host configuration, not a process-level
  // failure. Resolve them before creating ChildProcess helpers whose rejected
  // discovery races could otherwise outlive the public unavailable response.
  if (!executableAvailable(input)) throw missingExecutable(input);
  const invocation = containedCliInvocation(input, process.platform, hostEnvironment);
  const scope = invocation.bin !== input.bin ? { unit: `ponderosa-agent-${randomUUID()}.scope`, authorityId: randomUUID() } : undefined;
  if (scope) invocation.args.splice(invocation.args.indexOf("--"), 0, `--unit=${scope.unit}`, `--property=Description=Ponderosa process authority ${scope.authorityId}`);
  if (invocation.bin !== input.bin && !executableAvailable({ ...input, bin: invocation.bin })) {
    throw new Error("Agent memory isolation requires systemd-run on PATH");
  }
  const contained = process.platform === "win32"
    ? spawnWindowsContainedProcess(input)
    : {
    child: nodeSpawn(invocation.bin, invocation.args, {
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
  if (scope) registerSystemdScope(contained.child, scope);
  return contained;
}
