import assert from "node:assert/strict";
import test from "node:test";
import { claudeAvailabilityStatus } from "../dist/auth.js";

const authenticated = async () => ({ authenticated: true });
const probe = (stdout) => claudeAvailabilityStatus(
  {},
  async () => ({ stdout, stderr: "" }),
  authenticated,
);

test("Claude reachability requires a settled success result and exact marker", async () => {
  const success = JSON.stringify({
    type: "result", subtype: "success", is_error: false,
    result: "PONDEROSA_RUNTIME_READY\n",
  });
  assert.equal((await probe(success)).available, true);
  for (const stdout of [
    "ERROR: subscription expired",
    "",
    "{}",
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "something else" }),
    JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "subscription expired" }),
  ]) {
    assert.equal((await probe(stdout)).available, false, stdout);
  }
});
