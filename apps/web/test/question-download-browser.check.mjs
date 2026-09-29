import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright-core");
const web = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "question-download-"));
const output = path.join(temporary, "web");
let browser;
let server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: {
    plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/question-download-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error",
  } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/download.txt") {
      response.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": "attachment; filename=download.txt" }).end("report");
      return;
    }
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try {
      const content = await readFile(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH });
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 720 }, acceptDownloads: true });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const cards = page.getByRole("region", { name: "Decision" });
    assert.equal(await cards.count(), 2, `${width}: both pending questions appear directly in Chat`);
    assert.equal(await cards.first().getByText("Which color should I use?").count(), 1);
    assert.equal(await cards.last().getByText("Should I continue with the current plan?").count(), 1);
    await cards.last().getByRole("button", { name: "Continue" }).click();
    await page.waitForFunction(() => document.querySelector("#answers")?.textContent === "d1:yes");
    await page.getByRole("link", { name: "Download report" }).click();
    await page.getByText("Download started", { exact: true }).waitFor();
    assert.deepEqual(errors, [], `${width}: no browser errors`);
    await page.close();
  }
  console.log("Chat questions and download-start feedback passed on mobile and desktop Chromium");
} finally {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
  await rm(temporary, { recursive: true, force: true });
}
