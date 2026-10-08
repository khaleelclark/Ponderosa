import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const web = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "message-receipt-layout-"));
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
const operations = [];
let browser, server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/message-receipt-layout-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (request.method === "POST" && /^\/api\/projects\/project\/message-deliveries\/activation\/(cancel|retry)$/.test(pathname)) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      operations.push({ pathname, body });
      response.writeHead(200, { "Content-Type": "application/json" }).end('{}'); return;
    }
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try { const content = await readFile(file); response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await playwright[engine].launch({ headless: true,
    ...(engine === "chromium" ? { executablePath: process.env.PONDEROSA_CHROMIUM_PATH } : {}) });
  for (const size of [{ width: 976, height: 332 }, { width: 600, height: 400 }, { width: 320, height: 640 }, { width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const page = await browser.newPage({ viewport: size });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const article = page.locator("article");
    const copy = page.getByRole("button", { name: "Copy whole message", exact: true });
    await copy.waitFor();
    await article.hover();
    await page.waitForTimeout(160);
    const geometry = await page.evaluate(() => {
      const bounds = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
      const copy = document.querySelector('[aria-label="Copy whole message"]');
      const receipt = document.querySelector('[aria-label="Message delivery status"] button');
      const scroller = document.querySelector(".chat-scroll-region");
      return { article: bounds(document.querySelector("article")), copy: bounds(copy), receipt: bounds(receipt),
        scroller: bounds(scroller), opacity: getComputedStyle(copy.closest(".chat-message-action-buttons")).opacity,
        text: receipt.textContent, hit: document.elementFromPoint(copy.getBoundingClientRect().x + 14, copy.getBoundingClientRect().y + 14)?.closest("button") === copy };
    });
    if (process.env.RECEIPT_BASELINE === "1") { console.log(JSON.stringify({ size, ...geometry })); await page.screenshot({ path: path.join(tmpdir(), `receipt-before-${size.width}.png`) }); }
    else {
      assert.equal(geometry.opacity, "1", "hover reveals the Copy action");
      assert.ok(geometry.hit, "Copy remains reachable inside the message scroller");
      assert.ok(geometry.copy.left >= geometry.article.left && geometry.copy.right <= geometry.article.right, "Copy stays inside the message");
      assert.ok(geometry.receipt.width < 260, "receipt is a compact label, not a prose banner");
      if (size.width >= 600) assert.ok(Math.abs(geometry.copy.top - geometry.receipt.top) <= 4, "wide Copy and receipt share a row");
      await assertReachable(page, article.locator('button'), "message actions");
      assert.equal(geometry.text, "Delivered · Stopped");
      if (engine === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      else await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true,
        value: { writeText: async text => { document.body.dataset.copied = text; } } }));
      await copy.click();
      assert.match(await page.evaluate(engine => engine === "chromium" ? navigator.clipboard.readText() : document.body.dataset.copied, engine), /people with zero knowledge/);
      await page.mouse.move(0, 0);
      await copy.focus();
      await page.waitForTimeout(160);
      assert.equal(await copy.evaluate(el => getComputedStyle(el.closest(".chat-message-action-buttons")).opacity), "1", "keyboard focus reveals actions");
      const receipt = page.locator('[aria-label="Message delivery status"] button');
      await page.keyboard.press("Tab");
      assert.equal(await receipt.evaluate(el => document.activeElement === el), true, "Tab reaches the receipt after Copy");
      await page.getByRole("tooltip").filter({ hasText: "Changes made before stopping may remain" }).waitFor();
      await receipt.click();
      assert.equal(await page.evaluate(() => document.body.dataset.openedAgent), "agent", "receipt still opens its exact Agent");
      if (process.env.PONDEROSA_RECEIPT_SCREENSHOTS === "1") {
        await page.keyboard.press("Escape"); await receipt.blur(); await article.hover();
        await page.waitForTimeout(160); await copy.hover();
        await copy.locator('[data-testid="ContentCopyIcon"]').waitFor();
        await page.screenshot({ path: path.join(tmpdir(), `remaining-receipt-after-${engine}-${size.width}.png`) });
      }
    }
    await page.close();
  }
  if (process.env.RECEIPT_BASELINE !== "1") {
    for (const [mode, shortLabel, detail] of [
      ["stopping", "Delivered · Stopping", "termination has not been confirmed yet"],
      ["unknown", "Delivered · Stop unconfirmed", "whether its work stopped is unconfirmed"],
      ["unconfirmed", "Work unconfirmed", "lost contact before confirming whether the work finished"],
    ]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`http://127.0.0.1:${server.address().port}/?case=${mode}`);
      const receipt = page.locator('[aria-label="Message delivery status"] button').first();
      await receipt.waitFor();
      assert.equal(await receipt.innerText(), shortLabel);
      assert.match(await receipt.getAttribute("aria-label"), new RegExp(detail));
      await receipt.hover();
      await page.getByRole("tooltip").filter({ hasText: detail }).waitFor();
      if (mode === "unconfirmed") {
        await page.getByRole("button", { name: "Try Work Again", exact: true }).click();
        await page.getByRole("dialog").getByText(/may repeat work already completed/).waitFor();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
      }
      await page.close();
    }
    const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    for (const width of [320, 390, 430]) {
      const mobile = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      await mobile.goto(`http://127.0.0.1:${server.address().port}/?case=unconfirmed&short`);
      const dismiss = mobile.getByRole("button", { name: "Dismiss", exact: true });
      await dismiss.waitFor();
      const geometry = await mobile.locator('[aria-label="Message delivery status"] button').evaluateAll(buttons => buttons.map(e => {
        const r = e.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, height: r.height };
      }));
      assert(geometry.every(r => r.left >= 0 && r.right <= width), "compact controls remain reachable");
      await assertReachable(mobile, mobile.locator('[aria-label="Message delivery status"] button'), `follow-up controls ${width}`);
      if (process.env.PONDEROSA_RECEIPT_SCREENSHOTS === "1") await mobile.screenshot({ path: path.join(tmpdir(), `remaining-receipt-followup-${engine}-${width}.png`) });
      await mobile.getByRole("button", { name: "Try Work Again", exact: true }).tap();
      await mobile.getByRole("dialog").getByText(/may repeat work already completed/).waitFor();
      await mobile.getByRole("button", { name: "Cancel", exact: true }).tap();
      assert(operations.every(operation => !operation.pathname.endsWith('/retry')), "opening/cancelling retry does not retry work");
      const previous = operations.length;
      await dismiss.tap();
      await mobile.waitForFunction(() => !document.body.textContent.includes('Dismissing…'));
      assert.equal(operations.length, previous + 1, "Dismiss performs one scoped operation");
      assert.equal(operations.at(-1).pathname, '/api/projects/project/message-deliveries/activation/cancel');
      assert.equal(operations.at(-1).body.idempotencyKey, 'operator-delivery-cancel:activation');
      assert(operations.every(operation => !operation.pathname.endsWith('/retry')), "Dismiss does not request a retry");
      await mobile.close();
    }
    for (const width of [320, 390]) for (const mode of ["unknown", "delivered"]) {
      const mobile = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      await mobile.goto(`http://127.0.0.1:${server.address().port}/?case=${mode}`);
      const receipt = mobile.locator('[aria-label="Message delivery status"] button').first();
      await receipt.waitFor();
      const dimensions = await receipt.evaluate(button => {
        const visual = button.querySelector("[data-delivery-status-badge]") ?? button;
        return { badge: visual.getBoundingClientRect().height, target: button.getBoundingClientRect().height,
          copy: document.querySelector('[aria-label="Copy whole message"]').getBoundingClientRect().height };
      });
      if (process.env.PONDEROSA_RECEIPT_SCREENSHOTS === "1") await mobile.screenshot({ path: path.join(tmpdir(), `remaining-receipt-mobile-padding-${engine}-${width}-${mode}.png`) });
      assert.equal(dimensions.badge, 28, "mobile status background is compact instead of filling the 44px touch target");
      assert.ok(dimensions.target >= 44, "receipt retains its existing touch target");
      assert.equal(dimensions.copy, 44, "Copy's existing touch target is unchanged");
      await receipt.tap();
      assert.equal(await mobile.evaluate(() => document.body.dataset.openedAgent), "agent");
      await mobile.close();
    }
    await touch.goto(`http://127.0.0.1:${server.address().port}/?no-open&long-name`);
    const copy = touch.getByRole("button", { name: "Copy whole message", exact: true });
    await copy.waitFor();
    assert.equal(await copy.evaluate(el => getComputedStyle(el.closest(".chat-message-action-buttons")).opacity), "1", "touch actions are always visible");
    const wrapper = touch.locator('[aria-label="Message delivery status"] button').locator("..");
    await wrapper.dispatchEvent("touchstart");
    await touch.getByRole("tooltip").filter({ hasText: "Changes made before stopping may remain" }).waitFor();
    await wrapper.dispatchEvent("touchend");
    await touch.close();
    console.log(`PASS ${engine}: receipts may wrap without clipping/overlap; Copy, ${engine === "chromium" ? "system clipboard" : "clipboard API stub"}, keyboard, touch details, exact Agent navigation, retry warning and scoped Dismiss at 320/390/430/600/976/1440px`);
  }
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}

async function assertReachable(page, controls, label) {
  const result = await controls.evaluateAll(buttons => {
    const boxes = buttons.map(button => {
      const r = button.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
        hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === button,
        unclipped: button.scrollWidth <= button.clientWidth + 1, text: button.textContent, aria: button.getAttribute('aria-label') };
    });
    return { boxes, viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
      scrollerOverflow: document.querySelector('.chat-scroll-region').scrollWidth > document.querySelector('.chat-scroll-region').clientWidth };
  });
  assert.equal(result.overflow || result.scrollerOverflow, false, `${label}: no horizontal scroll`);
  assert(result.boxes.every(r => r.width >= 24 && r.height >= 24 && r.left >= 0 && r.right <= result.viewport + 0.5 && r.hit && r.unclipped && (r.text || r.aria)),
    `${label}: readable, named controls retain reachable targets: ${JSON.stringify(result.boxes)}`);
  for (const [i, a] of result.boxes.entries()) for (const b of result.boxes.slice(i + 1)) {
    assert(Math.min(a.right, b.right) <= Math.max(a.left, b.left) + 0.5 || Math.min(a.bottom, b.bottom) <= Math.max(a.top, b.top) + 0.5,
      `${label}: controls do not overlap`);
  }
}
