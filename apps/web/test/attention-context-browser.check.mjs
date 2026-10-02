import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const web = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "attention-context-"));
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
let browser, server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/attention-context-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try { const content = await readFile(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".woff2") ? "font/woff2" : "text/html" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright[engine].launch({ headless: true,
    ...(engine === "chromium" ? { executablePath: process.env.PONDEROSA_CHROMIUM_PATH } : {}) });
  const errors = [];
  for (const width of [320, 390, 430, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: width < 900 });
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.goto(url);
    await page.getByRole("button", { name: "Review All", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Needs Your Attention" });
    const card = dialog.getByRole("article", { name: "Assignment 123456789012" });
    await card.getByText("Chat: Watch support", { exact: true }).waitFor();
    await card.getByText("Add a watch complication", { exact: true }).waitFor();
    assert.equal(await card.locator("time").getAttribute("datetime"), "2026-10-01T11:59:00Z");
    assert.doesNotMatch(await card.innerText(), /provider disconnected|Work record:|Project:|cannot confirm whether/);
    assert.equal(await card.getByText("Result unconfirmed. Check activity before retrying; retrying may duplicate changes.", { exact: true }).count(), 1);
    assert.match(await card.innerText(), /may duplicate changes/);
    assert.equal(await dialog.getByText(/WHAT THIS AFFECTS|RECOMMENDED|What Happened\?/).count(), 0);
    const legacy = dialog.getByRole("article", { name: "Notice storical-one" });
    await legacy.getByText("Assignment description unavailable.", { exact: true }).waitFor();
    assert.equal(await legacy.getByText("No additional cause details were retained for this older notice.", { exact: true }).count(), 0);
    assert.match(await legacy.innerText(), /Website copy/);
    assert.match(await dialog.getByRole("article", { name: "Notice storical-two" }).innerText(), /Release review/);
    const overflow = await dialog.evaluate(e => ({ width: e.getBoundingClientRect().width, scroll: e.scrollWidth, client: e.clientWidth }));
    assert(overflow.width <= width && overflow.scroll <= overflow.client + 1, "review stays inside viewport without horizontal overflow");
    for (const button of await card.getByRole("button").all()) {
      assert((await button.boundingBox()).height >= 44, "compact actions keep touch targets");
    }
    if (process.env.PONDEROSA_ATTENTION_SCREENSHOTS) {
      await page.waitForFunction(() => Array.from(document.querySelectorAll(".MuiDialog-container")).some(e => getComputedStyle(e).opacity === "1"));
      await page.screenshot({ path: path.join(tmpdir(), `attention-compact-${engine}-${width}.png`) });
    }
    await card.getByRole("button", { name: "Details", exact: true }).click();
    await card.getByText("Project: Glance · Chat: Watch support · Agent: Richmond", { exact: true }).waitFor();
    await card.getByText("The provider disconnected before it could confirm the final result.", { exact: true }).waitFor();
    await card.getByText("Work record: request:watch-123456789012", { exact: true }).waitFor();
    assert.equal(await card.getByRole("button", { name: "Details", exact: true }).getAttribute("aria-expanded"), "true");
    const detailsId = await card.getByRole("button", { name: "Details", exact: true }).getAttribute("aria-controls");
    assert.equal(await card.locator(`[id="${detailsId}"]`).count(), 1);
    await legacy.getByRole("button", { name: "Details", exact: true }).click();
    await legacy.getByText("No additional cause details were retained for this older notice.", { exact: true }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Mark reviewed", exact: true }).count(), 0);
    assert.equal(await dialog.getByRole("button", { name: "Hide notice", exact: true }).count(), 0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => JSON.parse(document.body.dataset.calls ?? "[]").filter(c => c.kind === "retry" || c.kind === "status" || c.kind === "review").length), 0);
    await page.getByRole("button", { name: "Review All", exact: true }).click();
    await card.getByRole("button", { name: "Retry assignment…", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Retry this assignment?" });
    assert.match(await confirmation.innerText(), /may duplicate changes/);
    assert.equal(await page.evaluate(() => JSON.parse(document.body.dataset.calls ?? "[]").filter(c => c.kind === "retry").length), 0);
    await confirmation.getByRole("button", { name: "Not now", exact: true }).click();
    await card.getByRole("button", { name: "Retry assignment…", exact: true }).click();
    await confirmation.getByRole("button", { name: "Retry assignment", exact: true }).click();
    await confirmation.waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => JSON.parse(document.body.dataset.calls).find(c => c.kind === "retry")),
      { kind: "retry", id: "watch-123456789012", options: { idempotencyKey: "operator-retry:unknown" } });
    await legacy.getByRole("button", { name: "Dismiss", exact: true }).click();
    await legacy.waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => JSON.parse(document.body.dataset.calls).find(c => c.kind === "status")),
      { kind: "status", id: "historical-one", options: "dismissed" });
    if (process.env.PONDEROSA_ATTENTION_SCREENSHOTS) await page.screenshot({ path: path.join(tmpdir(), `attention-context-${engine}-${width}.png`) });
    await dialog.getByRole("article", { name: "Wait 987654321012" }).getByRole("button", { name: "Open activity", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => JSON.parse(document.body.dataset.calls).find(c => c.kind === "open")),
      { kind: "open", id: "join", options: "join:wait-987654321012" });
    await page.close();
  }
  for (const width of [320, 390, 1440]) {
    const longPage = await browser.newPage({ viewport: { width, height: 800 } });
    longPage.on("pageerror", error => errors.push(error.message));
    await longPage.goto(`${url}/?long`);
    await longPage.getByRole("button", { name: "Review All", exact: true }).click();
    const longCard = longPage.getByRole("dialog", { name: "Needs Your Attention" }).getByRole("article", { name: "Assignment 123456789012" });
    const assignment = "Review the mobile layout and preserve the existing receipt and retry authority. ".repeat(8).trim();
    const preview = longCard.getByText(assignment, { exact: true });
    const bounds = await preview.evaluate(e => ({ client: e.clientHeight, scroll: e.scrollHeight, clamp: getComputedStyle(e).webkitLineClamp }));
    assert.equal(bounds.clamp, "3");
    if (width < 900) assert(bounds.scroll > bounds.client, "long mobile preview is bounded");
    const details = longCard.getByRole("button", { name: "Details", exact: true });
    await details.focus(); await longPage.keyboard.press("Enter");
    await longPage.waitForFunction(() => document.querySelector('[data-notification-id="unknown"] button[aria-expanded="true"]'));
    const full = longCard.locator('[id="attention-details-unknown"]').getByText(assignment, { exact: true });
    await full.waitFor();
    assert(await full.evaluate(e => e.scrollHeight <= e.clientHeight + 1), "Details exposes the complete retained message, not another clamped preview");
    assert.equal(await longPage.evaluate(() => JSON.parse(document.body.dataset.calls ?? "[]").length), 0, "expansion is presentation-only");
    await longPage.close();
  }
  const panelPage = await browser.newPage({ viewport: { width: 390, height: 800 } });
  panelPage.on("pageerror", error => errors.push(error.message));
  await panelPage.goto(`${url}/?panel`);
  await panelPage.getByRole("tab", { name: /^Needs Action/ }).click();
  await panelPage.getByText(/Wait 987654321012/).waitFor();
  assert.equal(await panelPage.getByRole("button", { name: "Mark Resolved", exact: true }).count(), 0);
  assert.equal(await panelPage.getByRole("button", { name: "Dismiss", exact: true }).count(), 4);
  assert.equal(await panelPage.getByRole("button", { name: "Mark reviewed", exact: true }).count(), 0);
  assert.equal(await panelPage.getByRole("button", { name: "Hide notice", exact: true }).count(), 0);
  assert.equal(await panelPage.evaluate(() => JSON.parse(document.body.dataset.calls ?? "[]").filter(c => c.kind === "unexpected-chat-directory").length), 0);
  await panelPage.getByRole("button", { name: "Open activity", exact: true }).nth(1).click();
  await panelPage.waitForFunction(() => JSON.parse(document.body.dataset.calls ?? "[]").some(c => c.kind === "navigate"));
  assert.equal(await panelPage.evaluate(() => JSON.parse(document.body.dataset.calls).find(c => c.kind === "navigate").options.focusId), "join:wait-987654321012");
  assert.equal(await panelPage.evaluate(() => JSON.parse(document.body.dataset.calls ?? "[]").filter(c => c.kind === "review").length), 0);
  await panelPage.close();
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: identifiable current/legacy notices, mobile containment, Dismiss-only controls, exact activity targets and confirmed idempotent retry`);
} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(output, { recursive: true, force: true });
}
