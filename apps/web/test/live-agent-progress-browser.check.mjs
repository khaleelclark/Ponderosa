import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const web = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "live-agent-progress-"));
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
let browser, server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/live-agent-progress-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try { const content = await readFile(file); response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await playwright[engine].launch({ headless: true,
    ...(engine === "chromium" ? { executablePath: process.env.PONDEROSA_CHROMIUM_PATH } : {}) });
  const errors = [];
  for (const width of [320, 390, 1440]) for (const surface of ["project", "agent", "all"]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width < 900 });
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.goto(`http://127.0.0.1:${server.address().port}/?surface=${surface}`);
    await page.getByText("Use the revised plan", { exact: true }).waitFor();
    const show = mode => page.evaluate(mode => window.showProgress(mode), mode);
    const progress = page.getByLabel("Live Agent progress", { exact: true });
    await show("pending");
    assert.equal(await progress.count(), 0);
    assert.equal(await page.getByText("Instructions delivered to Boston", { exact: true }).count(), 0);
    await show("ack");
    await page.getByText("Instructions delivered to Boston", { exact: true }).waitFor();
    assert.equal(await progress.count(), 0, "acknowledgement does not invent progress");
    await show("first"); await progress.getByText("I am adjusting the approach", { exact: true }).waitFor();
    await show("latest"); await progress.getByText("The revised approach is now underway", { exact: true }).waitFor();
    assert.equal(await page.getByText("I am adjusting the approach", { exact: true }).count(), 0);
    assert.equal(await progress.count(), 1);
    await progress.getByRole("button", { name: "Open agent Boston", exact: true }).click();
    assert.equal(await page.evaluate(() => document.body.dataset.openAgent), "boston");
    await show("literal"); await progress.getByText('<img src=x onerror="alert(1)"> **literal**', { exact: true }).waitFor();
    assert.equal(await progress.locator("img").count(), 0, "no HTML/markdown execution");
    await show("wrapped");
    const wrapped = progress.getByText("I AM UPDATING THE IMPLEMENTATION", { exact: false });
    await wrapped.waitFor();
    assert((await wrapped.textContent()).length < 240, "regression text stays below the former character threshold");
    const expand = progress.getByRole("button", { name: "Show full update", exact: true });
    if (width < 900) {
      assert(await wrapped.evaluate(el => el.scrollHeight > el.clientHeight + 1), `${surface}/${width} reproduces wrapped clipping`);
      await expand.waitFor({ timeout: 3000 });
      await expand.focus(); await page.keyboard.press("Enter");
      await progress.getByRole("button", { name: "Collapse update", exact: true }).waitFor();
      assert(await wrapped.evaluate(el => el.scrollHeight <= el.clientHeight + 1), "expansion exposes the complete wrapped update");
      await page.setViewportSize({ width: 1440, height: 844 });
      await progress.getByRole("button", { name: "Collapse update", exact: true }).click();
      await expand.waitFor({ state: "detached" });
      assert(await wrapped.evaluate(el => el.scrollHeight <= el.clientHeight + 1), "wide update is not clipped");
      await page.setViewportSize({ width, height: 844 });
      await expand.waitFor();
      await page.screenshot({ path: path.join(tmpdir(), `live-progress-wrapped-${engine}-${surface}-${width}.png`) });
    } else {
      assert(await wrapped.evaluate(el => el.scrollHeight <= el.clientHeight + 1), "desktop update fits without expansion");
      await expand.waitFor({ state: "detached" });
      await page.setViewportSize({ width: 320, height: 844 });
      await expand.waitFor();
      await page.setViewportSize({ width, height: 844 });
      await expand.waitFor({ state: "detached" });
    }
    await show("latest"); await progress.getByText("The revised approach is now underway", { exact: true }).waitFor();
    await expand.waitFor({ state: "detached" });
    await show("long");
    await progress.getByRole("button", { name: "Show full update", exact: true }).waitFor();
    await progress.getByRole("button", { name: "Show full update", exact: true }).focus();
    await page.keyboard.press("Enter");
    await progress.getByRole("button", { name: "Collapse update", exact: true }).waitFor();
    await page.keyboard.press("Enter");
    await progress.getByRole("button", { name: "Show full update", exact: true }).waitFor();
    const bounds = await progress.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth,
      positioned: getComputedStyle(el).position }));
    assert(bounds.scroll <= bounds.width + 1, `${surface}/${width} wraps`);
    assert.equal(bounds.positioned, "static", "in flow rather than floating over messages");
    await page.screenshot({ path: path.join(tmpdir(), `live-progress-${engine}-${surface}-${width}.png`) });
    await show("reply"); await progress.waitFor({ state: "detached" });
    await page.getByText("Here is the finished response", { exact: true }).waitFor();
    await show("failed"); assert.equal(await progress.count(), 0);
    assert.equal(await page.getByRole("status").count() > 0, true, "failure receipt remains");
    if (surface === "all") {
      await show("mixed"); await page.getByText("Instructions delivered to Boston", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Try Delivery Again", exact: true }).count(), 0,
        "confirmed steering does not introduce commands into the compact All Messages receipt");
    }
    await page.close();
    console.log(`PASS ${engine}: ${surface} ${width}px`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(output, { recursive: true, force: true });
}
