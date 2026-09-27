import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "file-preview-links-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
let browser, server;
try {
  const build = await createRsbuild({ cwd: root, rsbuildConfig: {
    plugins: [pluginReact()],
    source: { transformImport: [], entry: { index: path.join(root, "test/file-preview-links-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error",
  } });
  await build.build();
  server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      const file = path.join(output, pathname === "/" ? "index.html" : pathname);
      res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText("outside", { exact: true }).waitFor();
  for (const text of ["outside", "malformed", "encoded slash"]) {
    const element = page.getByText(text, { exact: true });
    assert.equal(await element.evaluate(node => node.closest("a")), null, `${text} must render as inert text`);
  }
  assert.equal(await page.getByRole("link", { name: "safe local" }).getAttribute("href"),
    "/projects/project-a/files/view?path=overview%2Fnotes.md");
  assert.equal(await page.getByRole("link", { name: "external" }).getAttribute("href"), "https://example.com");
  assert.equal(await page.getByRole("link", { name: "section" }).getAttribute("href"), "#section");
  await page.close();
} finally { await browser?.close(); server?.close(); await rm(output, { recursive: true, force: true }); }
