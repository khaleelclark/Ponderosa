import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createRsbuild } from "@rsbuild/core";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "ponderosa-speech-browser-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? new URL("../../server/node_modules/playwright-core/index.mjs", import.meta.url).href);
let browser; let server;
try {
  const build = await createRsbuild({ cwd: root, rsbuildConfig: {
    source: { entry: { index: path.join(root, "test/speech-browser-entry.ts") } },
    output: { distPath: { root: output } }, logLevel: "error",
  } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname.includes("..")) { response.writeHead(400).end(); return; }
    try {
      const file = path.join(output, pathname === "/" ? "index.html" : pathname);
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH, args: (process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" || (process.env.CI === "true" && process.platform === "linux")) ? ["--no-sandbox"] : [] }); const page = await browser.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => Boolean(window.speechTest));
  const call = (method, ...args) => page.evaluate(({ method, args }) => window.speechTest[method](...args), { method, args });
  await call("start", "one"); assert.equal((await call("speechSnapshot")).status, "speaking");
  await call("pauseSpeech"); assert.equal((await call("speechSnapshot")).status, "paused");
  await call("resumeSpeech"); assert.equal((await call("speechSnapshot")).status, "speaking");
  await page.evaluate(() => { window.staleEnd = window.speechTest.staleEnd(); });
  await call("start", "two");
  await page.evaluate(() => window.staleEnd());
  assert.equal((await call("speechSnapshot")).ownerId, "two");
  assert.equal((await call("speechSnapshot")).status, "speaking");
  await call("end");
  assert.equal((await call("speechSnapshot")).status, "stopped");
  assert.equal(await page.evaluate(() => window.speechTest.stats.completions), 1);
  await call("start", "one");
  await page.evaluate(() => { document.getElementById("one").hidden = true; });
  await page.waitForFunction(() => window.speechTest.speechSnapshot().status === "stopped");
  await page.evaluate(() => { document.getElementById("one").hidden = false; });
  await call("start", "one"); await call("fail");
  assert.equal((await call("speechSnapshot")).status, "error");
  await call("start", "two"); await call("releaseSpeechSurface", "two");
  assert.equal((await call("speechSnapshot")).status, "stopped");
  assert.equal(await page.evaluate(() => window.speechTest.stats.requests), 0);
  // Retained callbacks from an old generation must be inert even when the
  // replacement reuses the same surface ID and cancellation itself throws.
  await call("start", "two");
  await page.evaluate(() => {
    window.oldEnd = window.speechTest.staleEnd();
    window.oldError = window.speechTest.staleError();
    window.speechTest.stats.cancelThrows = true;
  });
  await call("start", "two");
  await page.evaluate(() => { window.oldEnd(); window.oldError(); });
  assert.equal((await call("speechSnapshot")).status, "speaking");
  assert.equal((await call("speechSnapshot")).ownerId, "two");
  assert.equal(await page.evaluate(() => window.speechTest.stats.completions), 1);
  await page.evaluate(() => { window.speechTest.stats.cancelThrows = false; });
  for (const failure of ["constructorThrows", "speakThrows"]) {
    await page.evaluate(failure => { window.speechTest.stats[failure] = true; }, failure);
    await call("start", "one");
    assert.equal((await call("speechSnapshot")).status, "error");
    await page.evaluate(failure => { window.speechTest.stats[failure] = false; }, failure);
    await call("start", "two");
    assert.equal((await call("speechSnapshot")).status, "speaking", `${failure} permits a fresh retry`);
  }
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  assert.equal((await call("speechSnapshot")).status, "stopped");
  await call("start", "one");
  assert.equal((await call("speechSnapshot")).status, "speaking");
  await call("releaseSpeechSurface", "one");
  assert.equal((await call("speechSnapshot")).status, "stopped");
  assert.equal(await page.evaluate(() => window.speechTest.stats.requests), 0);
  await page.evaluate(() => { window.speechTest.stats.hangStart = true; });
  await call("start", "one"); assert.equal((await call("speechSnapshot")).status, "loading", "speak() does not prove playback started");
  await page.waitForFunction(() => window.speechTest.speechSnapshot().status === "error", {timeout:5000});
  await page.evaluate(() => { window.speechTest.stats.hangStart = false; window.speechTest.stats.cancelThrows = true; });
  await call("start", "one"); await call("stopSpeech", "one");
  assert.match((await call("speechSnapshot")).error, /cleanup could not be confirmed/);
  await page.evaluate(() => { window.speechTest.stats.cancelThrows = false; });
  assert.deepEqual(errors, []);
  console.log("PASS browser-only playback, pause/resume, completion, hidden-surface cleanup, supersession, stale callbacks, failure/retry, throwing cleanup, same-owner stale callbacks, pagehide and zero synthesis requests.");
} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(output, { recursive: true, force: true });
}
