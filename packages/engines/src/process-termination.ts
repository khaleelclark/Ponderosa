import type { ChildProcess } from "node:child_process";
import type { RuntimeProcessHandle, RuntimeProcessIdentity } from "@ponderosa/core";
import { hostProcessBirthMarker as processBirthMarker } from "@ponderosa/native-host";
import { closeSystemdScope, processScope, systemdScopeAlive, validateSystemdScope } from "./systemd-scope.js";

export { processBirthMarker };

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
  const scope = processScope(child);
  if (scope) {
    // Stop the launcher first so it cannot create a scope after cleanup. Then
    // observe the complete owned scope, including setsid/daemon descendants.
    if (child.exitCode === null && child.signalCode === null) await terminatePosixGroup(child, opts);
    await closeSystemdScope(scope);
    return;
  }
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
  await terminatePosixGroup(child, opts);
}

async function terminatePosixGroup(child: ChildProcess, opts: ObservedProcessTerminationOptions): Promise<void> {
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
  const groupAlive = processTreeAlive(child, child.pid, observedTerminal);
  const scope = processScope(child);
  if (!scope) return groupAlive;
  try { return systemdScopeAlive(scope) || groupAlive; } catch { return true; }
}

/** Build the retryable host authority published synchronously at spawn time. */
export function runtimeProcessHandle(
  child: ChildProcess,
  opts: ObservedProcessTerminationOptions,
  nativeAuthority?: NativeProcessTreeAuthority,
): RuntimeProcessHandle {
  let termination: Promise<void> | undefined;
  const processIdentity = nativeAuthority ? undefined : runtimeProcessIdentity(child);
  return {
    ...(processIdentity ? { processIdentity } : {}),
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

/** Capture enough POSIX identity to recover a detached process group without
 * ever signalling a PID that the OS has since reused. */
export function runtimeProcessIdentity(child: ChildProcess): RuntimeProcessIdentity | undefined {
  if (process.platform === "win32" || !child.pid) return undefined;
  const birthMarker = processBirthMarker(child.pid);
  const scope = processScope(child);
  return birthMarker ? { pid: child.pid, pgid: child.pid, birthMarker, ...(scope ? { scope } : {}) } : undefined;
}

/** Only identities backed by a platform's high-resolution, immutable process
 * birth source may authorize restart recovery. Unsupported POSIX platforms
 * deliberately fail closed instead of falling back to second-resolution ps. */
export function isRestartRecoverableProcessIdentity(
  identity: RuntimeProcessIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (platform === "linux" && /^linux:\d+$/u.test(identity.birthMarker)) ||
    (platform === "darwin" && /^darwin:\d+:\d{1,6}$/u.test(identity.birthMarker));
}

/** Reconstitute a retryable process-group handle after daemon restart. */
export function recoveredRuntimeProcessHandle(
  identity: RuntimeProcessIdentity,
  opts: ObservedProcessTerminationOptions,
): RuntimeProcessHandle {
  let termination: Promise<void> | undefined;
  return {
    processIdentity: identity,
    isAlive: () => { if (identity.scope) { try { return systemdScopeAlive(identity.scope) || recoveredProcessGroupAlive(identity); } catch { return true; } } return recoveredProcessGroupAlive(identity); },
    close: () => {
      if (termination) return termination;
      const attempt = (async () => { await terminateRecoveredProcessGroup(identity, opts); if (identity.scope) { validateSystemdScope(identity.scope); await closeSystemdScope(identity.scope); } })();
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

function recoveredProcessGroupAlive(identity: RuntimeProcessIdentity): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-identity.pgid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (!isRestartRecoverableProcessIdentity(identity)) return true;
  const currentBirth = processBirthMarker(identity.pid);
  if (currentBirth !== undefined) return currentBirth === identity.birthMarker;
  // If the original group leader exited while descendants remain, the PGID
  // stays reserved to that group. A reused group would again have a live
  // leader at pid === pgid and would have been rejected above.
  return true;
}

async function terminateRecoveredProcessGroup(
  identity: RuntimeProcessIdentity,
  opts: ObservedProcessTerminationOptions,
): Promise<void> {
  if (!recoveredProcessGroupAlive(identity)) return;
  if (!isRestartRecoverableProcessIdentity(identity)) {
    throw new Error(
      `${opts.label} process identity cannot be proven safely on ${process.platform}; refusing to signal`,
    );
  }
  const errors: string[] = [];
  for (const [signal, waitMs] of [
    ["SIGTERM", Math.max(0, opts.termGraceMs)],
    ["SIGKILL", opts.killConfirmationMs ?? Math.max(50, Math.min(Math.max(0, opts.termGraceMs), 1_000))],
  ] as const) {
    try { process.kill(-identity.pgid, signal); }
    catch (error) {
      if (recoveredProcessGroupAlive(identity)) errors.push(`${signal} delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (await waitForRecoveredProcessGroupExit(identity, waitMs)) return;
  }
  throw new Error(
    `${opts.label} recovered process group remained alive after SIGKILL` +
    `${errors.length ? ` (${errors.join("; ")})` : ""}`,
  );
}

function waitForRecoveredProcessGroupExit(
  identity: RuntimeProcessIdentity,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const check = (): void => {
      if (!recoveredProcessGroupAlive(identity)) {
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
      // An unusual launcher may not make the child its process
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
