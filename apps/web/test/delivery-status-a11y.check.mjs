import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "delivery-status-a11y-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
let browser;
let server;
try {
  const build = await createRsbuild({
    cwd: root,
    rsbuildConfig: {
      plugins: [pluginReact()],
      source: { entry: { index: path.join(root, "test/delivery-status-a11y-entry.tsx") } },
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
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH,
    args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const action = page.getByRole("button", { name: /Preparing a Run for Saratoga.*Open direct chat/ });
  await action.waitFor();
  assert.equal(await page.getByRole("status").count(), 1, "live status is separate from the actionable button");
  const uncertain = page.getByRole("button", { name: /Message delivered to Saratoga, but Ponderosa lost contact before confirming whether the work finished/ });
  await uncertain.waitFor();
  assert.equal(await page.getByRole("button", { name: /Undelivered to Saratoga/ }).count(), 0);
  await page.getByRole("button", { name: "Try Work Again" }).click();
  await page.getByRole("dialog", { name: "Ask the Agent to try the work again?" }).waitFor();
  assert.match(await page.getByRole("dialog").innerText(), /message reached the Agent/);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await action.click();
  assert.equal(await page.evaluate(() => window.openedAgent), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByText("Work unconfirmed", { exact: true }).isVisible(), true);
  await page.close();
  console.log("PASS delivery receipt is a keyboard-visible button with separate live status");
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
