import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const web = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "mobile-workspace-layout-"));
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
let browser, server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/mobile-workspace-layout-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/fixture/")) {
      response.writeHead(200, { "Content-Type": "text/plain" }).end(`Readable result: ${pathname}`); return;
    }
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try {
      const content = await readFile(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright[engine].launch({ headless: true,
    ...(engine === "chromium" ? { executablePath: process.env.PONDEROSA_CHROMIUM_PATH } : {}) });
  const errors = [];
  const pageFor = async (viewport, query) => {
    const page = await browser.newPage({ viewport, hasTouch: viewport.width < 900 });
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.goto(`${url}/?${query}`); return page;
  };
  for (const width of [320, 360, 390, 412, 430, 480, 600, 899, 1440]) {
    for (const connection of ["live", "reconnecting", "stale", "unavailable"]) {
      const page = await pageFor({ width, height: 932 }, `case=header&connection=${connection}&long&minutes=111&theme=${width % 2 ? "light" : "dark"}`);
      if (width < 900) await page.getByRole("button", { name: "Expand workspace header", exact: true }).click();
      await page.getByRole("button", { name: /Open provider usage/ }).waitFor();
      const geometry = await page.evaluate(() => {
        const title = document.querySelector("h1").getBoundingClientRect();
        const collapse = document.querySelector('[aria-label="Collapse workspace header"]').getBoundingClientRect();
        return { titleWidth: title.width, collapseLeft: collapse.left, collapseRight: collapse.right,
          overflow: document.documentElement.scrollWidth > innerWidth,
          containedChips: [...document.querySelectorAll(".MuiChip-root")].every(e => { const r = e.getBoundingClientRect(); return r.left >= -0.5 && r.right <= innerWidth + 0.5; }) };
      });
      assert(geometry.titleWidth >= 80, `Agent identity remains visible at ${width}/${connection}`);
      assert(geometry.collapseLeft >= 0 && geometry.collapseRight <= width + 0.5, "collapse remains wholly reachable");
      assert(!geometry.overflow && geometry.containedChips, "status and controls stay contained");
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      assert.equal(await page.locator("body").getAttribute("data-stopped"), "yes");
      if (width === 430 && connection === "live") {
        const right = page.getByRole("button", { name: "Scroll tabs right", exact: true });
        await right.focus(); await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector(".MuiTabs-scroller").scrollLeft > 0);
        await right.click();
        await page.getByRole("tab", { name: "Settings", exact: true }).click();
        assert.equal(await page.getByRole("tab", { name: "Settings", exact: true }).getAttribute("aria-selected"), "true");
        await page.getByRole("tab", { name: "Chat", exact: true }).focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(await page.evaluate(() => document.activeElement.textContent), "Subagents");
        const left = page.getByRole("button", { name: "Scroll tabs left", exact: true });
        await left.focus(); await page.keyboard.press("Enter");
        await page.getByRole("tab", { name: "Chat", exact: true }).click();
        await page.getByRole("button", { name: "Collapse workspace header", exact: true }).click();
        await page.getByRole("button", { name: "Expand workspace header", exact: true }).waitFor();
        await page.getByRole("button", { name: "Expand workspace header", exact: true }).click();
        if (process.env.PONDEROSA_LAYOUT_SCREENSHOTS) await page.screenshot({ path: path.join(tmpdir(), `mobile-workspace-header-${engine}.png`) });
      }
      await page.close();
    }
  }
  const noChildren = await pageFor({ width: 430, height: 932 }, "case=header&no-descendants");
  await noChildren.getByRole("button", { name: "Expand workspace header", exact: true }).click();
  assert.equal(await noChildren.getByRole("tab", { name: "Subagents", exact: true }).count(), 0);
  await noChildren.close();
  for (const theme of ["dark", "light"]) {
    const page = await pageFor({ width: 430, height: 932 }, `case=picker&theme=${theme}`);
    const trigger = page.getByRole("button", { name: /Choose engine, model/ });
    await trigger.click();
    const menu = page.locator('.MuiPaper-root[role="menu"]');
    await menu.waitFor();
    for (const size of [{ width: 430, height: 500 }, { width: 932, height: 430 }, { width: 430, height: 932 }]) {
      await page.setViewportSize(size);
      await page.waitForFunction(() => { const r = document.querySelector('.MuiPaper-root[role="menu"]')?.getBoundingClientRect(); return r && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; });
    }
    await page.getByRole("menuitem", { name: /Model GPT/ }).click();
    await page.getByRole("menuitem", { name: "Other model", exact: true }).click();
    assert.equal(await page.locator("body").getAttribute("data-selected-model"), "other");
    await trigger.click(); assert.equal(await menu.count(), 0);
    await page.setViewportSize({ width: 430, height: 500 }); await trigger.click(); await menu.waitFor();
    if (process.env.PONDEROSA_LAYOUT_SCREENSHOTS) await page.screenshot({ path: path.join(tmpdir(), `mobile-workspace-picker-${engine}-${theme}.png`) });
    await page.close();
  }
  for (const size of [{ width: 430, height: 932 }, { width: 430, height: 500 }, { width: 1440, height: 932 }]) {
    const page = await pageFor(size, "case=files");
    await page.getByText("20 loaded items created by Agents in this Chat", { exact: true }).waitFor();
    const scroller = page.locator('#chat-workspace-files-panel .ponderosa-scroll');
    assert(await scroller.evaluate(e => e.scrollHeight > e.clientHeight), "populated results use the real Chat scroller");
    const r = await scroller.boundingBox(); await page.mouse.move(r.x + r.width / 2, r.y + r.height - 30); await page.mouse.wheel(0, 2500);
    await page.waitForFunction(() => document.querySelector('#chat-workspace-files-panel .ponderosa-scroll').scrollTop > 0);
    await scroller.evaluate(e => { e.scrollTop = e.scrollHeight; });
    const last = page.getByRole("button", { name: "Preview report-0.txt from Deleted Agent", exact: true });
    const lastBox = await last.boundingBox(); const scrollBox = await scroller.boundingBox();
    assert(lastBox.y >= scrollBox.y && lastBox.y + lastBox.height <= scrollBox.y + scrollBox.height + 1, "last result is reachable");
    await last.click(); await page.getByRole("dialog").waitFor();
    await page.getByText(/Readable result/).waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    if (engine === "chromium" && size.width < 900) {
      await scroller.evaluate(e => { e.scrollTop = e.scrollHeight / 2; });
      const beforeSwipe = await scroller.evaluate(e => e.scrollTop);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const cdp = await page.context().newCDPSession(page);
      const x = r.x + r.width / 2, y = r.y + r.height - 40;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 6; step++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 25 }] });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(before => document.querySelector('#chat-workspace-files-panel .ponderosa-scroll').scrollTop > before, beforeSwipe);
      await cdp.detach();
    }
    await scroller.evaluate(e => { e.scrollTop = 0; });
    const before = Number(await page.locator("body").getAttribute("data-folder-reads"));
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.waitForFunction(before => Number(document.body.dataset.folderReads) > before, before);
    await page.getByRole("textbox", { name: "Search Chat files and results", exact: true }).fill("report-19");
    await page.getByText("1 matching item created by Agents in this Chat", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "Search Chat files and results", exact: true }).fill("");
    await page.getByText("20 loaded items created by Agents in this Chat", { exact: true }).waitFor();
    if (process.env.PONDEROSA_LAYOUT_SCREENSHOTS) await page.screenshot({ path: path.join(tmpdir(), `mobile-workspace-files-${engine}-${size.width}x${size.height}.png`) });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: responsive Agent identity/actions, named tab arrows/keyboard navigation, viewport-following picker, real populated Chat scrolling/search/preview/refresh`);
} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(output, { recursive: true, force: true });
}
