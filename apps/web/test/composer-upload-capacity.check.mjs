import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const web = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "composer-upload-capacity-"));
const output = path.join(temporary, "web");
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
let browser;
let server;
try {
  const build = await createRsbuild({
    cwd: web,
    rsbuildConfig: {
      plugins: [pluginReact()],
      source: { entry: { index: path.join(web, "test/composer-upload-capacity-entry.tsx") } },
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
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH });
  for (const width of [390, 1280]) for (const extension of ["txt", "docx"]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/?case=${extension}`);
    await page.getByRole("button", { name: "Select four files" }).click();
    await page.waitForFunction(() => window.uploadStats?.().started === 2);
    assert.deepEqual(await page.evaluate(() => window.uploadStats()), { started: 2, active: 2, peak: 2 });
    assert.equal(await page.locator(`[data-file-status="file-2.${extension}"]`).innerText(), "queued");
    await page.getByRole("button", { name: "Release slots" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("[data-file-status]")]
      .length === 4 && [...document.querySelectorAll("[data-file-status]")]
      .every(element => element.textContent === "complete"));
    assert.deepEqual(await page.evaluate(() => window.uploadStats()), { started: 4, active: 0, peak: 2 });
    if (extension === "docx") {
      assert.equal(await page.getByText(/Word document ·/).count(), 4);
      assert.equal(await page.getByRole("link", { name: /Download file-\d\.docx/ }).count(), 4);
      assert.equal(await page.getByRole("button", { name: /Preview file-\d\.docx/ }).count(), 0);
    }
    await page.close();
  }
  console.log("Four-file text/DOCX composer upload capacity and Word download cards passed at mobile and desktop widths");
} finally {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve) ?? resolve());
  await rm(temporary, { recursive: true, force: true });
}
