import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "composer-chip-a11y-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
let browser;
let server;
try {
  const build = await createRsbuild({
    cwd: root,
    rsbuildConfig: {
      plugins: [pluginReact()],
      source: { entry: { index: path.join(root, "test/project-mention/fixture.tsx") } },
      output: { distPath: { root: output } },
      logLevel: "error",
    },
  });
  await build.build();
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const file = path.join(output, pathname === "/" ? "index.html" : pathname);
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH });
  for (const [width, coarse] of [[1440, false], [390, true]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: coarse });
    const page = await context.newPage();
    await page.route("**/api/**", route => route.fulfill({ json: {} }));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", { name: "Mention Boston" }).click();
    const remove = page.getByRole("button", { name: "Remove #Boston" }).first();
    await remove.waitFor();
    assert.ok(await remove.evaluate(element => element.tabIndex >= 0), "chip removal belongs in the Tab order");
    const bounds = await remove.boundingBox();
    assert.ok(bounds && bounds.width >= (coarse ? 44 : 24) && bounds.height >= (coarse ? 44 : 24),
      "chip removal has an adequate pointer target");
    await remove.focus();
    await page.keyboard.press("Space");
    await remove.waitFor({ state: "detached" });
    await context.close();
  }
  console.log("PASS desktop/mobile composer chips: keyboard removal and pointer targets");
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
