import type { ChildProcess } from "node:child_process";
import type { RuntimeProcessHandle } from "@ponderosa/core";

export interface ObservedProcessTerminationOptions {
  label: string;
  termGraceMs: number;
  /** Bounded time after SIGKILL for the OS to report the process group gone. */
  killConfirmationMs?: number;
}

export interface NativeProcessTreeAuthority {
  isAlive(): boolean;
  terminate(): void;
  close(): void;
}

export function assertPersistentRuntimeHostingSupported(platform = process.platform): void {
  if (platform === "win32") return;
}

/**
 * Terminate an engine's entire detached process group and resolve only after
 * the operating system reports that no process remains in it. Timers stay
 * referenced deliberately: daemon shutdown must not exit during the grace
 * interval and strand a provider or one of its shell descendants.
 */
export async function terminateProcessGroup(
  child: ChildProcess,
  opts: ObservedProcessTerminationOptions,
  nativeAuthority?: NativeProcessTreeAuthority,
): Promise<void> {
  if (nativeAuthority) {
    if (!nativeAuthority.isAlive()) {
      nativeAuthority.close();
      return;
    }
    nativeAuthority.terminate();
    const confirmationMs = opts.killConfirmationMs ??
      Math.max(250, Math.min(Math.max(0, opts.termGraceMs), 5_000));
    if (await waitForNativeTreeExit(nativeAuthority, confirmationMs)) {
      nativeAuthority.close();
      return;
    }
    throw new Error(
      `${opts.label} Windows Job Object remained active after termination and ${confirmationMs}ms confirmation`,
    );
  }
  const pid = child.pid;
  if (!processTreeAlive(child, pid)) return;

  const signalErrors: string[] = [];
  const termError = signalProcessTree(child, pid, "SIGTERM");
  if (termError) signalErrors.push(termError.message);
  if (await waitForProcessTreeExit(child, pid, Math.max(0, opts.termGraceMs))) return;

  const killError = signalProcessTree(child, pid, "SIGKILL");
  if (killError) signalErrors.push(killError.message);
  const killConfirmationMs = opts.killConfirmationMs
    ?? Math.max(50, Math.min(Math.max(0, opts.termGraceMs), 1_000));
  if (await waitForProcessTreeExit(child, pid, killConfirmationMs)) return;

  throw new Error(
    `${opts.label} process group remained alive after SIGKILL and ${killConfirmationMs}ms confirmation` +
    `${signalErrors.length ? ` (${signalErrors.join("; ")})` : ""}`,
  );
}

/** Report ownership for the complete detached process group, not only its root. */
export function processGroupAlive(child: ChildProcess, observedTerminal = false): boolean {
  return processTreeAlive(child, child.pid, observedTerminal);
}

/** Build the retryable host authority published synchronously at spawn time. */
export function runtimeProcessHandle(
  child: ChildProcess,
  opts: ObservedProcessTerminationOptions,
  nativeAuthority?: NativeProcessTreeAuthority,
): RuntimeProcessHandle {
  let termination: Promise<void> | undefined;
  return {
    isAlive: () => nativeAuthority?.isAlive() ?? processGroupAlive(child),
    close: () => {
      if (termination) return termination;
      const attempt = terminateProcessGroup(child, opts, nativeAuthority);
      const shared = attempt.catch((error) => {
        if (termination === shared) termination = undefined;
        throw error;
      });
      termination = shared;
      void shared.catch(() => undefined);
      return shared;
    },
  };
}

function waitForNativeTreeExit(
  authority: NativeProcessTreeAuthority,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const check = (): void => {
      if (!authority.isAlive()) {
        if (timer) clearTimeout(timer);
        resolve(true);
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        resolve(false);
        return;
      }
      timer = setTimeout(check, Math.min(25, remaining));
    };
    check();
  });
}

function processTreeAlive(child: ChildProcess, pid: number | undefined, observedTerminal = false): boolean {
  if (process.platform !== "win32" && pid) {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
      // A test adapter or unusual launcher may not make the child its process
      // group leader. Fall back to the root process without weakening the
      // normal detached-group check.
      try { process.kill(pid, 0); return true; }
      catch (rootError) { return (rootError as NodeJS.ErrnoException).code !== "ESRCH"; }
    }
  }
  return !observedTerminal && child.exitCode === null && child.signalCode === null;
}

function signalProcessTree(
  child: ChildProcess,
  pid: number | undefined,
  signal: NodeJS.Signals,
): Error | undefined {
  if (!processTreeAlive(child, pid)) return undefined;
  try {
    let delivered: boolean;
    if (process.platform !== "win32" && pid) {
      try {
        delivered = process.kill(-pid, signal);
      } catch (groupError) {
        if ((groupError as NodeJS.ErrnoException).code !== "ESRCH") throw groupError;
        delivered = child.kill(signal);
      }
    } else {
      delivered = child.kill(signal);
    }
    if (delivered === false && processTreeAlive(child, pid)) {
      return new Error(`${signal} delivery returned false`);
    }
    return undefined;
  } catch (error) {
    if (!processTreeAlive(child, pid)) return undefined;
    return new Error(`${signal} delivery failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function waitForProcessTreeExit(
  child: ChildProcess,
  pid: number | undefined,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    let observedTerminal = false;
    let finished = false;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      child.off("exit", onTerminal);
      child.off("close", onTerminal);
      child.off("error", onTerminal);
    };
    const finish = (gone: boolean): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(gone);
    };
    const check = (): void => {
      if (!processTreeAlive(child, pid, observedTerminal)) return finish(true);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return finish(false);
      timer = setTimeout(check, Math.min(25, remaining));
    };
    const onTerminal = (): void => {
      observedTerminal = true;
      check();
    };
    child.on("exit", onTerminal);
    child.on("close", onTerminal);
    child.on("error", onTerminal);
    check();
  });
}
