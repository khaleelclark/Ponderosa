import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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

test("Linux voice sandbox hides host files and the host loopback network", { skip: process.platform !== "linux" }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ponderosa-speech-isolation-"));
  const server = net.createServer(socket => socket.end());
  try {
    const secret = path.join(temporary, "host-only.txt");
    await fs.writeFile(secret, "test sentinel");
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const fixture = path.join(temporary, "isolation.mjs");
    await fs.writeFile(fixture, `
      const fs = require("node:fs");
      const net = require("node:net");
      if (fs.existsSync(${JSON.stringify(secret)})) throw new Error("host file visible");
      const socket = net.connect(${server.address().port}, "127.0.0.1");
      socket.on("connect", () => { socket.destroy(); process.exit(1); });
      socket.on("error", () => { clearTimeout(timer); console.log("isolated"); });
      const timer = setTimeout(() => { socket.destroy(); console.log("isolated"); }, 1000);
    `);
    const launch = speechLaunch("/usr/bin/node", fixture, "voice_1");
    const result = spawnSync(launch.command, launch.args, {
      env: {}, input: "", encoding: "utf8", timeout: 5_000, maxBuffer: 8_192,
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /isolated/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
