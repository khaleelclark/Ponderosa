import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const profile = await mkdtemp(path.join(tmpdir(), "ponderosa-extension-load-"));
const extension = fileURLToPath(new URL("../dist", import.meta.url));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.PONDEROSA_EXTENSION_CHROMIUM_PATH, headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-sandbox"] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  assert.match(worker.url(), /^chrome-extension:\/\/[a-p]{32}\/worker.js$/);
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["activeTab", "tabs", "debugger", "storage"]);
  const page = await context.newPage();
  await context.route("https://application.test/**", route => route.fulfill({ contentType: "text/html", body: "<title>Application fixture</title><input id=name>" }));
  await page.goto("https://application.test/form");
  const result = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Fixture tab missing");
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
    try { return await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", { expression: "document.title", returnByValue: true }); }
    finally { await chrome.debugger.detach({ tabId: tab.id }); }
  });
  assert.equal(result.result.value, "Application fixture");
  const popup = await context.newPage();
  await popup.goto(worker.url().replace("worker.js", "popup.html"));
  await popup.getByRole("button", { name: "Connect this window", exact: true }).waitFor();
  assert.equal(await popup.locator("input[type=password]").count(), 0);
  console.log("PASS: actual unpacked MV3 service worker, tab debugger permission, DOM inspection, detach, and popup rendering");
  console.log("Manual toolbar popup, permission consent, and real OAuth remain user qualification.");
} finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
