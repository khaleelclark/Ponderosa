import assert from "node:assert/strict";
import test from "node:test";
import { EngineAuthStatusCache } from "../dist/engine-auth-cache.js";
import { projectProviderAuthStatus } from "../dist/provider-success-projection.js";
import { parseCodexLoginStatus, codexAuthStatus, codexAvailabilityStatus } from "../../../packages/engines/dist/auth.js";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("genuine logout differs from unrecognized status and failed probe", async () => {
  assert.equal(parseCodexLoginStatus("Not logged in").status, undefined);
  assert.equal(parseCodexLoginStatus("Not logged in").authenticated, false);
  assert.equal(parseCodexLoginStatus("unexpected output").status, "unknown");
  const result = await codexAuthStatus({ ...process.env, PONDEROSA_CODEX_BIN: "/synthetic/does-not-exist" });
  assert.equal(result.status, "unknown"); assert.ok(!/login|sign in/i.test(result.detail));
  const availability = await codexAvailabilityStatus({}, async () => { throw Error("must not probe"); }, async () => result);
  assert.equal(availability.failureCategory, "unavailable");
  assert.deepEqual(projectProviderAuthStatus(result), result);
  assert.throws(() => projectProviderAuthStatus({ authenticated: true, status: "unknown" }));
});

test("auth probes coalesce and failures have a bounded cooldown with explicitly stale known information", async () => {
  const clock = Date.now; let now = clock(); Date.now = () => now;
  try {
    const cache = new EngineAuthStatusCache(); let calls = 0;
    const success = () => { calls++; return Promise.resolve({ authenticated: true }); };
    await Promise.all(Array.from({ length: 20 }, () => cache.get("synthetic", success)));
    assert.equal(calls, 1); assert.equal(cache.snapshot("synthetic").state, "known");
    now += 31000;
    const failed = () => { calls++; return Promise.reject(Error("controlled timeout")); };
    await Promise.allSettled(Array.from({ length: 20 }, () => cache.get("synthetic", failed)));
    assert.equal(calls, 2);
    await assert.rejects(cache.get("synthetic", failed)); assert.equal(calls, 2);
    assert.equal(cache.snapshot("synthetic").state, "unknown");
    assert.equal(cache.snapshot("synthetic").lastKnown.authenticated, true);
    now += 5001; await cache.get("synthetic", success); assert.equal(calls, 3);
    now += 300001; assert.equal(cache.snapshot("synthetic").lastKnown, undefined);
  } finally { Date.now = clock; }
});

test("a real timed-out auth probe coalesces and observes owned root/descendant cleanup before settling", { timeout: 20000, skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "auth-probe-cleanup-"));
  const bin = join(directory, "synthetic-auth"), pids = join(directory, "pids");
  await writeFile(bin, `#!${process.execPath}\nimport{writeFileSync}from'node:fs';import{spawn}from'node:child_process';console.log('Not logged in');const c=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,c.pid]));setTimeout(()=>{},30000);\n`);
  await chmod(bin, 0o700);
  try {
    const cache = new EngineAuthStatusCache(); let calls = 0;
    const probe = () => { calls++; return codexAuthStatus({ ...process.env, PONDEROSA_CODEX_BIN: bin }); };
    const results = await Promise.all(Array.from({ length: 20 }, () => cache.get("synthetic", probe)));
    assert.equal(calls, 1); assert.ok(results.every(result => result.status === "unknown" && !/login|sign in/i.test(result.detail)));
    for (const pid of JSON.parse(await readFile(pids, "utf8"))) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await cache.get("synthetic", probe); assert.equal(calls, 1, "timeout cooldown does not spawn another process");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("pending reads return promptly but invalidation never releases the actual diagnostic slot", async () => {
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const cache = new EngineAuthStatusCache();
  const load = async () => { calls++; await gate; return { authenticated: true, source: "cli_status" }; };
  const first = await cache.read("synthetic", load);
  assert.equal(first.reason, "probe_pending");
  cache.invalidate("synthetic");
  await Promise.all(Array.from({ length: 20 }, () => cache.read("synthetic", load)));
  assert.equal(calls, 1); release(); await gate;
  assert.equal((await cache.get("synthetic", load)).authenticated, true); assert.equal(calls, 1);
});

test("auth reasons remain strict and historical records compatible", () => {
  assert.deepEqual(projectProviderAuthStatus({ authenticated: false }), { authenticated: false });
  for (const reason of ["timeout", "spawn_failed", "malformed", "cleanup_failed", "probe_failed", "probe_pending"]) {
    assert.equal(projectProviderAuthStatus({ authenticated: false, status: "unknown", reason, source: "cli_status" }).reason, reason);
  }
  for (const value of [{ authenticated: false, reason: "timeout" }, { authenticated: false, status: "unknown", reason: "logout" }, { authenticated: true, source: "token" }]) assert.throws(() => projectProviderAuthStatus(value));
  assert.throws(() => projectProviderAuthStatus({ authenticated: false, get reason() { throw Error("must not invoke"); } }));
});
