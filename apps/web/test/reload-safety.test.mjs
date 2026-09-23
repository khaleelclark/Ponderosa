import assert from "node:assert/strict";
import test from "node:test";
import { reloadBlockers, setReloadBlocker } from "../src/reloadSafety.js";

test("reload blockers are exact, idempotent, and removable", () => {
  setReloadBlocker("mutation", true);
  setReloadBlocker("settings", true);
  setReloadBlocker("mutation", true);
  assert.deepEqual(reloadBlockers(), ["mutation", "settings"]);
  setReloadBlocker("mutation", false);
  setReloadBlocker("settings", false);
  assert.deepEqual(reloadBlockers(), []);
});
