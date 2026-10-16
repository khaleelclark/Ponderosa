import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { RuntimeProcessIdentity } from "@ponderosa/core";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

type Scope = NonNullable<RuntimeProcessIdentity["scope"]>;
const scopes = new WeakMap<ChildProcess, Scope>();
const observations = new Map<string, { at: number; alive: boolean; wasActive: boolean }>();
const closed = new Set<string>();
const pending = new Map<string, Promise<boolean>>();
const run = promisify(execFile);
let tail: Promise<unknown> = Promise.resolve();
export function registerSystemdScope(child: ChildProcess, scope: Scope): void { scopes.set(child, scope); }
export function processScope(child: ChildProcess): Scope | undefined { return scopes.get(child); }
export function validateSystemdScope(scope: Scope): void {
  if (process.platform !== "linux" || !/^ponderosa-agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.scope$/u.test(scope.unit) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(scope.authorityId)) throw Error("invalid durable provider scope identity");
}
async function observation(scope: Scope): Promise<boolean> {
  validateSystemdScope(scope);
  let stdout: string;
  try { ({ stdout } = await run("systemctl", ["--user", "show", scope.unit, "--property=LoadState", "--property=ActiveState", "--property=Description", "--property=ControlGroup"],
    { encoding: "utf8", timeout: 500, killSignal: "SIGKILL", maxBuffer: 8192 })); }
  catch (error) {
    const failure = error as { code?: number; stdout?: string; killed?: boolean };
    if (failure.killed || failure.code !== 1 || !failure.stdout?.includes("LoadState=not-found")) throw Error("provider scope observation unavailable");
    stdout = failure.stdout;
  }
  const fields = new Map(stdout.trim().split("\n").map(line => { const equals = line.indexOf("="); return [line.slice(0, equals), line.slice(equals + 1)]; }));
  if (fields.get("LoadState") === "not-found") return false;
  if (fields.get("Description") !== `Ponderosa process authority ${scope.authorityId}`) throw Error("provider scope ownership cannot be confirmed");
  const group = fields.get("ControlGroup");
  if (!group) {
    if (["inactive", "failed"].includes(fields.get("ActiveState") ?? "")) return false;
    throw Error("provider scope cgroup cannot be observed");
  }
  if (group.length > 4096 || !group.startsWith("/") || group.includes("..") || !group.endsWith(`/${scope.unit}`)) throw Error("invalid provider scope cgroup");
  try {
    const counters = await readFile(`/sys/fs/cgroup${group}/cgroup.events`, "utf8");
    if (counters.length > 1024 || !/^populated [01]$/mu.test(counters)) throw Error("invalid scope population observation");
    return /^populated 1$/mu.test(counters);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && ["inactive", "failed"].includes(fields.get("ActiveState") ?? "")) return false;
    throw error;
  }
}
export function observeSystemdScope(scope: Scope): Promise<boolean> {
  validateSystemdScope(scope);
  const key = `${scope.unit}:${scope.authorityId}`;
  const current = pending.get(key); if (current) return current;
  if (pending.size >= 64) return Promise.reject(Error("provider scope observation capacity reached; authority retained"));
  // One process-control observation at a time, shared across status reads and
  // cleanup. The slot remains owned until execFile observes actual exit.
  const operation = tail.then(() => observation(scope)).then(alive => {
    if (observations.size >= 256) observations.delete(observations.keys().next().value!);
    observations.set(key, { at: Date.now(), alive, wasActive: alive || observations.get(key)?.wasActive === true }); return alive;
  }).finally(() => { if (pending.get(key) === operation) pending.delete(key); });
  pending.set(key, operation); tail = operation.catch(() => undefined); return operation;
}
export function systemdScopeAlive(scope: Scope): boolean {
  validateSystemdScope(scope);
  const key = `${scope.unit}:${scope.authorityId}`;
  if (closed.has(key)) return false;
  const cached = observations.get(key);
  if (cached && Date.now() - cached.at < 2000 && (cached.alive || cached.wasActive)) return cached.alive;
  void observeSystemdScope(scope).catch(() => undefined);
  return true; // Unknown is retained authority, never proof of teardown.
}
export async function closeSystemdScope(scope: Scope): Promise<void> {
  const key = `${scope.unit}:${scope.authorityId}`;
  const markClosed = () => { if (closed.size >= 256) closed.delete(closed.values().next().value!); closed.add(key); };
  if (!await observeSystemdScope(scope)) { markClosed(); return; }
  // Observation verifies the random ownership tag before targeting this exact
  // unit. No process names, descendant PID guesses or shared slice are killed.
  await run("systemctl", ["--user", "stop", "--no-block", scope.unit], { timeout: 500, killSignal: "SIGKILL", maxBuffer: 8192 });
  const deadline = Date.now() + 4000;
  while (await observeSystemdScope(scope)) {
    if (Date.now() >= deadline) throw Error("provider scope remained active after stop; cleanup authority retained");
    await delay(50);
  }
  // Preserve the observed terminal state for read-only process projections.
  markClosed();
}
