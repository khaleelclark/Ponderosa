import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "ponderosa-silent-preview-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
let browser;
let server;
try {
  const build = await createRsbuild({ cwd: root, rsbuildConfig: {
    plugins: [pluginReact()],
    source: { entry: { index: path.join(root, "test/browser-silent-preview-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error",
  } });
  await build.build();
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const file = path.join(output, pathname === "/" ? "index.html" : pathname);
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH,
    args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.previewProbe?.opened === 1);
  await page.waitForFunction(() => window.previewProbe?.closed === 1 && window.previewProbe?.polls > 0, null, { timeout: 4_000 });
  assert.deepEqual(await page.evaluate(() => ({ opened: window.previewProbe.opened, closed: window.previewProbe.closed })),
    { opened: 1, closed: 1 }, "a silent fallback stream is closed before polling begins");
  await page.close();
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
