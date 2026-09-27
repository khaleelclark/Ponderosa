import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnWindowsContainedProcess } from "../dist/index.js";

test("Windows browser pipe gate owns and terminates descendants", { skip: process.platform !== "win32" }, async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ponderosa-browser-job-"));
  t.after(async () => { await rm(cwd, { recursive: true, force: true }); });
  const script = `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const input = fs.createReadStream('', { fd: 3, autoClose: false });
    const output = fs.createWriteStream('', { fd: 4, autoClose: false });
    input.on('data', bytes => output.write(bytes));
    setInterval(() => {}, 1000);
  `;
  const { child, authority } = spawnWindowsContainedProcess({
    bin: process.execPath, args: ["-e", script], cwd,
    env: process.env, stdin: "pipe", browserPipe: true,
  });
  t.after(() => { authority.terminate(); authority.close(); });
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("browser pipe did not respond")), 5000);
    child.stdout.once("data", bytes => { clearTimeout(timeout); resolve(bytes.toString()); });
    child.once("error", reject);
  });
  child.stdin.write("CDP-PING");
  assert.equal(await response, "CDP-PING");
  assert.equal(authority.isAlive(), true);
  authority.terminate();
  const deadline = Date.now() + 5000;
  while (authority.isAlive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(authority.isAlive(), false, "the Job must report no Chrome-like descendants");
});
