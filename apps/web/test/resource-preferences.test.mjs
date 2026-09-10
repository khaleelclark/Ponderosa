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
