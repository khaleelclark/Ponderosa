import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const web = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "publication-ui-"));
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
let browser, server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: {
    plugins: [pluginReact()], source: { entry: { index: path.join(web, "test/file-publication-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error",
  } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + path.sep)) return response.writeHead(404).end();
    try {
      const content = await readFile(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await playwright[engine].launch({ headless: true,
    ...(engine === "chromium" && process.env.PONDEROSA_CHROMIUM_PATH ? { executablePath: process.env.PONDEROSA_CHROMIUM_PATH } : {}),
    ...(engine === "webkit" && process.env.PONDEROSA_WEBKIT_PATH ? { executablePath: process.env.PONDEROSA_WEBKIT_PATH } : {}),
  });
  for (const width of [320, 390, 1440]) for (const label of ["Publish this file", "Not now"]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const card = page.getByRole("region", { name: "Decision" });
    await card.getByText(/Approval copies only these exact bytes/).waitFor();
    assert.equal(await card.getByRole("button").count(), 2);
    assert.equal(await page.getByRole("textbox").count(), 0, "approval cannot be granted by arbitrary text");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal clipping");
    const button = card.getByRole("button", { name: label, exact: true });
    await button.focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.body.dataset.response);
    const result = await page.evaluate(() => JSON.parse(document.body.dataset.response));
    assert.equal(result.decisionId, await page.evaluate(() => document.body.dataset.decisionId));
    assert.equal(result.optionId, label === "Publish this file" ? "approve" : "do_not_approve");
    assert.deepEqual(errors, []);
    if (label === "Not now" && width === 320) await page.screenshot({ path: path.join(tmpdir(), `publication-${engine}-320.png`), fullPage: true });
    await page.close();
  }
  console.log(`PASS ${engine}: exact Decision actions, keyboard activation, and readable context at 320/390/1440px`);
} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(output, { recursive: true, force: true });
}
