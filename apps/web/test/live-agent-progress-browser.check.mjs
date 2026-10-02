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
    for (const [reason, text] of [
      ["context_refresh", "waiting for context refresh to finish"],
      ["prior_steering", "an earlier steer is awaiting provider acknowledgement"],
      ["revision_pending", "waiting for the message edit to be durably recorded"],
      ["provider_not_ready", "the provider was not ready to accept steering"],
      ["provider_unsupported", "the provider reported that steering is unsupported"],
      ["preparation_retry", "prompt preparation did not finish"],
      ["run_starting", "the target Run is still starting"],
      ["scheduler_pending", "awaiting scheduler admission"],
    ]) {
      await show(`wait:${reason}`);
      const status = page.getByLabel(new RegExp(text)).first();
      await status.waitFor();
      assert.equal(await progress.count(), 0, "waiting does not fabricate progress or delivery");
      assert.equal(await page.getByText("Instructions delivered to Boston", { exact: true }).count(), 0);
      assert((await status.getAttribute("aria-label")).includes("does not guarantee immediate reconsideration"));
      if (reason === "context_refresh") await page.screenshot({ path: path.join(tmpdir(), `steering-wait-${engine}-${surface}-${width}.png`) });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "wait labels fit narrow layouts");
    }
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
    const disclosure = () => progress.getByRole("button", { name: /^(Collapse|Expand) Boston progress:/ });
    assert.equal(await disclosure().getAttribute("aria-expanded"), "true", "expanded by default");
    const bodyId = await disclosure().getAttribute("aria-controls");
    assert.equal(await page.locator(`[id="${bodyId}"]`).getAttribute("hidden"), null);
    for (const [mode, label] of [["command", "running a command"], ["browser", "using the browser"], ["tool", "using a tool"], ["working", "working"]]) {
      await show(mode); await progress.getByText(`is ${label}`, { exact: true }).waitFor();
      assert.equal(await disclosure().getAttribute("aria-expanded"), "true");
    }
    await disclosure().focus(); await page.keyboard.press("Enter");
    assert.equal(await disclosure().getAttribute("aria-expanded"), "false");
    assert.equal(await progress.getByText("The revised approach is now underway", { exact: true }).count(), 0);
    for (const mode of ["first", "browser", "latest"]) {
      await show(mode);
      assert.equal(await disclosure().getAttribute("aria-expanded"), "false", "new updates/activity do not reopen the Run");
    }
    await show("steer");
    assert.equal(await disclosure().getAttribute("aria-expanded"), "false", "moving to a new accepted steer keeps the same Run collapsed");
    await page.getByRole("button", { name: "Remount progress surface", exact: true }).click();
    await disclosure().waitFor();
    assert.equal(await disclosure().getAttribute("aria-expanded"), "false", "remount preserves the Run choice");
    await page.setViewportSize({ width: width < 900 ? 844 : 390, height: width < 900 ? width : 844 });
    assert.equal(await disclosure().getAttribute("aria-expanded"), "false", "orientation-sized changes do not reopen progress");
    await page.setViewportSize({ width, height: 844 });
    await show("newrun");
    await progress.getByText("The revised approach is now underway", { exact: true }).waitFor();
    assert.equal(await disclosure().getAttribute("aria-expanded"), "true", "a different Run defaults to expanded");
    await show("multi");
    await progress.getByRole("button", { name: "Collapse Other-Agent progress: working", exact: true }).waitFor();
    assert.equal(await disclosure().getAttribute("aria-expanded"), "false", "returning to the original Run retains its choice");
    await progress.getByText("The other Agent's public update", { exact: true }).waitFor();
    await show("latest"); await disclosure().click();
    await show("longhandle");
    const longHeader = progress.getByRole("button", { name: /^Collapse Boston-with/ });
    await longHeader.waitFor();
    assert((await longHeader.boundingBox()).height >= 44, "usable disclosure touch target");
    await page.screenshot({ path: path.join(tmpdir(), `live-progress-long-handle-${engine}-${surface}-${width}.png`) });
    assert(await progress.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `long identity wraps safely: ${JSON.stringify(await progress.evaluate(el =>
      [...el.querySelectorAll("*")].filter(child => child.scrollWidth > child.clientWidth + 1).map(child => ({ tag: child.tagName,
        width: child.clientWidth, scroll: child.scrollWidth, text: child.textContent, whiteSpace: getComputedStyle(child).whiteSpace }))))}`);
    await show("latest");
    await progress.getByText("is working", { exact: true }).waitFor();
    assert.equal(await disclosure().getAttribute("aria-expanded"), "true", "legacy missing activity falls back to working");
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
