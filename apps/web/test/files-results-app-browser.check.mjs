import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const web = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "files-results-app-"));
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
let browser, server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/files-results-app-browser-entry.tsx") } },
    output: { distPath: { root: output }, minify: false }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/fixture/")) {
      response.writeHead(200, { "Content-Type": "text/plain" }).end(`Readable result: ${pathname}`); return;
    }
    const file = path.resolve(output, "." + (pathname.startsWith("/projects/") ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try {
      const content = await readFile(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".woff2") ? "font/woff2" : "text/html" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright[engine].launch({ headless: true,
    ...(engine === "chromium" ? { executablePath: process.env.PONDEROSA_CHROMIUM_PATH } : {}) });
  const errors = [];
  for (const viewport of [{ width: 1000, height: 1180 }, { width: 1440, height: 900 },
    { width: 390, height: 800 }, { width: 412, height: 500 }]) {
    const page = await browser.newPage({ viewport, hasTouch: viewport.width < 900 });
    page.on("pageerror", error => { errors.push(error.message); console.error(error.stack); });
    await page.goto(`${url}/projects/project/chats/chat?view=files`);
    await page.getByText("31 loaded items created by Agents in this Chat", { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('#main-content #chat-workspace-files-panel').count(), 1, "real App route outlet is mounted");
    if (viewport.width >= 900) assert.equal(await page.locator('[aria-label="Project workspace"]').count(), 1, "real Project shell is mounted");
    const scroller = page.locator('#chat-workspace-files-panel .ponderosa-scroll');
    const geometry = await scroller.evaluate(e => ({ clientHeight: e.clientHeight, scrollHeight: e.scrollHeight,
      top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom, viewport: innerHeight }));
    console.log(`${engine} ${viewport.width}x${viewport.height}: ${JSON.stringify(geometry)}`);
    assert(geometry.clientHeight > 0 && geometry.clientHeight < geometry.scrollHeight, "results have a viewport-bounded scroll area");
    assert(geometry.top >= 0 && geometry.bottom <= geometry.viewport + 1, "results are not clipped by a non-scrolling ancestor");
    const r = await scroller.boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + r.height - 30);
    await page.mouse.wheel(0, 3500);
    await page.waitForFunction(() => document.querySelector('#chat-workspace-files-panel .ponderosa-scroll').scrollTop > 0);
    await scroller.evaluate(e => { e.scrollTop = e.scrollHeight; });
    const last = page.getByRole("button", { name: "Preview report-0.txt from Deleted Agent", exact: true });
    const lastBox = await last.boundingBox();
    assert(lastBox.y >= r.y && lastBox.y + lastBox.height <= r.y + r.height + 1, "last result is reachable");
    await last.click(); await page.getByRole("dialog").waitFor();
    await page.getByText(/Readable result/).waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download report-0.txt", exact: true }).click();
    const download = await downloadEvent;
    assert.equal(await download.failure(), null, "last result can be downloaded");
    // Dismiss download feedback before exercising the list's bottom edge again.
    await page.getByText("Download started", { exact: true }).waitFor();
    await page.getByRole("alert").filter({ hasText: "Download started" }).getByRole("button", { name: "Close", exact: true }).click();
    await page.getByText("Download started", { exact: true }).waitFor({ state: "hidden" });
    if (viewport.width < 900) await page.getByRole("button", { name: "Expand workspace header", exact: true }).click();
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    await page.getByRole("tab", { name: "Files & Results", exact: true }).click();
    await page.waitForFunction(() => {
      const e = document.querySelector('#chat-workspace-files-panel .ponderosa-scroll');
      return e && e.clientHeight > 0 && e.scrollHeight > e.clientHeight && e.getBoundingClientRect().bottom <= innerHeight + 1;
    });
    await page.setViewportSize({ width: viewport.width, height: Math.max(350, viewport.height - 200) });
    await page.waitForFunction(() => document.querySelector('#chat-workspace-files-panel .ponderosa-scroll').getBoundingClientRect().bottom <= innerHeight + 1);
    await scroller.evaluate(e => { e.scrollTop = 0; });
    const resized = await scroller.boundingBox();
    await page.mouse.move(resized.x + resized.width / 2, resized.y + resized.height - 15);
    await page.mouse.wheel(0, 2000);
    await page.waitForFunction(() => document.querySelector('#chat-workspace-files-panel .ponderosa-scroll').scrollTop > 0);
    if (process.env.PONDEROSA_LAYOUT_SCREENSHOTS) await page.screenshot({ path: path.join(tmpdir(), `files-results-app-${engine}-${viewport.width}.png`) });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: full App 31-result scrolling, last-file preview/download, tab switching and resizing`);
} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(output, { recursive: true, force: true });
}
