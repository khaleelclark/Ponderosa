// Run against experimental; mutations are intercepted so no live messages or drafts change.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "/home/phoenix/khaleel/ZindyCast/node_modules/playwright/index.mjs");
const base = process.env.PONDEROSA_BASE_URL ?? "http://127.0.0.1:8798";
const feed = await (await fetch(`${base}/api/all-chat?limit=50`)).json();
const item = feed.items.find(item => item.directMessageAgent);
assert.ok(item, "test requires one replyable message");
const target = { ...item.directMessageAgent, projectId: item.project.id };
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/home/phoenix/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome" });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.addInitScript(target => {
      localStorage.setItem("messages:composer:reply-target", JSON.stringify(target));
      localStorage.setItem("messages:composer", `#${target.handle} saved text`);
    }, target);
    await page.route("**/api/**", async route => {
      if (!["GET", "HEAD"].includes(route.request().method())) return route.fulfill({ status: 200, json: {} });
      return route.continue();
    });
    await page.goto(`${base}/messages`);
    const editor = page.getByRole("textbox", { name: "Message", exact: true });
    await editor.waitFor();
    assert.equal(await editor.getAttribute("contenteditable"), "false");
    assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true);
    const reply = page.getByRole("button", { name: `Reply to ${target.title}`, exact: true }).first();
    await reply.focus();
    await reply.press("Enter");
    await page.waitForFunction(() => document.querySelector('[role="textbox"][aria-label="Message"]')?.getAttribute("contenteditable") === "true");
    await page.reload();
    await editor.waitFor();
    assert.equal(await editor.getAttribute("contenteditable"), "false");
    assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true);
    await page.screenshot({ path: `/tmp/all-messages-explicit-reply-${width}.png` });
    await page.close();
  }
  console.log("PASS desktop/mobile: persisted recipient/draft cannot arm All Messages; explicit message reply selects; reload clears selection");
} finally { await browser.close(); }
