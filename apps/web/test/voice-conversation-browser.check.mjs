import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "ponderosa-speech-browser-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
let browser; let server;
try {
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
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH }); const page = await browser.newPage();
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
  console.log("PASS voice transcript review, exact reply, manual next turn, stable retry, queued recipient, and end-session late-response fence (browser fixture).");

} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(output, { recursive: true, force: true });
}
