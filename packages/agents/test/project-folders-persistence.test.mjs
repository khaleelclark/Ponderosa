import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceStore } from "../dist/index.js";

test("Project folder membership, names, order and expansion survive replay and unrelated preferences", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-project-folders-"));
  try {
    const store = new WorkspaceStore(directory);
    const folders = [{ id: "work", name: "Work", projectIds: ["b", "a"], expanded: false }];
    store.updatePreferences({ projectFolders: folders });
    store.updatePreferences({ sidebarWidth: 320 });
    const restored = new WorkspaceStore(directory);
    assert.deepEqual(restored.getPreferences().projectFolders, folders);
    restored.updatePreferences({ projectFolders: [] });
    assert.deepEqual(new WorkspaceStore(directory).getPreferences().projectFolders, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
