import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { codexAvailabilityStatus } from "../dist/auth.js";

const authenticated = async () => ({ authenticated: true });
const stream = (...events) => events.map((event) => JSON.stringify(event)).join("\n");
const success = stream(
  { type: "thread.started", thread_id: "probe" },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: "PONDEROSA_RUNTIME_READY" } },
  { type: "turn.completed" },
);

test("Codex probe is bounded, ephemeral, read-only, and requires settled exact output", async () => {
  let temporaryCwd;
  const result = await codexAvailabilityStatus({}, async (_bin, args, options) => {
    assert.equal(args[0], "exec");
    for (const flag of ["--json", "--ephemeral", "--ignore-user-config"])
      assert.ok(args.includes(flag), flag);
    assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2),
      ["--sandbox", "read-only"]);
    assert.equal(options.timeout, 60_000);
    temporaryCwd = options.cwd;
    assert.equal(existsSync(temporaryCwd), true);
    return { stdout: success, stderr: "" };
  }, authenticated);
  assert.equal(result.available, true);
  assert.equal(existsSync(temporaryCwd), false);
  for (const stdout of [
    success.replace("PONDEROSA_RUNTIME_READY", "something else"),
    stream({ type: "item.completed", item: { type: "agent_message", text: "PONDEROSA_RUNTIME_READY" } }),
    stream({ type: "turn.failed" }),
    "not json",
    stream({ type: "item.started", item: { type: "command_execution", command: "pwd" } },
      { type: "item.completed", item: { type: "agent_message", text: "PONDEROSA_RUNTIME_READY" } },
      { type: "turn.completed" }),
  ]) {
    const checked = await codexAvailabilityStatus({}, async () => ({ stdout, stderr: "" }), authenticated);
    assert.equal(checked.available, false, stdout);
  }
});

test("Codex probe does not contact provider when unauthenticated", async () => {
  const result = await codexAvailabilityStatus({}, async () => {
    throw new Error("should not run");
  }, async () => ({ authenticated: false, detail: "sign in" }));
  assert.equal(result.available, false);
  assert.equal(result.failureCategory, "authentication");
});
