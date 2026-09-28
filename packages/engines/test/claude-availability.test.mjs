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

test("an expired Claude OAuth probe reports authentication instead of an unknown outage", async () => {
  const stdout = JSON.stringify({
    type: "result", subtype: "error_during_execution", is_error: true,
    result: "Failed to authenticate: OAuth session expired and could not be refreshed",
  });
  const failed = await claudeAvailabilityStatus({}, async () => {
    throw Object.assign(new Error("provider authentication probe exited with code 1"), { stdout, stderr: "" });
  }, authenticated);
  assert.equal(failed.available, false);
  assert.equal(failed.failureCategory, "authentication");
  assert.match(failed.detail, /OAuth session expired/u);

  const settledFailure = await probe(stdout);
  assert.equal(settledFailure.failureCategory, "authentication");
  assert.match(settledFailure.detail, /Sign in to Claude again/u);
});

test("empty stderr does not hide the command failure", async () => {
  const failed = await claudeAvailabilityStatus({}, async () => {
    throw Object.assign(new Error("Failed to authenticate: OAuth session expired"), { stderr: "" });
  }, authenticated);
  assert.equal(failed.failureCategory, "authentication");
});
