import assert from "node:assert/strict";
import test from "node:test";
import { windowsJobObjectsSupported } from "../dist/index.js";

test("Windows Job Object capability fails closed by platform", () => {
  assert.equal(windowsJobObjectsSupported("linux"), false);
  assert.equal(windowsJobObjectsSupported("darwin"), false);
  if (process.platform !== "win32") assert.equal(windowsJobObjectsSupported(), false);
});
