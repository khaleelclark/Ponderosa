import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "request-storm-browser-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
let browser;
let server;
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
try {
  const build = await createRsbuild({
    cwd: root,
    rsbuildConfig: {
      plugins: [pluginReact()],
      source: { entry: { index: path.join(root, "test/request-storm-browser-entry.tsx") } },
      output: { distPath: { root: output } },
      logLevel: "error",
    },
  });
  await build.build();
  server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (pathname === "/api/storm-probe") {
        res.setHeader("Content-Type", "text/plain");
        res.end("ok");
        return;
      }
      const file = path.join(output, pathname === "/" ? "index.html" : pathname);
      res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH });
  const pages = [];
  for (let index = 0; index < 3; index += 1) {
    const context = await browser.newContext();
    if (index === 2) {
      await context.addInitScript(() => Object.defineProperty(document, "visibilityState", {
        configurable: true, get: () => window.stormVisible ? "visible" : "hidden",
      }));
    }
    const page = await context.newPage();
    pages.push(page);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator("#roster").getByText("working").waitFor();
  }
  const baseline = await Promise.all(pages.map(page => page.evaluate(() => window.stormCounters())));
  await pages[0].waitForTimeout(5_600);
  const counts = await Promise.all(pages.map(page => page.evaluate(() => window.stormCounters())));
  for (let index = 0; index < 2; index += 1) {
    for (const key of ["roster", "health", "directory", "task"]) {
      assert.ok(counts[index][key] - baseline[index][key] <= 2,
        `${key} in visible tab ${index} must be bounded during 12-Agent output`);
    }
    assert.ok(counts[index].details - baseline[index].details <= 12,
      `Agent-detail refreshes in visible tab ${index} must remain bounded`);
    assert.ok(counts[index].health > baseline[index].health,
      `phase health in visible tab ${index} must refresh despite continuous events`);
  }
  assert.deepEqual(counts[2], baseline[2], "hidden tab must not refetch under sustained Agent output");
  await pages[2].evaluate(() => {
    window.stormVisible = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await pages[2].waitForFunction(previous => window.stormCounters().roster > previous, counts[2].roster);
  for (const page of pages) {
    await page.evaluate(() => { window.stopStorm(); window.terminalStorm(); });
    await page.locator("#roster").getByText("terminal").waitFor({ timeout: 2_000 });
    await page.locator("#phase").getByText("true").waitFor({ timeout: 2_000 });
  }
  const samples = (await Promise.all(pages.map(page => page.evaluate(() => window.stormApiLatencies())))).flat();
  samples.sort((a, b) => a - b);
  const apiP95Ms = samples[Math.ceil(samples.length * 0.95) - 1];
  const eventLoopP95Ms = loopDelay.percentile(95) / 1_000_000;
  assert.ok(apiP95Ms < 250, `isolated API p95 must stay under 250 ms; got ${apiP95Ms}`);
  assert.ok(eventLoopP95Ms < 100, `isolated event-loop p95 must stay under 100 ms; got ${eventLoopP95Ms}`);
  console.log(`PASS 12-Agent, three-tab stream: bounded refresh, hidden-tab pause/reconcile, prompt terminal state; isolated API p95 ${apiP95Ms.toFixed(1)} ms, event-loop p95 ${eventLoopP95Ms.toFixed(1)} ms`);
  await Promise.all(pages.map(page => page.context().close()));
} finally {
  loopDelay.disable();
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
