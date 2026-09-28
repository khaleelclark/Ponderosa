import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
let browser;
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.join(root, pathname === "/" || !path.extname(pathname) ? "index.html" : pathname);
    response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
}).listen(0, "127.0.0.1");
try {
  await new Promise(resolve => server.once("listening", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH,
    args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  for (const mode of ["ordinary", "getters_denied", "writes_denied"]) {
    const page = await browser.newPage();
    if (mode === "getters_denied") await page.addInitScript(() => {
      for (const kind of ["localStorage", "sessionStorage"]) Object.defineProperty(window, kind, {
        configurable: true, get: () => { throw new DOMException("Storage denied", "SecurityError"); },
      });
    });
    if (mode === "writes_denied") await page.addInitScript(() => {
      Storage.prototype.setItem = () => { throw new DOMException("Storage full", "QuotaExceededError"); };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/home`);
    await page.waitForFunction(() => (document.querySelector("#root")?.textContent?.length ?? 0) > 0, null, { timeout: 10_000 });
    const text = await page.locator("#root").innerText();
    assert.ok(text.length > 0, `${mode} must render a recoverable workspace rather than a blank page`);
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
