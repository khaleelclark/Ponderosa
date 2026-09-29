import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const web = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "agent-running-heading-"));
const output = path.join(temporary, "web");
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
let browser;
let server;
try {
  const build = await createRsbuild({
    cwd: web,
    rsbuildConfig: {
      plugins: [pluginReact()],
      source: { entry: { index: path.join(web, "test/chat-first-browser-entry.tsx") } },
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
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/?loading`);
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByText("Agents · loading count…", { exact: true }).waitFor();
    assert.equal(await page.getByText("Agents · 0 running", { exact: true }).count(), 0);
    await page.getByText("Agents · 1 running", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Finish all work" }).click();
    await page.getByText("Agents · 0 running", { exact: true }).waitFor();
    await page.close();
  }
  console.log("Delayed running-Agent count passed at mobile and desktop widths");
} finally {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve) ?? resolve());
  await rm(temporary, { recursive: true, force: true });
}
