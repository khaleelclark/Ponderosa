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
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
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
  browser = await playwright[engine].launch({ headless: true, ...(engine === "chromium" ? { executablePath: process.env.PONDEROSA_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage();
  const fontRequests = [];
  page.on("request", request => { if (request.url().includes("/api/font/")) fontRequests.push(request.url()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText("outside", { exact: true }).waitFor();
  for (const text of ["outside", "malformed", "encoded slash"]) {
    const element = page.getByText(text, { exact: true });
    assert.equal(await element.evaluate(node => node.closest("a")), null, `${text} must render as inert text`);
  }
  const local = new URL(await page.getByRole("link", { name: "safe local" }).getAttribute("href"), page.url());
  assert.equal(local.pathname, "/projects/project-a/files/view");
  assert.equal(local.searchParams.get("path"), "overview/notes.md");
  assert.equal(local.searchParams.get("returnTo"), "/");
  assert.equal(await page.getByRole("link", { name: "external" }).getAttribute("href"), "https://example.com");
  assert.equal(await page.getByRole("link", { name: "section" }).getAttribute("href"), "#section");
  for (const name of ["Download", "Download artifact"]) {
    const link = page.locator("#agent-links").getByRole("link", { name, exact: true });
    const style = await link.evaluate(e => ({ color: getComputedStyle(e).color,
      parent: getComputedStyle(e.closest("section")).color, decoration: getComputedStyle(e).textDecorationLine }));
    assert.notEqual(style.color, style.parent, "Agent download links are highlighted");
    assert.equal(style.decoration, "underline");
    await link.focus();
    assert.equal(await link.evaluate(e => getComputedStyle(e).outlineStyle), "solid", "keyboard focus remains visible");
  }
  assert.match(await page.getByRole("link", { name: "Download", exact: true }).getAttribute("href"), /\/projects\/project-a\/files\/view\?path=dist%2Fspec.md/);
  assert.equal(await page.getByRole("link", { name: "Download artifact", exact: true }).getAttribute("href"), "/api/artifacts/file/download");
  const fontCard = page.locator("#font-attachment");
  assert.match(await fontCard.innerText(), /Font file/);
  assert.equal(await fontCard.getByRole("button", { name: /Preview/ }).count(), 0, "opaque fonts do not get a browser font/active preview");
  assert.equal(await fontCard.getByRole("link", { name: "Download Family.ttf", exact: true }).getAttribute("href"), "/api/font/download");
  assert.deepEqual(fontRequests, [], "rendering a font attachment never loads or installs it");
  console.log(`PASS ${engine}: scoped preview links and Agent download highlighting/focus without route changes`);
  await page.close();
} finally { await browser?.close(); server?.close(); await rm(output, { recursive: true, force: true }); }
