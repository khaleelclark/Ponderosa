import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "ponderosa-table-browser-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
let browser, server;
try {
  const build = await createRsbuild({ cwd: root, rsbuildConfig: {
    plugins: [pluginReact()], source: { transformImport: [], entry: { index: path.join(root, "test/message-table-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error",
  } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    try {
      const file = path.join(output, pathname === "/" ? "index.html" : pathname);
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH });
  const page = await browser.newPage();
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const region = page.getByRole("region", { name: "Scrollable message table" });
    await region.waitFor();
    assert.equal(await page.locator("table a").first().innerText(), "Example — Software Engineer");
    assert.equal(await page.locator("table a").first().getAttribute("href"), "https://jobs.example.com/company/very-long-job-identifier-1234567890/details");
    const before = await page.getByText(/^After the table:/).boundingBox();
    const metrics = await region.evaluate(el => {
      el.scrollLeft = el.scrollWidth;
      return { width: el.clientWidth, scrollWidth: el.scrollWidth, scrollLeft: el.scrollLeft,
        pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
        cells: [...el.querySelectorAll("th")].map(cell => cell.getBoundingClientRect().width) };
    });
    assert.ok(metrics.pageWidth <= metrics.viewport, "The message must not overflow the page");
    assert.ok(metrics.cells.slice(1).every(width => width >= 110), "Columns must not collapse into letters");
    if (width === 1440) assert.equal(metrics.scrollLeft, 0, "The desktop fixture fits without scrolling");
    if (width === 390) assert.ok(metrics.scrollLeft > 0, "The table scrolls independently on mobile");
    assert.deepEqual(await page.getByText(/^After the table:/).boundingBox(), before);
    await page.screenshot({ path: path.join(tmpdir(), `ponderosa-table-${width}.png`) });
    console.log({ width, ...metrics });
  }
} finally {
  await browser?.close(); server?.close(); await rm(output, { recursive: true, force: true });
}
