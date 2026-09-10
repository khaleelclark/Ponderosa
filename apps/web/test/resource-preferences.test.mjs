import assert from "node:assert/strict";
import test from "node:test";
import {
  projectOrderPreferenceKey,
  synchronizeProjectRailOrder,
} from "../src/resourcePreferences.js";

test("canonical Project order changes produce a new rail synchronization key", () => {
  const first = projectOrderPreferenceKey({ projectSort: "custom", projectOrder: ["a", "b"] });
  const reordered = projectOrderPreferenceKey({ projectSort: "custom", projectOrder: ["b", "a"] });
  const alphabetical = projectOrderPreferenceKey({ projectSort: "alphabetical", projectOrder: ["a", "b"] });
  assert.notEqual(first, reordered);
  assert.notEqual(first, alphabetical);
  assert.deepEqual(
    synchronizeProjectRailOrder(["a", "b"], ["b", "a"], true),
    ["b", "a"],
  );
  assert.deepEqual(
    synchronizeProjectRailOrder(["a", "b"], ["b", "a", "c"], false),
    ["a", "b", "c"],
  );
});

test("alphabetical Project identity changes resynchronize without changing custom order", () => {
  const alphabetical = { projectSort: "alphabetical", projectOrder: [] };
  const beforeRename = projectOrderPreferenceKey(alphabetical, [
    { id: "b", label: "Beta" },
    { id: "a", label: "Zulu" },
  ]);
  const afterRename = projectOrderPreferenceKey(alphabetical, [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
  ]);
  assert.notEqual(beforeRename, afterRename);

  const custom = { projectSort: "custom", projectOrder: ["b", "a"] };
  assert.equal(
    projectOrderPreferenceKey(custom, [{ id: "b", label: "Before" }]),
    projectOrderPreferenceKey(custom, [{ id: "b", label: "After" }]),
  );
});
