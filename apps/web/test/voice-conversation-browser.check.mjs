import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const root = fileURLToPath(new URL("..", import.meta.url));
let output;
const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
let browser; let server;
try {
  output = await mkdtemp(path.join(tmpdir(), "ponderosa-speech-browser-"));
  const playwrightModule = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? pathToFileURL(serverRequire.resolve("playwright-core")).href);
  const chromium = playwrightModule.chromium ?? playwrightModule.default.chromium;
  const build = await createRsbuild({ cwd: root, rsbuildConfig: { plugins: [pluginReact()],
    source: { transformImport: [], entry: { index: path.join(root, "test/voice-conversation-browser-entry.tsx") } },
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
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH, args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] }); const page = await browser.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await page.getByRole("button", { name: "Talk · Preview" }).count(), 0);
  await page.getByRole("button", { name: "Voice input", exact: true }).click();
  await page.getByRole("menuitem", { name: "Dictate", exact: true }).click();
  await page.waitForFunction(() => window.voiceTest.stats.starts === 1);
  await page.evaluate(() => window.voiceTest.recognized("Draft only"));
  await page.waitForFunction(() => document.getElementById("draft").textContent === "Draft only");
  assert.equal(await page.evaluate(() => window.voiceTest.stats.sends.length), 0);
  const stoppedNotice = page.getByRole("status").filter({ hasText: "Dictation stopped" });
  await stoppedNotice.waitFor();
  await page.waitForTimeout(2000);
  assert.equal(await stoppedNotice.count(), 1);
  await stoppedNotice.waitFor({ state: "detached", timeout: 2500 });
  await page.evaluate(() => { window.voiceTest.stats.starts = 0; });
  await page.getByRole("button", { name: "Voice input", exact: true }).click();
  await page.getByRole("menuitem", { name: "Talk", exact: true }).click();
  await page.getByRole("button", { name: "Listen", exact: true }).click();
  await page.evaluate(() => window.voiceTest.recognized("Hello agent"));
  await page.getByRole("button", { name: "Send turn", exact: true }).click();
  await page.waitForFunction(() => window.voiceTest.stats.spoken.length === 1);
  assert.equal(await page.evaluate(() => window.voiceTest.stats.spoken[0]), "Your exact reply.");
  assert.equal(await page.evaluate(() => window.voiceTest.stats.starts), 1);
  await page.evaluate(() => window.voiceTest.complete());
  await page.getByRole("button", { name: "Listen", exact: true }).click();
  await page.evaluate(() => { window.voiceTest.stats.fail = true; window.voiceTest.recognized("Retry this turn"); });
  await page.getByRole("button", { name: "Send turn", exact: true }).click();
  await page.getByRole("button", { name: "Retry turn", exact: true }).waitFor();
  await page.evaluate(() => { window.voiceTest.stats.fail = false; window.voiceTest.stats.waiting = true; });
  await page.getByRole("button", { name: "Retry turn", exact: true }).click();
  await page.waitForFunction(() => window.voiceTest.stats.sends.length === 3);
  const sends = await page.evaluate(() => window.voiceTest.stats.sends);
  assert.deepEqual(sends[1], sends[2]);
  assert.deepEqual(sends[0].recipients, [{ agentId: "agent" }]);
  assert.equal(sends[0].activeRunDelivery, "queue");
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await page.evaluate(() => { window.voiceTest.stats.waiting = false; });
  await page.waitForTimeout(1700);
  assert.equal(await page.evaluate(() => window.voiceTest.stats.spoken.length), 1);
  await page.getByRole("button", { name: "Voice input", exact: true }).click();
  await page.getByRole("menuitem", { name: "Talk", exact: true }).click();
  await page.getByRole("button", { name: "Listen", exact: true }).click();
  await page.evaluate(() => { window.voiceTest.stats.finalOnStop = true; });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  assert.equal(await page.getByLabel("Your next turn").inputValue(), "Final words on pause");
  await page.getByRole("button", { name: "End session", exact: true }).click();
  assert.deepEqual(errors, []);
  for (const failure of ["not-allowed", "network", "timeout"]) {
    await page.getByRole("button", {name:"Voice input",exact:true}).click();
    await page.getByRole("menuitem", {name:"Dictate",exact:true}).click();
    if (failure === "timeout") {
      await page.evaluate(() => { window.voiceTest.stats.hangStop = true; });
      await page.getByRole("button", {name:"Stop voice dictation",exact:true}).click();
    } else await page.evaluate(error => window.voiceTest.failRecognition(error), failure);
    const alert=page.getByRole("alert"); await alert.waitFor({timeout:6000});
    const message=await alert.innerText();
    await page.waitForTimeout(3300);
    assert.equal(await alert.innerText(),message,`${failure} must remain actionable after three seconds`);
  }
  await page.evaluate(() => { window.voiceTest.stats.hangStop = false; window.voiceTest.stats.finalOnStop = false; });
  await page.getByRole("button", { name: "Voice input", exact: true }).click();
  await page.getByRole("menuitem", { name: "Dictate", exact: true }).click();
  const draftBefore = await page.locator("#draft").textContent();
  const sendsBefore = await page.evaluate(() => window.voiceTest.stats.sends.length);
  await page.evaluate(() => {
    window.oldResult = window.voiceTest.staleResult();
    window.oldEnd = window.voiceTest.staleEnd();
    window.dispatchEvent(new Event("pagehide"));
    window.oldResult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "Late abandoned speech" } }] });
    window.oldEnd();
  });
  assert.equal(await page.locator("#draft").textContent(), draftBefore, "abandoned recognition cannot append speech");
  await page.getByRole("button", { name: "Voice input", exact: true }).click();
  await page.getByRole("menuitem", { name: "Dictate", exact: true }).click();
  await page.evaluate(() => {
    window.oldResult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "Late replacement speech" } }] });
    window.oldEnd();
    window.voiceTest.recognized("Fresh recovered speech");
  });
  assert.equal(await page.locator("#draft").textContent(), `${draftBefore}Fresh recovered speech`);
  assert.equal(await page.evaluate(() => window.voiceTest.stats.sends.length), sendsBefore, "dictation recovery never submits a message");
  assert.deepEqual(errors, []);
  console.log("PASS voice transcript review, exact reply, manual next turn, stable retry, queued recipient, and end-session late-response fence, abandoned recognition and fresh-generation recovery (browser fixture).");

} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  if (output) await rm(output, { recursive: true, force: true });
}
