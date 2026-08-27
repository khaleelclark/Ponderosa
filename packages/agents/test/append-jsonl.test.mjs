import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendFsyncedJsonl,
  readRepairableJsonl,
  writeAtomicFsyncedJsonl,
} from "../dist/append-jsonl.js";

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
