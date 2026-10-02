import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const exec = promisify(execFile);

test("separate application processes retain exact parent/dependency wake and settle once after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dependency-process-restart-"));
  const fixture = fileURLToPath(new URL("./fixtures/dependency-restart.mjs", import.meta.url));
  try {
    const run = async phase => JSON.parse((await exec(process.execPath, [fixture, directory, phase], { timeout: 20000 })).stdout.trim());
    const before = await run("before"); assert.equal(before.parentState, "in_progress");
    const after = await run("after"); assert.notEqual(after.pid, before.pid); assert.equal(after.ownerId, before.ownerId);
    assert.equal(after.parentState, "completed"); assert.equal(after.wakeKind, "coordination_join_satisfied");
    assert.equal(after.parentCount, 1); assert.equal(after.terminalCount, 1); assert.equal(after.wakeCount, 1); assert.equal(after.remaining, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
