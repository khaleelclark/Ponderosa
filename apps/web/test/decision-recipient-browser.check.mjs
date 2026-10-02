import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const web = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "decision-recipient-"));
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
let browser, server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/decision-recipient-browser-entry.tsx") }, alias: {
      "@decision-timeline": path.resolve(process.env.PONDEROSA_DECISION_BASE_SOURCE ?? web, "src/components/ConversationView.parts.tsx"),
      react: path.join(web, "node_modules/react"),
      "react-dom": path.join(web, "node_modules/react-dom"),
      "@emotion/react": path.join(web, "node_modules/@emotion/react"),
    } },
    output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    const file = path.resolve(output, "." + (new URL(request.url, "http://localhost").pathname === "/" ? "/index.html" : new URL(request.url, "http://localhost").pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try { const content = await readFile(file); response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await playwright[engine].launch({ headless: true,
    ...(engine === "chromium" ? { executablePath: process.env.PONDEROSA_CHROMIUM_PATH } : {}) });
  const errors = [];
  for (const width of [320, 390, 1440]) {
    for (const surface of process.env.PONDEROSA_DECISION_BASELINE ? ["project"] : ["project", "agent", "all"]) {
    for (const scenario of process.env.PONDEROSA_DECISION_BASELINE ? ["text"] : ["text", "choice", "approval", "renamed", "deleted", "historical", "mismatched", "automatic"]) {
    console.log(`Checking ${engine} ${width}px ${surface}/${scenario}`);
    const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: width < 900 });
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.goto(`http://127.0.0.1:${server.address().port}/?surface=${surface}&scenario=${scenario}`);
    const canonical = await page.evaluate(() => document.body.dataset.canonical);
    if (process.env.PONDEROSA_DECISION_BASELINE) {
      await page.getByText("You answered Do it all from scratch yourself", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Open agent Boston" }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "View question" }).count(), 0);
    } else if (scenario === "automatic") {
      await page.getByText("Automatically allowed by your saved permission", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "View question", exact: true }).count(), 0);
    } else {
      const label = scenario === "renamed" ? "Boston-Renamed" : "Boston";
      const hasRecipient = !["deleted", "historical", "mismatched"].includes(scenario);
      const expected = `${scenario === "approval" ? "Approval response to" : scenario === "choice" ? "Chose for" : "Answered"} ${hasRecipient ? `#${label}` : scenario === "deleted" ? "Deleted Agent" : "Agent unavailable"}: ${["choice", "approval"].includes(scenario) ? "Continue" : "Do it all from scratch yourself"}`;
      await page.getByRole("article", { name: expected, exact: true }).waitFor();
      if (hasRecipient) {
        await page.getByRole("button", { name: `Open agent ${label}`, exact: true }).click();
        assert.equal(await page.evaluate(() => document.body.dataset.openAgent), "boston-id");
      } else assert.equal(await page.getByRole("button", { name: /^Open agent / }).count(), 0);
      await page.getByRole("button", { name: "View question", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Original question", exact: true });
      await dialog.getByText("How should I build it?", { exact: true }).waitFor();
      assert.equal(await dialog.locator("[data-decision-id]").getAttribute("data-decision-id"), `question-${scenario}`);
      await dialog.getByRole("button", { name: "Close question", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "View question", exact: true }).focus();
      await page.keyboard.press("Enter");
      await dialog.waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.equal(await page.getByRole("button", { name: "View question", exact: true }).evaluate(e => e === document.activeElement), true);
      const dimensions = await page.getByRole("article", { name: expected }).evaluate(e => ({ client: e.clientWidth, scroll: e.scrollWidth }));
      assert(dimensions.scroll <= dimensions.client + 1, `${surface}/${scenario}/${width} stays compact`);
    }
    assert.equal(await page.evaluate(() => document.body.dataset.canonical), canonical);
    await page.close();
    }
    }
  }
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: ${process.env.PONDEROSA_DECISION_BASELINE ? "reproduced missing recipient/question action in isolated current timeline" : "recipient and exact original question"}`);
} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(output, { recursive: true, force: true });
}
