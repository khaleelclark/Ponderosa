import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const web = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "queued-tray-width-"));
const output = path.join(temporary, "web");
let browser;
let server;

try {
  const build = await createRsbuild({
    cwd: web,
    rsbuildConfig: {
      plugins: [pluginReact()],
      source: { entry: { index: path.join(web, "test/queued-tray-width-entry.tsx") } },
      output: { distPath: { root: output } },
      logLevel: "error",
    },
  });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try {
      const content = await readFile(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
  for (const width of [320, 390, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const queue = await page.getByLabel("Queued messages").boundingBox();
    const composer = await page.locator(".ponderosa-composer").boundingBox();
    assert.ok(queue && composer, "queue and composer render");
    assert.ok(Math.abs(queue.width - composer.width) <= 1, `${width}px: queue matches composer width (${queue.width} vs ${composer.width})`);
    assert.ok(Math.abs(queue.x - composer.x) <= 1, `${width}px: queue aligns with composer`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px: no document overflow`);
    console.log(`PASS ${width}px: queue and composer are aligned`);
  }
} finally {
  await browser?.close();
  server?.close();
  await rm(temporary, { recursive: true, force: true });
}
