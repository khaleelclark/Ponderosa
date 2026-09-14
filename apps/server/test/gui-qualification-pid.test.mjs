import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processIsAlive, readPublishedProcessState } from "../../../packaging/qualification/process-state.mjs";

test("GUI qualification waits for provisional PID zero to become a real process", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ponderosa-gui-state-"));
  const file = path.join(root, "instance.json");
  try {
    await fs.writeFile(file, JSON.stringify({ pid: 0 }));
    const pending = readPublishedProcessState(file, 2_000);
    await new Promise(resolve => setTimeout(resolve, 60));
    await fs.writeFile(file, JSON.stringify({ pid: process.pid }));
    assert.equal((await pending).pid, process.pid);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("GUI qualification never probes a process group or accepts an unpublished identity", async () => {
  for (const pid of [0, -1, undefined, null, "123", 1.5, NaN]) {
    assert.equal(processIsAlive(pid, () => assert.fail("invalid PID reached the OS probe")), false);
  }
  assert.equal(processIsAlive(123, () => { throw Object.assign(new Error(), { code: "ESRCH" }); }), false);
  assert.equal(processIsAlive(123, () => { throw Object.assign(new Error(), { code: "EPERM" }); }), true);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ponderosa-gui-state-"));
  const file = path.join(root, "instance.json");
  try {
    await fs.writeFile(file, '{"pid":0,"controlToken":"test-private-token"');
    await assert.rejects(readPublishedProcessState(file, 75), error => {
      assert.match(error.message, /published process identity/);
      assert.doesNotMatch(error.message, /test-private-token/);
      return true;
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
