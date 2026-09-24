import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "request-storm-browser-"));
const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
const playwrightModule = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? serverRequire.resolve("playwright-core"));
const chromium = playwrightModule.chromium ?? playwrightModule.default.chromium;
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
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PONDEROSA_CHROMIUM_PATH,
    args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [],
  });
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
  await Promise.all(pages.map(page => page.evaluate(() => window.startCoordinationStorm())));
  const coordinationBaseline = await Promise.all(pages.map(page => page.evaluate(() => window.stormCounters())));
  for (let index = 0; index < 2; index += 1) {
    await pages[index].waitForFunction(previous => window.stormCounters().health > previous,
      coordinationBaseline[index].health, { timeout: 1_500 });
  }
  await pages[0].waitForTimeout(5_600);
  const coordinationCounts = await Promise.all(pages.map(page => page.evaluate(() => window.stormCounters())));
  for (let index = 0; index < 2; index += 1) {
    for (const key of ["roster", "health", "directory"]) {
      assert.ok(coordinationCounts[index][key] - coordinationBaseline[index][key] <= 2,
        `${key} in visible tab ${index} must stay bounded during sustained coordination`);
    }
    assert.ok(coordinationCounts[index].health > coordinationBaseline[index].health,
      `phase health in visible tab ${index} must refresh during sustained coordination`);
  }
  assert.deepEqual(coordinationCounts[2], coordinationBaseline[2],
    "hidden tab must not refetch under sustained coordination");
  await Promise.all(pages.map(page => page.evaluate(() => { window.stopStorm(); window.startAgentStorm(); })));
  const agentBaseline = await Promise.all(pages.map(page => page.evaluate(() => window.stormCounters())));
  await pages[0].waitForTimeout(5_600);
  const agentCounts = await Promise.all(pages.map(page => page.evaluate(() => window.stormCounters())));
  for (let index = 0; index < 2; index += 1) {
    assert.ok(agentCounts[index].health - agentBaseline[index].health <= 3,
      `Agent stream health in visible tab ${index} must stay bounded during command output`);
    assert.ok(agentCounts[index].health > agentBaseline[index].health,
      `Agent stream health in visible tab ${index} must refresh during command output`);
  }
  assert.deepEqual(agentCounts[2], agentBaseline[2],
    "hidden tab must not refetch from its Agent stream");
  await Promise.all(pages.map(page => page.evaluate(() => { window.stopAgentStorm(); window.startCapabilitiesStorm(); })));
  const capabilityBaseline = await Promise.all(pages.map(page => page.evaluate(() => window.stormCounters())));
  await pages[0].waitForTimeout(5_600);
  const capabilityCounts = await Promise.all(pages.map(page => page.evaluate(() => window.stormCounters())));
  for (let index = 0; index < 2; index += 1) {
    assert.ok(capabilityCounts[index].capabilities - capabilityBaseline[index].capabilities <= 2,
      `capability reads in visible tab ${index} must stay bounded during runtime changes`);
    assert.ok(capabilityCounts[index].capabilities > capabilityBaseline[index].capabilities,
      `capabilities in visible tab ${index} must refresh during runtime changes`);
  }
  assert.deepEqual(capabilityCounts[2], capabilityBaseline[2],
    "hidden tab must not refetch capabilities during runtime changes");
  await Promise.all(pages.map(page => page.evaluate(() => window.startSparseStorm())));
  const sparseBaseline = await Promise.all(pages.map(page => page.evaluate(() => window.stormCounters())));
  await pages[0].waitForTimeout(5_600);
  const sparseCounts = await Promise.all(pages.map(page => page.evaluate(() => window.stormCounters())));
  for (let index = 0; index < 2; index += 1) {
    assert.ok(sparseCounts[index].health - sparseBaseline[index].health <= 2,
      `phase refresh in visible tab ${index} must remain bounded when events arrive every 900 ms`);
  }
  assert.deepEqual(sparseCounts[2], sparseBaseline[2], "hidden tab stays quiet during sparse output");
  await pages[2].evaluate(() => {
    window.stormVisible = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await pages[2].waitForFunction(previous => window.stormCounters().roster > previous, sparseCounts[2].roster);
  for (const page of pages) {
    await page.evaluate(() => { window.stopStorm(); window.terminalStorm(); });
    await page.locator("#roster").getByText("terminal").waitFor({ timeout: 2_000 });
    await page.locator("#phase").getByText("true").waitFor({ timeout: 2_000 });
  }
  await pages[0].evaluate(() => {
    window.stormFailNextPhaseFetch();
    window.terminalStorm();
  });
  await pages[0].locator("#phase").getByText("false").waitFor({ timeout: 2_000 });
  await pages[0].locator("#phase").getByText("true").waitFor({ timeout: 12_000 });
  for (const page of pages) {
    await page.evaluate(() => window.replayCompletedChat());
    await page.locator("#chat").getByText("Agent replied").waitFor({ timeout: 2_000 });
    await page.locator("#delivery").getByText("processed").waitFor({ timeout: 2_000 });
  }
  const replayBaseline = await Promise.all(pages.map(page => page.evaluate(() => window.stormCounters())));
  await Promise.all(pages.map(page => page.evaluate(() => window.replayChatBurst())));
  for (const page of pages) {
    await page.locator("#chat").getByText("Revised reply").waitFor({ timeout: 2_000 });
  }
  const replayCounts = await Promise.all(pages.map(page => page.evaluate(() => window.stormCounters())));
  for (let index = 0; index < pages.length; index += 1) {
    assert.ok(replayCounts[index].chat - replayBaseline[index].chat <= 1,
      `Chat detail in tab ${index} must reconcile once for a replay batch`);
    assert.ok(replayCounts[index].delivery - replayBaseline[index].delivery <= 1,
      `delivery receipts in tab ${index} must reconcile once for a replay batch`);
  }
  for (const page of pages) {
    await page.evaluate(() => window.emitLiveChat());
    await page.locator("#chat").getByText("Latest live reply").waitFor({ timeout: 2_000 });
    await page.locator("#delivery").getByText("processed again").waitFor({ timeout: 2_000 });
  }
  const samples = (await Promise.all(pages.map(page => page.evaluate(() => window.stormApiLatencies())))).flat();
  samples.sort((a, b) => a - b);
  const apiP95Ms = samples[Math.ceil(samples.length * 0.95) - 1];
  const eventLoopP95Ms = loopDelay.percentile(95) / 1_000_000;
  assert.ok(apiP95Ms < 250, `isolated API p95 must stay under 250 ms; got ${apiP95Ms}`);
  assert.ok(eventLoopP95Ms < 100, `isolated event-loop p95 must stay under 100 ms; got ${eventLoopP95Ms}`);
  console.log(`PASS 12-Agent, three-tab stream: bounded refresh and replay, live Chat and receipt delivery, hidden-tab pause/reconcile, terminal and failed-fetch recovery; isolated API p95 ${apiP95Ms.toFixed(1)} ms, event-loop p95 ${eventLoopP95Ms.toFixed(1)} ms`);
  await Promise.all(pages.map(page => page.context().close()));
} finally {
  loopDelay.disable();
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
