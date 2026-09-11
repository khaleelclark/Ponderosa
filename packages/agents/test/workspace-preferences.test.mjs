import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceStore } from "../dist/index.js";

test("legacy preferences gain stable monotonic revisions across replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-workspace-preferences-"));
  try {
    const first = new WorkspaceStore(directory);
    const base = first.getPreferences();
    first.updatePreferences({ sidebarWidth: 300 });
    first.updatePreferences({ fontFamily: "system" });
    const persisted = readFileSync(join(directory, "workspace-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    delete persisted[0].event.preferences.revision;
    delete persisted[1].event.preferences.revision;
    writeFileSync(
      join(directory, "workspace-events.jsonl"),
      `${persisted.map(record => JSON.stringify(record)).join("\n")}\n`,
    );

    const restored = new WorkspaceStore(directory);
    assert.equal(base.revision, 0);
    assert.equal(restored.getPreferences().revision, 2);
    assert.deepEqual(
      restored.readSince(0)
        .filter(({ event }) => event.type === "preferences_updated")
        .map(({ event }) => event.preferences.revision),
      [1, 2],
      "legacy SSE replay carries the normalized canonical sequence",
    );
    assert.equal(restored.updatePreferences({ sidebarWidth: 320 }).revision, 3);
    assert.equal(new WorkspaceStore(directory).getPreferences().revision, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
