import assert from "node:assert/strict";
import test from "node:test";
import { hostProcessBirthMarker } from "../dist/index.js";

test("shared launcher and runtime marker rejects invalid or unsupported process identities", () => {
  for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(hostProcessBirthMarker(pid), undefined);
  }
  assert.equal(hostProcessBirthMarker(process.pid, "win32"), undefined);
  if (process.platform === "linux" || process.platform === "darwin") {
    assert.match(hostProcessBirthMarker(process.pid), new RegExp(`^${process.platform}:`));
  }
});
