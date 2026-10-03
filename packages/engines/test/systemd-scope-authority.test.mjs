import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnContainedCli } from "../dist/contained-spawn.js";
import { runtimeProcessHandle, recoveredRuntimeProcessHandle } from "../dist/process-termination.js";
import { observeSystemdScope } from "../dist/systemd-scope.js";

test("exact owned scope survives launcher exit, persists recovery authority, rejects wrong ownership and observes complete stop", {
  skip: process.platform !== "linux" || !process.env.PONDEROSA_TEST_PRIVATE_SLICE,
  timeout: 20000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "owned-scope-"));
  const parent = `spec3-parent-${randomUUID()}.service`, slice = process.env.PONDEROSA_TEST_PRIVATE_SLICE;
  const descendants = join(directory, "descendants.json");
  let handle, recovered;
  execFileSync("systemd-run", ["--user", "--quiet", `--unit=${parent}`, `--slice=${slice}`, "--property=RuntimeMaxSec=30", "/bin/sleep", "30"]);
  try {
    const script = join(directory, "launcher.mjs");
    await writeFile(script, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e','globalThis.memory=Buffer.alloc(32*1024*1024,1);setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore'});writeFileSync(${JSON.stringify(descendants)},JSON.stringify({pid:c.pid}));c.unref();`);
    const { child } = spawnContainedCli({ bin: process.execPath, args: [script], cwd: directory, env: { PATH: process.env.PATH, HOME: directory, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }, stdin: "ignore" }, { PONDEROSA_AGENT_SCOPE_MODE: "systemd", PONDEROSA_AGENT_PARENT_UNIT: parent, PONDEROSA_AGENT_WORKLOAD_SLICE: slice });
    handle = runtimeProcessHandle(child, { label: "owned scope", termGraceMs: 100, killConfirmationMs: 100 });
    assert.ok(handle.processIdentity?.scope);
    for (let i = 0; i < 100; i++) { try { await readFile(descendants); break; } catch { await delay(20); } }
    const pid = JSON.parse(await readFile(descendants, "utf8")).pid;
    await delay(300); assert.ok(child.exitCode !== null, "launcher exited");
    assert.equal(handle.isAlive(), true, "a retained scope is not confused with a dead launcher");
    await assert.rejects(observeSystemdScope({ ...handle.processIdentity.scope, authorityId: randomUUID() }), /ownership/);
    recovered = recoveredRuntimeProcessHandle(JSON.parse(JSON.stringify(handle.processIdentity)), { label: "restart", termGraceMs: 100, killConfirmationMs: 100 });
    assert.equal(recovered.isAlive(), true);
    await recovered.close(); assert.equal(recovered.isAlive(), false); assert.equal(handle.isAlive(), false);
    // Linux may briefly retain an adopted zombie; it no longer owns memory or
    // belongs to the scope. Live descendants must not survive.
    try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); assert.equal(stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3), "Z"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  } finally { if (recovered) await recovered.close(); if (handle) await handle.close(); execFileSync("systemctl", ["--user", "stop", parent]); await rm(directory, { recursive: true, force: true }); }
});
