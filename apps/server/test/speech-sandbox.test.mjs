import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { speechLaunch } from "../dist/speech-launch.js";

test("Linux voice sandbox launches the fixed protocol fixture", { skip: process.platform !== "linux" }, () => {
  const fixture = fileURLToPath(new URL("./fixtures/speech-worker.mjs", import.meta.url));
  const launch = speechLaunch("/usr/bin/node", fixture, "voice_1");
  // Only this fixed fixture's stderr is diagnostic; production speech can echo user text.
  const result = spawnSync(launch.command, launch.args, {
    env: {}, input: "", encoding: "utf8", timeout: 10_000, maxBuffer: 8_192,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `Voice sandbox fixture failed: ${result.stderr}`);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /1\|sherpa-onnx-1\.13\.8\|kokoro-1\.0\|24000/);
});
