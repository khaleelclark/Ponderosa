import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "ponderosa-ui-audit-browser-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
const contrastRatio = async locator => locator.evaluate(node => {
  const rgba = value => value.match(/[\d.]+/g).map(Number);
  const over = (front, back) => front.slice(0, 3).map((value, i) => value * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)));
  let bg = [255, 255, 255];
  const ancestors = []; for (let current = node; current; current = current.parentElement) ancestors.push(current);
  for (const current of ancestors.reverse()) bg = over(rgba(getComputedStyle(current).backgroundColor), bg);
  const fg = over(rgba(getComputedStyle(node).color), bg);
  const luminance = color => color.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  const a = luminance(fg), b = luminance(bg); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
});
let browser, server;
try {
  const build = await createRsbuild({ cwd: root, rsbuildConfig: { plugins: [pluginReact()],
    source: { transformImport: [], entry: { index: path.join(root, "test/ui-audit-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/download/good") { res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="result.txt"' }).end("actual report bytes"); return; }
    if (url.pathname === "/api/download/bad") { res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"missing"}'); return; }
    try {
      const file = path.join(output, url.pathname === "/" ? "index.html" : url.pathname);
      res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH,
    args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${origin}/?theme=${theme}`);
    await page.getByText("Recorded changes from this response", { exact: false }).waitFor();
    for (const index of [0, 37, 74]) {
      if (width === 390) await page.getByRole("button", { name: "Files", exact: true }).click();
      await page.getByRole("button", { name: `Review src/file-${index}.ts`, exact: true }).click();
      const selectedRow = page.getByRole("button", { name: `Review src/file-${index}.ts`, exact: true, includeHidden: true });
      for (const text of await selectedRow.locator(".MuiTypography-root").all()) {
        const ratio = await contrastRatio(text);
        assert.ok(ratio >= 4.5, `${theme} selected-row text contrast ${ratio.toFixed(2)} must reach 4.5:1`);
      }
      const text = page.locator('pre[aria-label="Unified diff"]');
      await text.getByText(`+new-${index}`, { exact: true }).waitFor();
      const bounds = await text.boundingBox();
      assert.ok(bounds && bounds.y >= 0 && bounds.y < 900, `selected file ${index} is immediately visible at ${width}px`);
      assert.equal(await text.getByText(`-old-${index}`, { exact: true }).count(), 1);
      for (const line of [`+new-${index}`, `-old-${index}`]) {
        const ratio = await contrastRatio(text.getByText(line, { exact: true }));
        assert.ok(ratio >= 4.5, `${theme} ${line} contrast ${ratio.toFixed(2)} must reach 4.5:1`);
      }
      if (index === 74) assert.ok(await text.evaluate(node => node.scrollWidth > node.clientWidth), "long diff lines scroll horizontally instead of clipping");
      if (width === 390) assert.equal(await page.getByRole("button", { name: `Review src/file-${index}.ts`, exact: true }).isVisible(), false);
    }
    await page.getByRole("button", { name: "Refresh review", exact: true }).click();
    await page.locator('pre[aria-label="Unified diff"]').getByText("+new-74", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Back to Chat", exact: true }).click();
    assert.equal(await page.evaluate(() => document.body.dataset.returned), "chat");
    await page.close();
    const scope = await browser.newPage({ viewport: { width, height: 900 } });
    await scope.goto(`${origin}/?case=scope&theme=${theme}`);
    const selector = scope.getByRole("combobox", { name: "Scope", exact: true });
    await selector.click();
    await selector.fill("Reviewer 694");
    await scope.getByRole("option", { name: /Reviewer 694/ }).waitFor();
    await selector.press("ArrowDown"); await selector.press("Enter");
    assert.match(await selector.inputValue(), /Reviewer 694.*#reviewer-694.*Marketing/);
    await selector.fill("Marketing");
    await scope.getByRole("option", { name: "Marketing · Working folder", exact: true }).click();
    assert.equal(await selector.inputValue(), "Marketing · Working folder");
    await scope.close();
    const diagnostic = await browser.newPage({ viewport: { width, height: 900 } });
    await diagnostic.goto(`${origin}/?case=diagnostic&theme=${theme}`);
    const why = diagnostic.getByRole("region", { name: "Why You’re Here" });
    await why.getByText("Failed assignment", { exact: true }).waitFor();
    assert.equal(await why.getByText("Successful earlier wake-up", { exact: true }).count(), 0);
    await diagnostic.getByRole("button", { name: "Collapse Assignment workflow", exact: true }).waitFor();
    await diagnostic.waitForFunction(() => document.activeElement?.id === "agent-work-focus-request:failed-request");
    await diagnostic.close();
    const profile = await browser.newPage({ viewport: { width, height: 900 } });
    await profile.goto(`${origin}/?case=profile&theme=${theme}`);
    await profile.getByRole("textbox", { name: "Display name" }).fill("");
    await profile.getByText("Enter a display name.", { exact: true }).waitFor();
    assert.equal(await profile.getByRole("button", { name: "Save profile" }).isEnabled(), false);
    await profile.getByRole("textbox", { name: "Display name" }).fill("Tester");
    await profile.getByRole("textbox", { name: "Handle" }).fill("broadcast");
    await profile.getByText("This handle is reserved. Choose another.", { exact: true }).waitFor();
    await profile.getByRole("textbox", { name: "Handle" }).fill("1bad");
    await profile.getByText("Use 2–32 characters, starting with a letter: lowercase letters, numbers, underscores, or hyphens.", { exact: true }).waitFor();
    await profile.getByRole("textbox", { name: "Handle" }).fill("tester");
    assert.equal(await profile.getByRole("button", { name: "Save profile" }).isEnabled(), true);
    await profile.close();
    const cancellation = await browser.newPage({ viewport: { width, height: 900 } });
    await cancellation.goto(`${origin}/?case=cancel&theme=${theme}`);
    await cancellation.getByRole("button", { name: /Stopping this work; termination has not been confirmed yet/ }).waitFor();
    await cancellation.getByRole("button", { name: /This work was stopped/ }).waitFor();
    await cancellation.getByRole("button", { name: /whether its work stopped is unconfirmed/ }).waitFor();
    assert.equal(await cancellation.getByRole("button", { name: /Message delivered to Reviewer/ }).count(), 3);
    await cancellation.close();
    const fresh = await browser.newPage({ viewport: { width, height: 900 } });
    await fresh.goto(`${origin}/?case=fresh-session&theme=${theme}`);
    const startFresh = fresh.getByRole("button", { name: "Start Fresh Provider Session For Next Run", exact: true });
    await startFresh.click();
    await fresh.getByText("Starting a fresh provider session for the next Run…", { exact: true }).waitFor();
    assert.equal(await fresh.getByRole("button", { name: "Scheduling fresh session…", exact: true }).isDisabled(), true);
    assert.equal(await fresh.evaluate(() => document.body.dataset.freshCalls), "1");
    await fresh.evaluate(() => window.settleFreshSession(false));
    await fresh.getByText("Fresh provider session scheduled for the next Run. Canonical history is unchanged.", { exact: true }).waitFor();
    await fresh.getByRole("button", { name: "Switch Agent", exact: true }).click();
    await fresh.getByText("Fresh provider session scheduled for the next Run. Canonical history is unchanged.", { exact: true }).waitFor({ state: "hidden" });
    await startFresh.click();
    await fresh.waitForFunction(() => document.body.dataset.freshCalls === "2");
    await fresh.evaluate(() => window.settleFreshSession(true));
    await fresh.getByText("Provider could not schedule the fresh session. Try again.", { exact: true }).waitFor();
    assert.equal(await startFresh.isEnabled(), true);
    await fresh.close();
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, acceptDownloads: true });
  await page.goto(`${origin}/?case=download`);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download report", exact: true }).click()]);
  assert.equal(download.suggestedFilename(), "result.txt");
  assert.equal(await readFile(await download.path(), "utf8"), "actual report bytes");
  await page.getByText("Download started", { exact: true }).waitFor();
  await page.getByText("Download started", { exact: true }).waitFor({ state: "hidden", timeout: 5000 });
  let badDownloads = 0;
  page.on("download", () => badDownloads++);
  await page.getByRole("link", { name: "Download missing report", exact: true }).click();
  await page.getByText("Download could not start (404). Try again.", { exact: true }).waitFor();
  assert.equal(badDownloads, 0);
  const [transcript] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download transcript", exact: true }).click()]);
  assert.match(await readFile(await transcript.path(), "utf8"), /marketing/);
  await page.close();
  console.log("Passed: 75-file response review/selected-row and diff contrast/horizontal scrolling and refresh at 390/1440px in both themes; 695-Agent searchable scope; exact failed-Request focus, profile validation, cancellation wording, pending/success/failure and Agent-scoped fresh-session feedback, actual download/transcript bytes and failed-download feedback.");
} finally { await browser?.close(); server?.close(); await rm(output, { recursive: true, force: true }); }
