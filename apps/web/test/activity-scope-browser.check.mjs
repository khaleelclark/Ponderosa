import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "activity-scope-browser-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
const requests = [], attempts = new Map();
let browser, server, failNextRefresh = false;
try {
  const build = await createRsbuild({ cwd: root, rsbuildConfig: { plugins: [pluginReact()], source: { transformImport: [], entry: { index: path.join(root, "test/activity-scope-browser-entry.tsx") } }, output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const json = value => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) requests.push({ path: url.pathname, search: url.searchParams.get("search") ?? "", cursor: url.searchParams.get("cursor"), at: Date.now() });
    if (url.pathname === "/api/fixture/fail-refresh") { failNextRefresh = true; return json({}); }
    if (url.pathname.endsWith("/usage")) return json({ scope: "overall", finalizedRuns: 0, reportedRuns: 0, providerRequests: 0, durationMs: 0, metricAvailability: {}, breakdown: [], wakeCauses: [] });
    const match = /^\/api\/workspace\/directory\/(conversation|agent)$/u.exec(url.pathname);
    if (match) {
      const kind = match[1], search = url.searchParams.get("search") ?? "", cursor = url.searchParams.get("cursor");
      assert.equal(url.searchParams.get("limit"), "25");
      assert.equal(url.searchParams.get("projectId"), null);
      const key = `${kind}:${search}:${cursor ?? "initial"}`, attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      if (failNextRefresh && kind === "conversation" && !search && !cursor) { failNextRefresh = false; response.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"Refresh unavailable"}'); return; }
      if (search === "limited" && kind === "conversation" && attempt === 1) { response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" }).end('{"error":"Busy"}'); return; }
      if (search === "broken" && kind === "agent" && attempt === 1) { response.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"Unavailable"}'); return; }
      if (!search && cursor && kind === "conversation" && attempt === 1) { response.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"Page unavailable"}'); return; }
      if (!search && !cursor) await new Promise(resolve => setTimeout(resolve, 500));
      const items = Array.from({ length: 400 }, (_, index) => {
        const project = { id: `project-${index % 250}`, label: `Folder ${index % 250}`, hostPath: `/fixture/${index % 250}` };
        return kind === "conversation" ? { kind, project, conversation: { id: `chat-${index}`, projectId: project.id, title: `Chat ${index}`, archived: false } }
          : { kind, project, ownerConversation: { id: `chat-${index}`, title: `Chat ${index}` }, agent: { id: `agent-${index}`, projectId: project.id, title: `Reviewer ${index}`, handle: `reviewer-${index}`, conversationId: `chat-${index}`, activeEngine: "codex" }, health: { status: "idle" } };
      }).filter(item => !search || JSON.stringify(item).toLowerCase().includes(search.toLowerCase()));
      const offset = Number(cursor ?? 0), more = offset + 25 < items.length;
      return json({ kind, items: items.slice(offset, offset + 25), starredItems: [], total: items.length, history: { hasMore: more, cursor: more ? String(offset + 25) : undefined } });
    }
    try { const file = path.join(output, url.pathname === "/" ? "index.html" : url.pathname); response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html"); response.end(await readFile(file)); }
    catch { response.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH, args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const width of [390, 1440]) {
    attempts.clear(); requests.length = 0;
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.goto(origin);
    await page.getByText("Loading Chat scopes…", { exact: true }).waitFor();
    await page.getByText("Loading Agent scopes…", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Load more Chat scopes", exact: true }).waitFor();
    await page.waitForTimeout(800);
    assert.equal(requests.filter(item => item.path.startsWith("/api/workspace/directory/")).length, 2, "250 Projects cost only two first-page directory requests, without collecting pages or refetching pre-populated management caches");
    assert.equal(requests.filter(item => item.path.startsWith("/api/projects/")).length, 0, "no Project collectors");
    await page.evaluate(async () => { await fetch("/api/fixture/fail-refresh"); await window.refreshScopes(); });
    await page.getByText("Could not refresh Chat scopes. Existing results are still available.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByText("Could not refresh Chat scopes. Existing results are still available.", { exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Load more Chat scopes", exact: true }).click();
    await page.getByText("Could not load more Chat scopes. Existing results are still available.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    const selector = page.getByRole("combobox", { name: "Scope", exact: true });
    await selector.click();
    await page.getByRole("option", { name: "Chat 49 · Folder 49", exact: true }).waitFor();
    await selector.fill("Reviewer 394");
    await page.getByRole("option", { name: "Reviewer 394 · #reviewer-394 · Chat 394", exact: true }).click();
    assert.equal(await selector.inputValue(), "Reviewer 394 · #reviewer-394 · Chat 394");
    await page.getByRole("button", { name: "Load more Agent scopes", exact: true }).waitFor();
    assert.equal(await selector.inputValue(), "Reviewer 394 · #reviewer-394 · Chat 394", "selection survives a search/page reset");
    await selector.fill("Chat 394");
    await page.getByRole("option", { name: "Chat 394 · Folder 144", exact: true }).click();
    assert.equal(await selector.inputValue(), "Chat 394 · Folder 144");
    await page.waitForFunction(() => !document.querySelector('.MuiLinearProgress-root'));
    assert.ok(requests.some(item => item.path === "/api/agents/agent-394/usage"));
    assert.ok(requests.some(item => item.path === "/api/conversations/chat-394/usage"));
    await selector.fill("broken");
    await page.getByText("Could not load Agent scopes.", { exact: true }).waitFor();
    await selector.press("Escape");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByText("No matching Agent scopes", { exact: true }).waitFor();
    await selector.fill("limited");
    await page.getByText("Could not load Chat scopes.", { exact: true }).waitFor();
    const limitedAt = requests.find(item => item.path.endsWith("/conversation") && item.search === "limited").at;
    await selector.press("Escape");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByText("No matching Chat scopes", { exact: true }).waitFor();
    const retries = requests.filter(item => item.path.endsWith("/conversation") && item.search === "limited");
    assert.equal(retries.length, 2, "one explicit retry, not a request loop");
    assert.ok(retries[1].at - limitedAt >= 950, "Retry honors the shared 429 cooldown");
    await page.close();
  }
  console.log("Passed: Activity with 250 Projects uses two bounded first-page queries; explicit pagination and initial/refresh/pagination Retry, server-side search for later Agent/Chat scopes, stable selected identity, visible loading/503/429 errors and shared Retry-After cooldown at 390/1440px.");
} finally { await browser?.close(); server?.close(); await rm(output, { recursive: true, force: true }); }
