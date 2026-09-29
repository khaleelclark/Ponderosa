import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { AgentStore } from "../../../packages/agents/dist/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "sidebar-message-browser-"));
const data = await mkdtemp(path.join(tmpdir(), "sidebar-message-data-"));
const store = new AgentStore(data);
const project = store.createProject({ label: "Marketing working folder", hostPath: data, defaultEngine: "codex" });
const chat = store.createConversation(project.id, { title: "Planning" });
const chats = [chat, ...Array.from({ length: 5 }, (_, index) => store.createConversation(project.id, { title: `Other ${index}` }))];
const archived = store.createConversation(project.id, { title: "Archived" });
const add = (conversation, text, index) => {
  const event = store.appendCommunicationEvent({ eventId: randomUUID(), projectId: project.id, conversationId: conversation.id, schemaVersion: 2,
    sender: { kind: "user", userId: "operator" }, intent: "broadcast", audience: { kind: "organization", organizationId: project.id }, text,
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString() }).event;
  store.appendCommunicationProjection(project.id, { eventId: event.eventId, surface: "conversation", projectionKey: conversation.id, projectedAt: event.createdAt,
    message: { messageId: event.eventId, role: "user", createdAt: event.createdAt } });
  return event;
};
const target = add(chat, "Our marketing plan from older history", 0);
for (let index = 1; index < 80; index++) add(chat, "Newer unrelated message", index);
for (let index = 1; index < chats.length; index++) add(chats[index], "Our marketing campaign", -index);
add(archived, "Private archived marketing", 100);
store.updateConversation(archived.id, { archived: true });
const latencies = [], requests = [];
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
let browser, server, lastPage;
try {
  const build = await createRsbuild({ cwd: root, rsbuildConfig: { plugins: [pluginReact()], source: { transformImport: [], entry: { index: path.join(root, "test/sidebar-message-search-browser-entry.tsx") } }, output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const json = value => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
    if (url.pathname === "/api/fixture") return json({ projects: [project], chats });
    if (url.pathname === "/api/search") {
      const term = url.searchParams.get("q") ?? "";
      requests.push({ term, at: Date.now() });
      if (term === "limited") { response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "2" }).end('{"error":"Search is busy"}'); return; }
      if (term === "broken") { response.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"Unavailable"}'); return; }
      const start = performance.now();
      const result = store.searchGlobalChats({ query: term, limit: Number(url.searchParams.get("limit") ?? 5), chatKind: "conversation", distinctChats: url.searchParams.get("distinct") === "chats" });
      latencies.push(performance.now() - start);
      return json(result);
    }
    const match = /^\/api\/conversations\/([^/]+)$/u.exec(url.pathname);
    if (match) {
      const conversation = store.getConversation(match[1]);
      const page = store.getProjectedConversationMessagePage(match[1], "main", { limit: Number(url.searchParams.get("limit") ?? 50), focusId: url.searchParams.get("focusId") ?? undefined });
      return json({ conversation, messages: page.messages, agents: [], decisionEvents: [], history: { hasMore: page.hasMore, cursor: page.cursor } });
    }
    try { const file = path.join(output, url.pathname === "/" ? "index.html" : url.pathname); response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html"); response.end(await readFile(file)); }
    catch { response.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH, args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    lastPage = page;
    page.on("pageerror", error => console.error("Fixture page error:", error.message));
    await page.goto(origin);
    const input = page.getByRole("textbox", { name: "Search chats" });
    await input.fill("marketing");
    const section = page.getByRole("region", { name: "Found in messages" });
    const matching = section.getByRole("button", { name: "Open Planning at matching message", exact: true });
    await matching.waitFor();
    assert.equal(await section.locator("mark").filter({ hasText: "marketing" }).count(), 5);
    assert.equal(await section.getByRole("button", { name: /Open Archived/ }).count(), 0);
    await matching.focus(); await matching.press("Enter");
    await page.locator(`#master-message-${target.eventId}[data-notification-focus="true"]`).waitFor();
    const route = JSON.parse(await page.locator("#route").innerText());
    assert.equal(route.focusMessageId, target.eventId);
    assert.equal(route.conversationId, chat.id);
    await input.fill("marketing");
    await matching.waitFor();
    await page.getByRole("button", { name: "View more in full search" }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Search Ponderosa"]')?.value === "marketing");
    assert.equal(await page.getByRole("combobox", { name: "Search Ponderosa" }).inputValue(), "marketing");
    assert.equal(await page.getByRole("button", { name: "Chats", exact: true }).getAttribute("aria-pressed"), "true");
    await page.getByRole("combobox", { name: "Search Ponderosa" }).press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await input.fill("broken");
    await section.getByText("Message results are unavailable. Chat-name results are still shown.").waitFor();
    await input.fill("Planning");
    await page.getByRole("button", { name: "Open Chat Planning", exact: true }).waitFor();
    await input.fill("limited");
    await section.getByText("Message results are unavailable. Chat-name results are still shown.").waitFor();
    const limitedAt = requests.filter(item => item.term === "limited").at(-1).at;
    await input.fill("cooldown");
    await page.waitForTimeout(500);
    assert.ok(!requests.some(item => item.term === "cooldown" && item.at < limitedAt + 1900));
    await page.getByRole("button", { name: "Toggle panel" }).click();
    await page.waitForTimeout(1800);
    assert.ok(!requests.some(item => item.term === "cooldown" && item.at >= limitedAt), "closing the panel cancels a cooldown-waiting search");
    await page.close();
  }
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext()));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  await pages[2].addInitScript(() => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }));
  await Promise.all(pages.map(page => page.goto(origin)));
  const before = requests.length;
  await Promise.all(pages.map(page => page.getByRole("textbox", { name: "Search chats" }).fill("campaign")));
  await pages[0].getByRole("region", { name: "Found in messages" }).getByText("Our marketing campaign", { exact: false }).first().waitFor();
  await pages[0].waitForTimeout(1000);
  assert.equal(requests.length - before, 2, "one request per visible tab and no hidden-tab request");
  await pages[0].waitForTimeout(1500);
  assert.equal(requests.length - before, 2, "no search polling");
  latencies.sort((a, b) => a - b);
  console.log(`Passed: sidebar desktop/mobile exact older-message focus, five distinct Chats, highlighting, name-result preservation, seeded global search, 429/hidden-panel cancellation, and three-tab request bounds; store query p95 ${latencies[Math.floor(latencies.length * .95)].toFixed(1)} ms over ${latencies.length} measured queries.`);
} catch (error) {
  console.error("Search fixture requests:", requests);
  if (lastPage) console.error((await lastPage.locator("body").innerText()).slice(0, 2000));
  throw error;
} finally { await browser?.close(); server?.close(); store.close(); await rm(output, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); }
