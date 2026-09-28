import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "ponderosa-ux-check-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
let browser;
let server;
try {
  const build = await createRsbuild({ cwd: root, rsbuildConfig: {
    plugins: [pluginReact()], source: { entry: { index: path.join(root, "test/notification-menu-ux-entry.tsx") } },
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
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByRole("button", { name: "Open the notice" }).focus();
    await page.getByRole("button", { name: "Open the notice" }).click();
    assert.equal(await page.evaluate(() => window.reviewed), false, "viewing/focusing a notice must not silently mark it reviewed");
    await page.getByRole("button", { name: "Mark reviewed" }).click();
    assert.equal(await page.evaluate(() => window.reviewed), true);
    await page.getByRole("button", { name: "Chat settings and actions" }).click();
    const rows = page.getByRole("menuitem");
    await rows.first().waitFor();
    await page.waitForTimeout(250);
    for (let index = 0; index < await rows.count(); index += 1) {
      const bounds = await rows.nth(index).boundingBox();
      const style = await rows.nth(index).evaluate(element => ({ minHeight: getComputedStyle(element).minHeight, className: element.className, innerWidth }));
      assert.ok(bounds && bounds.height >= (width === 390 ? 44 : 36), `menu row ${index} has ${bounds?.height}px target at ${width}px; ${JSON.stringify(style)}`);
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open capability picker" }).click();
    if (width === 390) await page.getByRole("menuitem", { name: "Skills & connectors" }).click();
    await page.getByText("Available skills", { exact: true }).waitFor();
    await page.getByText("Google Docs", { exact: true }).waitFor();
    await page.getByText("Connected apps", { exact: true }).waitFor();
    await page.getByText("Unavailable options", { exact: true }).waitFor();
    assert.equal(await page.getByText("google-drive:google-docs", { exact: true }).count(), 0,
      "technical skill identifier is not the visible option label");
    await page.close();
  }
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
