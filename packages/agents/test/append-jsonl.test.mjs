import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  appendFsyncedJsonl,
  readRepairableJsonl,
  writeAtomicFsyncedJsonl,
} from "../dist/append-jsonl.js";
import { EventLog } from "../dist/eventlog.js";
import { WorkspaceStore } from "../dist/workspace-store.js";

test("JSONL persistence appends, replaces, and repairs only a torn tail", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-jsonl-"));
  const file = join(directory, "events.jsonl");

  try {
    appendFsyncedJsonl(file, [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(readRepairableJsonl(file, "events"), [{ id: 1 }, { id: 2 }]);

    writeAtomicFsyncedJsonl(file, [{ id: 3 }]);
    assert.equal(readFileSync(file, "utf8"), '{"id":3}\n');
    assert.deepEqual(readdirSync(directory), ["events.jsonl"]);

    writeFileSync(file, '{"id":4}\n{"id":', "utf8");
    assert.deepEqual(readRepairableJsonl(file, "events", true), [{ id: 4 }]);
    assert.equal(readFileSync(file, "utf8"), '{"id":4}\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uncertain Agent and workspace appends fence writers until restart repair", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-uncertain-jsonl-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agentLog = new EventLog(join(directory, "agent-events.jsonl"));
  const workspace = new WorkspaceStore(join(directory, "workspace"));
  const originalWrite = fs.writeSync;
  const failure = () => t.mock.method(fs, "writeSync", (fd, bytes, offset, length) => {
    originalWrite(fd, bytes, offset, Math.min(5, length));
    throw new Error("injected partial append");
  });
  let injected = failure();
  assert.throws(() => agentLog.append({ type: "text", delta: "first", executionId: "run" }), /injected partial append/);
  injected.mock.restore();
  assert.throws(() => agentLog.append({ type: "text", delta: "second", executionId: "run" }), /outcome is uncertain/);
  injected = failure();
  assert.throws(() => workspace.append({ type: "project_changed", projectId: "project", action: "updated" }), /injected partial append/);
  injected.mock.restore();
  assert.throws(() => workspace.append({ type: "project_changed", projectId: "project", action: "updated" }), /outcome is uncertain/);

  // A new process has no writer cache: startup repairs the torn tails before
  // assigning the next Agent seq or workspace envelope id.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { EventLog } from ${JSON.stringify(new URL("../dist/eventlog.js", import.meta.url).href)};
    import { WorkspaceStore } from ${JSON.stringify(new URL("../dist/workspace-store.js", import.meta.url).href)};
    const agent = new EventLog(${JSON.stringify(join(directory, "agent-events.jsonl"))});
    const workspace = new WorkspaceStore(${JSON.stringify(join(directory, "workspace"))});
    if (agent.append({ type: "text", delta: "recovered", executionId: "run" }).seq !== 1) process.exit(2);
    if (workspace.append({ type: "project_changed", projectId: "project", action: "updated" }).id !== 1) process.exit(3);
  `], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
});
