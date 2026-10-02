import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";
import { AgentStore, WorkspaceStore } from "../../../packages/agents/dist/index.js";
import Fastify from "../../server/node_modules/fastify/fastify.js";
import { registerNotificationListRoute } from "../../server/dist/routes/notifications.js";

const baseline = process.env.PONDEROSA_EXPECT_FOLDER_BADGE_MISSING === "1";
const expectLinkedExpansion = process.env.PONDEROSA_EXPECT_LINKED_FOLDER_EXPANSION === "1";
const browserType = process.env.PONDEROSA_BROWSER_TYPE ?? "chromium";
const { [browserType]: engine } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const web = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "chat-folder-notifications-"));
const output = path.join(temporary, "web"), data = path.join(temporary, "data");
const store = new AgentStore(data), workspace = new WorkspaceStore(data);
const project = store.createProject({ label: "Disposable", hostPath: temporary, defaultEngine: "codex" });
const chats = Array.from({ length: 32 }, (_, i) => store.createConversation(project.id, { title: ["Newleaf", "Glance", "ZindyCast"][i] ?? `Chat ${i}` }));
const preferences = { ...workspace.getPreferences(), chatFolders: [
  { id: "apps", name: "Apps", expanded: true, conversationIds: chats.slice(0, 3).map(chat => chat.id) },
  { id: "later", name: "Later", expanded: false, conversationIds: [chats[28].id, chats[29].id] },
  { id: "shared", name: "Shared", expanded: false, conversationIds: [chats[30].id, chats[31].id] },
] };
const add = input => workspace.createNotification({ projectId: project.id, title: "Disposable notice", body: "Test", ...input });
let direct = add({ conversationId: chats[0].id, kind: "direct_responses" });
const ordinary = add({ conversationId: chats[28].id, kind: "broadcasts" });
let action = add({ conversationId: chats[29].id, kind: "operational", severity: "urgent" });
add({ conversationIds: [chats[30].id, chats[31].id], kind: "everyone" });
add({ conversationIds: [chats[30].id], kind: "operational", severity: "urgent" }); // Navigation, not Chat ownership.
let app, server, browser;
const requests = [];
let projectionRequestsActive = 0, maximumActive = 0, failProjection = false;
try {
  app = Fastify();
  registerNotificationListRoute(app, { workspace, store, publishWorkspaceSince: () => {} });
  await app.ready();
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { transformImport: [], entry: { index: path.join(web, "test/chat-folder-notifications-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createHttpServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const json = value => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
    if (url.pathname === "/api/fixture") return json({ projects: [project], chats, preferences });
    if (url.pathname === "/api/notifications/projection") {
      let body = ""; for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      maximumActive = Math.max(maximumActive, ++projectionRequestsActive);
      await new Promise(resolve => setTimeout(resolve, request.headers.referer?.includes("slow=1") ? 600 : 180));
      projectionRequestsActive--;
      if (failProjection) { response.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"Disposable outage"}'); return; }
      const result = await app.inject({ method: "POST", url: url.pathname, payload: JSON.parse(body) });
      response.writeHead(result.statusCode, { "Content-Type": "application/json" }).end(result.body); return;
    }
    if (url.pathname.startsWith("/api/fixture-action/")) {
      const name = url.pathname.split("/").at(-1);
      if (name === "read") workspace.readNotification(direct.id);
      if (name === "dismiss") workspace.setNotificationStatus(action.id, "dismissed");
      if (name === "new") direct = add({ conversationId: chats[0].id, kind: "direct_responses" });
      if (name === "fail") failProjection = true;
      if (name === "recover") failProjection = false;
      return json({ ok: true });
    }
    try {
      const file = path.resolve(output, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await engine.launch({ headless: true, ...(browserType === "chromium" ? { executablePath: process.env.PONDEROSA_CHROMIUM_PATH } : {}) });
  if (expectLinkedExpansion) {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/?independent`);
    const copies = page.getByRole("button", { name: "Folder Apps", exact: true });
    await copies.nth(1).waitFor();
    assert.equal(await copies.nth(0).getAttribute("aria-expanded"), "true");
    assert.equal(await copies.nth(1).getAttribute("aria-expanded"), "true");
    await copies.nth(0).click();
    assert.equal(await copies.nth(0).getAttribute("aria-expanded"), "false");
    assert.equal(await copies.nth(1).getAttribute("aria-expanded"), "false");
    console.log("REPRODUCED: collapsing Starred also collapses the All Chats folder");
    await page.close();
  } else {
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/?independent`);
      const root = section => page.locator(`[data-chat-folder="apps"][data-folder-section="${section}"]`);
      const folder = section => root(section).getByRole("button", { name: /^Folder / });
      const expanded = async (starred, all) => {
        assert.equal(await folder("starred").getAttribute("aria-expanded"), String(starred));
        assert.equal(await folder("all").getAttribute("aria-expanded"), String(all));
        assert.equal(await root("starred").getByRole("button", { name: "Open Chat Newleaf", exact: true }).count(), Number(starred));
        assert.equal(await root("all").getByRole("button", { name: "Open Chat Newleaf", exact: true }).count(), Number(all));
      };
      const badge = section => folder(section).getByRole("img", { name: "1 important unread", exact: true });
      await badge("all").waitFor();
      await expanded(true, true);
      const countRequests = requests.length;
      // All Chats changes first: the Starred legacy seed must already be saved.
      await folder("all").click();
      await expanded(true, false);
      await page.reload();
      await badge("all").waitFor();
      await expanded(true, false);
      const writes = await page.locator("[data-preference-writes]").getAttribute("data-preference-writes");
      await folder("starred").focus(); await folder("starred").press("Enter");
      await expanded(false, false);
      await folder("all").click();
      await expanded(false, true);
      const afterAll = await page.locator("[data-preference-writes]").getAttribute("data-preference-writes");
      assert.equal(Number(afterAll), Number(writes) + 1);
      await folder("starred").click(); await folder("starred").click();
      assert.equal(await page.locator("[data-preference-writes]").getAttribute("data-preference-writes"), afterAll,
        "Starred expansion is display-only and does not write canonical workspace preferences");
      await page.getByRole("button", { name: "Remount sidebar", exact: true }).click();
      await badge("all").waitFor();
      await expanded(false, true);
      await page.reload(); await badge("all").waitFor();
      await expanded(false, true);
      const search = page.getByRole("textbox", { name: "Search chats", exact: true });
      await search.fill("Newleaf");
      await root("starred").getByRole("button", { name: "Open Chat Newleaf", exact: true }).waitFor();
      await expanded(true, true);
      await search.fill("");
      await page.getByRole("button", { name: "Folder Later", exact: true }).waitFor();
      await expanded(false, true);
      await root("all").getByRole("button", { name: "Unstar folder Apps", exact: true }).click();
      await root("starred").waitFor({ state: "hidden" });
      await root("all").getByRole("button", { name: "Star folder Apps", exact: true }).click();
      await expanded(false, true);
      // Rename uses the same stable folder ID, not a new expansion preference.
      await folder("all").focus(); await folder("all").press("Shift+F10");
      await page.getByRole("menuitem", { name: "Rename Folder", exact: true }).click();
      await page.getByRole("textbox", { name: "Folder name", exact: true }).fill("Renamed Apps");
      await page.getByRole("dialog", { name: "Rename Folder", exact: true }).getByRole("button", { name: "Rename", exact: true }).click();
      await expanded(false, true);
      assert.equal(await page.getByRole("button", { name: "Folder Renamed Apps", exact: true }).count(), 2);
      await badge("starred").waitFor(); await badge("all").waitFor();
      await page.getByRole("button", { name: "Read Newleaf", exact: true }).click();
      await badge("starred").waitFor({ state: "hidden" }); await badge("all").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "New notification", exact: true }).click();
      await badge("starred").waitFor(); await badge("all").waitFor();
      await expanded(false, true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(tmpdir(), `chat-folder-independent-${browserType}-${width}.png`) });
      assert.deepEqual(errors, []);
      assert(requests.length > countRequests, "reload/read changes still use the existing notification projection");
      await page.close();
      console.log(`PASS ${browserType} ${width}: independent Starred/All Chats expansion, legacy seed, reload/remount, search, rename, re-star, keyboard and shared unread counts`);
    }
    const denied = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await denied.addInitScript(() => { Object.defineProperty(window, "localStorage", { configurable: true,
      get() { throw new DOMException("Disposable denied storage", "SecurityError"); } }); });
    await denied.goto(`http://127.0.0.1:${server.address().port}/?independent`);
    const starred = denied.locator('[data-chat-folder="apps"][data-folder-section="starred"]').getByRole("button", { name: "Folder Apps", exact: true });
    const all = denied.locator('[data-chat-folder="apps"][data-folder-section="all"]').getByRole("button", { name: "Folder Apps", exact: true });
    await starred.waitFor(); await starred.click();
    assert.equal(await starred.getAttribute("aria-expanded"), "false");
    assert.equal(await all.getAttribute("aria-expanded"), "true");
    await denied.getByRole("button", { name: "Remount sidebar", exact: true }).click();
    assert.equal(await starred.getAttribute("aria-expanded"), "false");
    assert.equal(await all.getAttribute("aria-expanded"), "true");
    await denied.close();
    console.log(`PASS ${browserType}: denied device storage retains independent expansion in memory`);
  }
  for (const width of [320, 390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => { window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }; });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const folder = name => page.getByRole("button", { name: `Folder ${name}`, exact: true });
    const important = name => folder(name).getByRole("img", { name: "1 important unread", exact: true });
    const newleaf = page.locator(`[data-resource-id="sidebar-conversation:${chats[0].id}"]`);
    await newleaf.getByLabel("1 important unread", { exact: true }).waitFor();
    await folder("Apps").click();
    assert.equal(await page.getByRole("button", { name: "Open Chat Newleaf", exact: true }).count(), 0);
    if (baseline) {
      assert.equal(await folder("Apps").getByLabel("1 important unread", { exact: true }).count(), 0);
      console.log(`REPRODUCED ${width}: Newleaf has an unread notification, collapsed Apps has none`);
    } else {
      await important("Apps").waitFor();
      assert.equal(await folder("Apps").getAttribute("aria-description"), "1 important unread; 0 ordinary unread");
      await important("Later").waitFor();
      await folder("Later").getByRole("img", { name: "1 ordinary unread", exact: true }).waitFor();
      await important("Shared").waitFor();
      await page.screenshot({ path: path.join(tmpdir(), `chat-folder-collapsed-${browserType}-${width}.png`) });
      assert.equal(await page.getByRole("button", { name: "Open Chat Chat 28", exact: true }).count(), 0, "unloaded members still contribute");
      await folder("Apps").hover();
      assert.equal(await important("Apps").evaluate(node => getComputedStyle(node).opacity), "1");
      await folder("Apps").focus(); await folder("Apps").press("Enter");
      await newleaf.getByRole("img", { name: "1 important unread", exact: true }).waitFor();
      await important("Apps").waitFor();
      await page.getByRole("button", { name: "Read Newleaf", exact: true }).click();
      await important("Apps").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Dismiss action", exact: true }).click();
      await important("Later").waitFor({ state: "hidden" });
      await folder("Later").getByRole("img", { name: "1 ordinary unread", exact: true }).waitFor();
      await page.getByRole("button", { name: "New notification", exact: true }).click();
      await important("Apps").waitFor();
      await page.getByRole("button", { name: "Move Newleaf", exact: true }).click();
      await important("Apps").waitFor({ state: "hidden" });
      await important("Later").waitFor();
      const input = page.getByRole("textbox", { name: "Search chats", exact: true });
      await input.fill("Newleaf");
      await page.getByRole("button", { name: "Folder Apps", exact: true }).waitFor({ state: "hidden" });
      await important("Later").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(tmpdir(), `chat-folder-notifications-${browserType}-${width}.png`) });
      // Restore disposable state for the next width.
      workspace.setNotificationStatus(direct.id, "dismissed");
      direct = add({ conversationId: chats[0].id, kind: "direct_responses" });
      action = add({ conversationId: chats[29].id, kind: "operational", severity: "urgent" });
      assert.equal(workspace.getNotification(ordinary.id).readAt, undefined);
      console.log(`PASS ${browserType} ${width}: collapsed/expanded, unloaded members, dedupe, read/dismiss, move, search and layout`);
    }
    assert.deepEqual(errors, []); await page.close();
  }
  if (!baseline) {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.addInitScript(() => { window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }; });
    const before = requests.length;
    await page.goto(`http://127.0.0.1:${server.address().port}/?capacity`);
    const lastFolder = page.getByRole("button", { name: "Folder Capacity 400", exact: true });
    await lastFolder.getByRole("img", { name: "1 important unread", exact: true }).waitFor();
    assert.equal(requests.length - before, 3, "401 folders use three bounded projection pages, not 401 Chat collectors");
    assert(maximumActive <= 2, "at most two projection requests in flight");
    await lastFolder.click();
    await page.waitForTimeout(250);
    assert.equal(requests.length - before, 3, "expanding a folder does not refetch counts");
    await page.close();
    const slow = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await slow.goto(`http://127.0.0.1:${server.address().port}/?slow=1`);
    const loadingFolder = slow.getByRole("button", { name: "Folder Apps", exact: true });
    await loadingFolder.getByRole("img", { name: "Folder notifications loading", exact: true }).waitFor();
    assert.equal(await loadingFolder.getAttribute("aria-description"), "Folder notifications loading");
    await loadingFolder.getByRole("img", { name: "1 important unread", exact: true }).waitFor();
    await slow.close();
    await fetch(`http://127.0.0.1:${server.address().port}/api/fixture-action/fail`, { method: "POST" });
    const failed = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await failed.goto(`http://127.0.0.1:${server.address().port}`);
    await failed.getByRole("button", { name: "Folder Apps", exact: true }).getByRole("img", { name: "Folder notifications unavailable", exact: true }).waitFor();
    assert.equal(await failed.getByRole("button", { name: "Folder Apps", exact: true }).getByRole("img", { name: /important unread/ }).count(), 0, "failed initial query is unknown, not a zero count");
    await failed.close();
    const failStart = requests.length;
    const failedCapacity = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await failedCapacity.goto(`http://127.0.0.1:${server.address().port}/?capacity`);
    await failedCapacity.getByRole("button", { name: "Folder Capacity 400", exact: true }).getByRole("img", { name: "Folder notifications unavailable", exact: true }).waitFor();
    await failedCapacity.waitForTimeout(250);
    assert.equal(requests.length - failStart, 2, "a failed batch stops the third page, rather than creating more failing requests");
    await failedCapacity.close();
    assert(requests.every(request => (request.chatFolders?.length ?? 0) <= 200 && request.conversationIds.length <= 200));
    console.log(`PASS ${browserType}: 401-folder batching, two-request concurrency, collapse cache, loading and bounded query failure`);
  }
} finally { await browser?.close(); await new Promise(resolve => server?.close(resolve) ?? resolve()); await app?.close(); store.close(); await rm(temporary, { recursive: true, force: true }); }
