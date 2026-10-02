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
const temporary = await mkdtemp(path.join(tmpdir(), "notification-dismiss-"));
const output = path.join(temporary, "web");
let browser;
let server;

try {
  const build = await createRsbuild({
    cwd: web,
    rsbuildConfig: {
      plugins: [pluginReact()],
      source: { entry: { index: path.join(web, "test/notification-dismiss-browser-entry.tsx") } },
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
    const page = await browser.newPage({ viewport: { width, height: 720 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    for (const [tab, id] of [["Updates (1)", "update"], ["Needs Action (1)", "action"]]) {
      await page.getByRole("tab", { name: tab }).click();
      const card = page.locator(`[data-notification-id="${id}"]`);
      const label = "Dismiss";
      const dismiss = card.getByRole("button", { name: label, exact: true });
      await dismiss.waitFor();
      assert.equal(await page.getByRole("button", { name: `Dismiss notification: ${id}` }).count(), 0);
      assert.equal(await card.getByRole("button", { name: label, exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: "Mark reviewed", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Hide notice", exact: true }).count(), 0);
      await dismiss.click();
      await page.waitForFunction((value) => document.querySelector("#actions")?.textContent?.includes(`${value}:dismissed`), id);
    }
    assert.equal(await page.locator("#actions").innerText(), "update:dismissed,action:dismissed", `${width}: dismissal never opens Chat or closes the panel`);
    assert.deepEqual(errors, [], `${width}: no browser errors`);
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve) ?? resolve());
  await rm(temporary, { recursive: true, force: true });
}
