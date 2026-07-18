// Shared child-process streaming for CLI-backed engines. Both the Codex and Claude
// adapters spawn a subscription-authenticated CLI, stream its JSON events, map them
// to AgentEvents, and wire AbortSignal → SIGTERM → SIGKILL. That machinery lives
// here so each adapter is just "args + a mapper" (AGENTS.md invariant 2).

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { AgentEvent } from "@ponderosa/core";
import { parseJsonlChunks } from "./jsonl.js";
import { terminateProcessGroup } from "./process-termination.js";

/** A minimal spawn signature so tests can inject a fake CLI. */
export type SpawnFn = typeof nodeSpawn;

export interface ProcessStreamSnapshot {
  pid?: number;
  pgid?: number;
  parentPid: number;
  exitCode: number | null;
  stdinOpen: boolean;
  stdoutOpen: boolean;
  stderrOpen: boolean;
}

export interface RuntimeProcessFaults {
  afterDecodeBeforeYield?: (raw: unknown, child: ProcessStreamSnapshot) => void | Promise<void>;
  /** Test-only: keep the fake runtime's stdin connected after writing its prompt. */
  keepStdinOpen?: boolean;
}

export interface StreamProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  environment?: Record<string, string>;
  spawnFn: SpawnFn;
  /** ms to wait after SIGTERM before SIGKILL on cancel. */
  killGraceMs: number;
  /** Map one parsed JSON event → 0..n normalized AgentEvents (the engine's mapper). */
  map: (raw: unknown, ctx: { cwd: string }) => AgentEvent[];
  /** Human label for error messages, e.g. "codex" / "claude". */
  label: string;
  /** Optional stdin payload. Use this for unbounded user/context text, never argv. */
  stdin?: string;
  faults?: RuntimeProcessFaults;
}

/**
 * Spawn a CLI, parse its stdout as JSONL, and yield mapped AgentEvents. On abort,
 * SIGTERM then SIGKILL after a grace period. Nonzero exit (when not aborted and not
 * a spawn failure) yields a final `error` event with the stderr tail.
 */
export async function* streamProcess(
  opts: StreamProcessOptions,
): AsyncIterable<AgentEvent> {
  const {
    bin,
    args,
    cwd,
    signal,
    environment,
    spawnFn,
    killGraceMs,
    map,
    label,
    stdin,
    faults,
  } = opts;

  if (signal.aborted) {
    yield { type: "error", message: "run aborted before start" };
    return;
  }

  const child: ChildProcess = spawnFn(bin, args, {
    cwd,
    env: { ...process.env, ...environment },
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    // Give each run its own process group. Agent CLIs can spawn long-running
    // commands, so cancelling only the CLI would leave its descendants alive.
    detached: process.platform !== "win32",
  });

  // Large prompts cannot safely be argv entries: POSIX limits the combined
  // argument and environment size and Node surfaces that launch failure as
  // E2BIG. Stream prompt text after spawn instead. Ignore a late EPIPE here;
  // the process exit/spawn error below remains the canonical error signal.
  if (stdin !== undefined && child.stdin) {
    child.stdin.on("error", () => undefined);
    if (faults?.keepStdinOpen) child.stdin.write(stdin);
    else child.stdin.end(stdin);
  }

  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => {
    stderrTail = (stderrTail + d).slice(-8192);
  });

  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> => {
    if (termination) return termination;
    termination = terminateProcessGroup(child, {
      label: `${label} run`,
      termGraceMs: killGraceMs,
    });
    // The generator awaits this barrier below. Observe an early rejection now
    // so an AbortSignal callback cannot create an unhandled promise first.
    void termination.catch(() => undefined);
    return termination;
  };
  const onAbort = (): void => {
    void terminate();
  };
  signal.addEventListener("abort", onAbort);
  if (signal.aborted) onAbort();

  // spawn errors (e.g. CLI not installed) surface as an 'error' on the child.
  let spawnError: Error | undefined;
  child.on("error", (err: Error) => {
    spawnError = err;
  });

  try {
    const stdout = child.stdout;
    if (stdout) {
      stdout.setEncoding("utf8");
      for await (const raw of parseJsonlChunks(stdout as AsyncIterable<string>)) {
        await faults?.afterDecodeBeforeYield?.(raw, processSnapshot(child));
        for (const ev of map(raw, { cwd })) {
          yield ev;
        }
      }
    }

    const code = await waitForClose(child);
    // Root exit is insufficient: commands spawned by the CLI can remain in
    // the detached process group. Resolve the Run only after the whole group
    // is observed gone, escalating through SIGKILL when required.
    await terminate();

    if (spawnError) {
      yield { type: "error", message: `failed to spawn ${bin}: ${spawnError.message}` };
    } else if (signal.aborted) {
      yield { type: "error", message: "run cancelled" };
    } else if (code !== 0 && code !== null) {
      const tail = stderrTail.trim();
      yield {
        type: "error",
        message: `${label} exited with code ${code}${tail ? `: ${tail}` : ""}`,
      };
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await terminate();
  }
}

function processSnapshot(child: ChildProcess): ProcessStreamSnapshot {
  return {
    ...(child.pid ? { pid: child.pid, ...(process.platform !== "win32" ? { pgid: child.pid } : {}) } : {}),
    parentPid: process.pid,
    exitCode: child.exitCode,
    stdinOpen: Boolean(child.stdin && !child.stdin.destroyed),
    stdoutOpen: Boolean(child.stdout && !child.stdout.destroyed),
    stderrOpen: Boolean(child.stderr && !child.stderr.destroyed),
  };
}

/** Resolve with the process exit code once it has fully closed (or failed to spawn). */
function waitForClose(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      resolve(code);
    };
    child.once("close", (code) => finish(code));
    child.once("error", () => finish(null)); // ENOENT etc. — 'close' may not fire
  });
}
