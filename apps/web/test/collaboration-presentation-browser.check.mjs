import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const web = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "collaboration-browser-"));
const fixture = await readFile(process.env.PONDEROSA_COLLABORATION_FIXTURE, "utf8");
const data = JSON.parse(fixture);
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
const baseline = process.env.PONDEROSA_BASELINE === "1";
let browser, server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/collaboration-presentation-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/fixture.json") { response.writeHead(200, { "Content-Type": "application/json" }).end(fixture); return; }
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try { const content = await readFile(file); response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await playwright[engine].launch({ headless: true,
    ...(engine === "chromium" ? { executablePath: process.env.PONDEROSA_CHROMIUM_PATH } : {}) });
  for (const width of [320, 390, 1440]) for (const surface of baseline ? ["team", "agent"] : ["team", "agent", "all"]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { document.body.dataset.copied = text; } } }));
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?surface=${surface}&theme=${theme}`);
    await page.getByText(surface === "all" ? "Operator collaboration." : "Investigation complete.", { exact: true }).waitFor();
    const boston = page.getByRole("button", { name: /^Open agent Boston/ });
    if (baseline) assert.equal(await boston.count(), 2, "baseline omits Boston on the unaddressed result and incorrectly binds #issue");
    else {
      assert.equal(await boston.count(), surface === "all" ? 1 : 3, "each canonical recipient is visible once per message");
      await boston.first().click();
      assert.equal(await page.evaluate(() => document.body.dataset.openAgent), data.agents[1].id);
      assert.equal(await page.getByRole("button", { name: /^Open agent Juniper/ }).count(), 1);
      if (surface !== "all") assert((await page.locator("body").textContent()).includes("#issue investigation complete"));
      assert.equal(await page.getByRole("button", { name: /Open agent issue/ }).count(), 0);
      const article = page.locator("article").first();
      await article.hover();
      const copy = article.getByRole("button", { name: surface === "all" ? "Copy message" : "Copy whole message", exact: true });
      await copy.focus(); await page.keyboard.press("Enter");
      assert.equal(await page.evaluate(() => document.body.dataset.copied), surface === "all" ? "Operator collaboration." : "Investigation complete.");
      await article.getByRole("button", { name: "View message details", exact: true }).click();
      const details = page.getByRole("dialog", { name: "Message details", exact: true });
      await details.waitFor({ timeout: 3000 }).catch(async error => {
        console.error(surface, theme, width, await page.locator("[role=dialog]").evaluateAll(elements => elements.map(el => el.outerHTML.slice(0, 1200))));
        console.error(errors);
        await page.screenshot({ path: path.join(tmpdir(), "collaboration-details-failure.png") });
        throw error;
      });
      for (const text of ["Addressed to:", "Human visibility:", "Delivery evidence:", "No linked Request or input evidence"]) {
        assert((await details.textContent()).includes(text));
      }
      assert(await details.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "details fit the viewport");
      await page.keyboard.press("Escape");
      await details.waitFor({ state: "detached" });
    }
    assert.equal(errors.length, 0, errors.join("\n"));
    await page.screenshot({ path: path.join(tmpdir(), `collaboration-${baseline ? "baseline" : "fixed"}-${engine}-${surface}-${theme}-${width}.png`) });
    assert(await page.locator("#root").evaluate(el => el.scrollWidth <= el.clientWidth + 1), "message surface fits the viewport");
    await page.close();
  }
  assert.deepEqual(data.before, data.after, "presentation creates no delivery authority");
  if (!baseline) {
    assert.equal(data.allPage.items.length, 1);
    assert.equal(data.allPage.items[0].author.kind, "user", "All Messages excludes Agent-to-Agent Collaboration");
  }
  console.log(`${engine}: persisted ${baseline ? "baseline reproduction" : "recipient rendering"} passed`);
} finally { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); await rm(output, { recursive: true, force: true }); }
