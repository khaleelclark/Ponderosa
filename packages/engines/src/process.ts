// Shared child-process streaming for CLI-backed engines. Both the Codex and Claude
// adapters spawn a subscription-authenticated CLI, stream its JSON events, map them
// to AgentEvents, and wire AbortSignal → SIGTERM → SIGKILL. That machinery lives
// here so each adapter is just "args + a mapper" (AGENTS.md invariant 2).

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { AgentEvent, RuntimeProcessHandle } from "@ponderosa/core";
import { JSONL_MAX_RECORD_BYTES, JsonlRecordLimitError, parseJsonlChunks } from "./jsonl.js";
import { runtimeProcessHandle } from "./process-termination.js";

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
  onRuntimeSpawned?: (handle: RuntimeProcessHandle) => void;
  /** Fence host capabilities as soon as the provider root exits. */
  onRuntimeRootExit?: () => void;
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

const POST_EXIT_STDOUT_DRAIN_MS = 250;
const LIVE_STDOUT_BUFFER_RECORDS = 64;
const LIVE_STDOUT_BUFFER_BYTES = 4 * 1024 * 1024;
const TERMINAL_STDOUT_BUFFER_RECORDS = 512;
const TERMINAL_STDOUT_BUFFER_BYTES = 4 * 1024 * 1024;

function bufferedRecordBytes(raw: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(raw), "utf8"); }
  catch { return TERMINAL_STDOUT_BUFFER_BYTES + 1; }
}

function jsonlRecordLimitMessage(label: string): string {
  return `${label} JSONL record exceeded the ${JSONL_MAX_RECORD_BYTES / (1024 * 1024)} MiB limit`;
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
    onRuntimeSpawned,
    onRuntimeRootExit,
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

  const handle = runtimeProcessHandle(child, {
    label: `${label} run`,
    termGraceMs: killGraceMs,
  });
  const terminate = (): Promise<void> => handle.close();
  onRuntimeSpawned?.(handle);
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
  // `close` waits for inherited stdio to close. A background descendant can
  // deliberately keep stdout open after the provider root exits, so observe
  // `exit` independently and revoke the complete process group immediately.
  const rootExit = waitForExit(child);
  const rootTermination = rootExit.then(() => {
    try { onRuntimeRootExit?.(); }
    finally { return terminate(); }
  });
  void rootTermination.catch(() => undefined);
  let stdoutDrainTimer: NodeJS.Timeout | undefined;
  const stdoutDrainExpired = rootTermination.then(
    () => undefined,
    () => undefined,
  ).then(() => new Promise<void>((resolve) => {
    stdoutDrainTimer = setTimeout(resolve, POST_EXIT_STDOUT_DRAIN_MS);
  }));

  try {
    const stdout = child.stdout;
    if (stdout) {
      // Consume provider stdout independently of downstream persistence. A
      // successful short-lived CLI can exit while its final JSONL records are
      // already buffered; a slow consumer must not lose those records merely
      // because the bounded post-root drain deadline expires between yields.
      const buffered: Array<{ raw: unknown; bytes: number }> = [];
      let bufferedBytes = 0;
      let wake: (() => void) | undefined;
      let releaseProducer: (() => void) | undefined;
      let rootHasExited = false;
      let parsingDone = false;
      let parsingError: unknown;
      let stdoutDrainDeadlineReached = false;
      let terminalBufferExceeded = false;
      void rootExit.then(() => {
        rootHasExited = true;
        releaseProducer?.();
        releaseProducer = undefined;
      });
      const parsing = (async () => {
        try {
          for await (const raw of parseJsonlChunks(stdout as AsyncIterable<Buffer>)) {
            const bytes = bufferedRecordBytes(raw);
            if (rootHasExited && (bytes > TERMINAL_STDOUT_BUFFER_BYTES ||
                buffered.length >= TERMINAL_STDOUT_BUFFER_RECORDS ||
                bufferedBytes + bytes > TERMINAL_STDOUT_BUFFER_BYTES)) {
              terminalBufferExceeded = true;
              stdout.destroy();
              break;
            }
            buffered.push({ raw, bytes });
            bufferedBytes += bytes;
            wake?.();
            wake = undefined;
            // Preserve ordinary stream backpressure during a live Run. Once
            // the root exits, drain the finite terminal pipe contents eagerly
            // so downstream persistence latency cannot lose successful output.
            if (!rootHasExited && (buffered.length >= LIVE_STDOUT_BUFFER_RECORDS ||
                bufferedBytes >= LIVE_STDOUT_BUFFER_BYTES)) {
              await new Promise<void>((resolve) => {
                if (rootHasExited || (buffered.length < LIVE_STDOUT_BUFFER_RECORDS &&
                    bufferedBytes < LIVE_STDOUT_BUFFER_BYTES)) resolve();
                else releaseProducer = resolve;
              });
            }
          }
        } catch (error) {
          parsingError = error;
          if (error instanceof JsonlRecordLimitError) {
            stdout.destroy();
            void terminate().catch(() => undefined);
          }
        } finally {
          parsingDone = true;
          wake?.();
          wake = undefined;
        }
      })();
      void stdoutDrainExpired.then(() => {
        stdoutDrainDeadlineReached = true;
        stdout.destroy();
      });
      while (!parsingDone || buffered.length > 0) {
        if (buffered.length === 0) {
          await new Promise<void>((resolve) => {
            // Recheck inside the synchronous Promise executor so parsing
            // cannot finish between the outer condition and waiter install.
            if (parsingDone || buffered.length > 0) resolve();
            else wake = resolve;
          });
          continue;
        }
        const record = buffered.shift()!;
        bufferedBytes -= record.bytes;
        releaseProducer?.();
        releaseProducer = undefined;
        await faults?.afterDecodeBeforeYield?.(record.raw, processSnapshot(child));
        for (const ev of map(record.raw, { cwd })) yield ev;
      }
      await parsing;
      // A local deadline close is expected when an out-of-group process holds
      // an inherited descriptor. Preserve actual parser failures otherwise.
      const recordLimitExceeded = parsingError instanceof JsonlRecordLimitError;
      if (parsingError && !stdoutDrainDeadlineReached && !terminalBufferExceeded && !recordLimitExceeded) throw parsingError;
      if (recordLimitExceeded) {
        yield { type: "error", message: jsonlRecordLimitMessage(label) };
      }
      if (terminalBufferExceeded) {
        yield {
          type: "error",
          message: `${label} terminal output exceeded the 512-record / 4 MiB buffer limit after root exit`,
        };
      }
    }

    const code = await rootExit;
    await rootTermination;

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
    if (stdoutDrainTimer) clearTimeout(stdoutDrainTimer);
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

/** Resolve when the root exits, independently of descendant-owned stdio. */
function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      resolve(code);
    };
    child.once("exit", (code) => finish(code));
    child.once("error", () => finish(null)); // ENOENT etc. — 'exit' may not fire
  });
}
