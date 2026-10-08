import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const web = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "dead-code-cleanup-ui-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
let browser, server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/dead-code-cleanup-entry.tsx") } },
    output: { distPath: { root: output }, minify: false }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(output, "." + (path.extname(pathname) ? pathname : "/index.html"));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try {
      const content = await readFile(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".woff2") ? "font/woff2" : "text/html" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH,
    args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
    await context.addInitScript(() => {
      localStorage.setItem("ponderosa.lastProjectId", "retained-old-project");
      localStorage.setItem("ponderosa.projectRouteHistory.v1", '{"old":"retained"}');
      window.fixtureSignals = [];
      const worker = new EventTarget();
      worker.controller = { postMessage: signal => window.fixtureSignals.push(signal) };
      Object.defineProperty(navigator, "serviceWorker", { value: worker });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/manage/agents`);
    await page.getByRole("heading", { name: "Manage Agents", exact: true }).waitFor();
    await page.goto(`${origin}/manage/chats`);
    await page.getByRole("heading", { name: "Manage Chats", exact: true }).waitFor();
    const select = page.getByRole("checkbox", { name: "Select Initial Conversation", exact: true });
    await select.check();
    await page.getByText("1 selected", { exact: true }).waitFor();
    await select.uncheck();
    await page.getByRole("button", { name: "Open Initial Conversation", exact: true }).click();
    await page.waitForURL("**/projects/project/chats/chat");
    await page.goBack();
    await page.getByRole("heading", { name: "Manage Chats", exact: true }).waitFor();
    await page.goForward();
    await page.waitForURL("**/projects/project/chats/chat");
    await page.reload();
    const actions = page.getByRole("button", { name: "Chat settings and actions", exact: true });
    await actions.click();
    await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
    await page.getByRole("menuitem", { name: "Chat Transcript", exact: true }).click();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Initial Conversation/);
    await actions.click();
    await page.getByRole("menuitem", { name: "Download", exact: true }).click();
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Chat Transcript", exact: true }).click();
    const download = await downloadEvent;
    assert.equal(await download.failure(), null);
    assert.match(await readFile(await download.path(), "utf8"), /Initial Conversation/);
    await actions.click();
    await page.keyboard.press("Escape");
    assert.equal(await actions.getAttribute("aria-expanded"), null);
    await page.waitForFunction(() => window.fixtureSignals.some(signal => signal.view?.conversationId === "chat"));
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => window.fixtureSignals.at(-1).view === null);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
    });
    await page.waitForFunction(() => window.fixtureSignals.at(-1).view?.conversationId === "chat");
    const returnTo = "/projects/project/chats/chat?view=files";
    await page.evaluate(target => {
      history.pushState({}, "", `/projects/project/files/view?path=fixture.txt&returnTo=${encodeURIComponent(target)}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, returnTo);
    await page.getByRole("heading", { name: "fixture.txt", level: 1, exact: true }).waitFor();
    await page.getByRole("button", { name: /^Back to/ }).click();
    await page.waitForURL(`**${returnTo}`);
    await page.getByText("31 loaded items created by Agents in this Chat", { exact: true }).waitFor();
    const scroller = page.locator("#chat-workspace-files-panel .ponderosa-scroll");
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    assert.ok(await scroller.evaluate(element => element.scrollTop > 0));
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem("ponderosa.lastProjectId"), localStorage.getItem("ponderosa.projectRouteHistory.v1")]),
      ["retained-old-project", '{"old":"retained"}']);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}: management selection, native history/reload, transcript copy/download, overflow keyboard dismissal, active-view visibility/controllerchange, file return route and scroll; legacy storage retained`);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(output, { recursive: true, force: true });
}
