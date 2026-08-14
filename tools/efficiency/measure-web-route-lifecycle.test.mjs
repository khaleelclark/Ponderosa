import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const script = new URL("./measure-web-route.mjs", import.meta.url);
const browserExecutable = process.env.PONDEROSA_BROWSER_EXECUTABLE || "google-chrome-stable";

function groupExists(pid) {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`measurement process did not exit within ${timeoutMs} ms`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function createRecordingBrowser(tempRoot, executable) {
  const pidFile = path.join(tempRoot, "chrome.pid");
  const wrapper = path.join(tempRoot, "record-chrome-pid.sh");
  await writeFile(wrapper, [
    "#!/bin/sh",
    "printf '%s\\n' \"$$\" > \"$PONDEROSA_MEASURE_WEB_ROUTE_CHROME_PID_FILE\"",
    "exec \"$PONDEROSA_REAL_BROWSER_EXECUTABLE\" \"$@\"",
    "",
  ].join("\n"));
  await chmod(wrapper, 0o755);
  return { wrapper, pidFile, executable };
}

async function runFailure({ executable = browserExecutable, failAt, recordChromeGroup = false }) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "measure-web-route-test-"));
  let chromePid;
  try {
    const recordingBrowser = recordChromeGroup
      ? await createRecordingBrowser(tempRoot, executable)
      : undefined;
    const child = spawn(process.execPath, [script.pathname, "http://127.0.0.1:1/settings"], {
      env: {
        ...process.env,
        TMPDIR: tempRoot,
        PONDEROSA_BROWSER_EXECUTABLE: recordingBrowser?.wrapper ?? executable,
        ...(recordingBrowser ? {
          PONDEROSA_REAL_BROWSER_EXECUTABLE: recordingBrowser.executable,
          PONDEROSA_MEASURE_WEB_ROUTE_CHROME_PID_FILE: recordingBrowser.pidFile,
        } : {}),
        ...(failAt ? { PONDEROSA_MEASURE_WEB_ROUTE_FAIL_AT: failAt } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("failure reproduction timed out")), 10_000);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.notEqual(result.code, 0, stderr);
    if (recordingBrowser) {
      chromePid = Number.parseInt((await readFile(recordingBrowser.pidFile, "utf8")).trim(), 10);
      assert(Number.isSafeInteger(chromePid) && chromePid > 0);
      assert.equal(groupExists(chromePid), false, `Chrome process group ${chromePid} survived ${failAt}`);
    }
    const entries = await readdir(tempRoot);
    assert.deepEqual(
      entries.filter(entry => entry.startsWith("ponderosa-web-route-")),
      [],
      `profile leaked after ${failAt ?? executable}: ${stderr}`,
    );
    return stderr;
  } finally {
    if (chromePid && groupExists(chromePid)) {
      try { process.kill(-chromePid, "SIGKILL"); } catch { /* The group exited during cleanup. */ }
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test("removes the profile when Chrome exits during startup", async () => {
  const stderr = await runFailure({ executable: "/bin/false" });
  assert.match(stderr, /Chrome exited before DevTools opened/u);
});

test("removes the profile when the Chrome executable cannot spawn", async () => {
  const stderr = await runFailure({ executable: "/definitely-missing-ponderosa-chrome" });
  assert.match(stderr, /ENOENT/u);
});

for (const stage of ["after-profile", "after-target", "after-socket", "measurement-timeout"]) {
  test(`closes Chrome and removes the profile after ${stage}`, async t => {
    try {
      const stderr = await runFailure({ failAt: stage, recordChromeGroup: stage !== "after-profile" });
      assert.match(stderr, new RegExp(`injected ${stage} failure`, "u"));
    } catch (error) {
      if (String(error).includes("ENOENT")) t.skip(`${browserExecutable} is unavailable`);
      else throw error;
    }
  });
}

for (const [stage, expectedError] of [
  ["missing-target", /Chrome page target is unavailable/u],
  ["socket-open-error", /ECONNREFUSED|closed before the connection was established/u],
  ["socket-open-timeout", /Chrome DevTools socket open timed out/u],
  ["protocol-command-timeout", /Page\.enable timed out after 50 ms/u],
]) {
  test(`closes Chrome and removes the profile after ${stage}`, async t => {
    try {
      const stderr = await runFailure({ failAt: stage, recordChromeGroup: true });
      assert.match(stderr, expectedError);
    } catch (error) {
      if (String(error).includes("ENOENT")) t.skip(`${browserExecutable} is unavailable`);
      else throw error;
    }
  });
}

test("cleans up a hanging navigation without an unhandled load-event rejection", { timeout: 25_000 }, async t => {
  if (process.platform === "win32") {
    t.skip("the measurement harness uses detached POSIX process groups");
    return;
  }
  const tempRoot = await mkdtemp(path.join(tmpdir(), "measure-web-route-hanging-navigation-"));
  const recordingBrowser = await createRecordingBrowser(tempRoot, browserExecutable);

  const acceptedSockets = new Set();
  let resolveAccepted;
  const accepted = new Promise(resolve => { resolveAccepted = resolve; });
  const server = createServer(socket => {
    acceptedSockets.add(socket);
    socket.once("end", () => socket.end());
    socket.resume();
    resolveAccepted();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");

  let child;
  let chromePid;
  let stderr = "";
  try {
    child = spawn(process.execPath, [script.pathname, `http://127.0.0.1:${address.port}/settings`], {
      env: {
        ...process.env,
        TMPDIR: tempRoot,
        PONDEROSA_BROWSER_EXECUTABLE: recordingBrowser.wrapper,
        PONDEROSA_REAL_BROWSER_EXECUTABLE: recordingBrowser.executable,
        PONDEROSA_MEASURE_WEB_ROUTE_CHROME_PID_FILE: recordingBrowser.pidFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    await Promise.race([
      accepted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Chrome did not reach the hanging TCP server")), 8_000)),
    ]);
    chromePid = Number.parseInt((await readFile(recordingBrowser.pidFile, "utf8")).trim(), 10);
    assert(Number.isSafeInteger(chromePid) && chromePid > 0);

    const startedAt = Date.now();
    const result = await waitForChild(child, 16_000);
    assert(Date.now() - startedAt < 16_000, "hanging navigation failure was not bounded");
    assert.notEqual(result.code, 0, stderr);
    assert.match(stderr, /Page\.loadEventFired timed out/u);
    assert.match(stderr, /Page\.navigate timed out/u);
    await Promise.all([...acceptedSockets].map(socket => socket.destroyed
      ? Promise.resolve()
      : Promise.race([
          new Promise(resolve => socket.once("close", resolve)),
          new Promise((_, reject) => setTimeout(() => reject(new Error("hanging navigation socket remained open")), 2_000)),
        ])));
    assert([...acceptedSockets].every(socket => socket.destroyed));
    assert.equal(groupExists(chromePid), false, `Chrome process group ${chromePid} survived cleanup`);
    const entries = await readdir(tempRoot);
    assert.deepEqual(
      entries.filter(entry => entry.startsWith("ponderosa-web-route-")),
      [],
      `profile leaked after hanging navigation: ${stderr}`,
    );
  } catch (error) {
    if (String(error).includes("ENOENT") || stderr.includes("ENOENT")) {
      t.skip(`${browserExecutable} is unavailable`);
      return;
    }
    throw error;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (chromePid && groupExists(chromePid)) {
      try { process.kill(-chromePid, "SIGKILL"); } catch { /* The group exited during cleanup. */ }
    }
    for (const socket of acceptedSockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});
