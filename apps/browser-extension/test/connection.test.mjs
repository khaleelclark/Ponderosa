import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applicationUrl, serverOrigin } from "../dist/policy.js";

test("only HTTPS application pages and explicit server origins can be connected", () => {
  for (const url of ["http://example.test", "https://user:secret@example.test", "https://accounts.google.com/", "https://example.test/oauth/callback", "https://example.test/login", "https://example.test/sign-in"]) assert.throws(() => applicationUrl(url));
  assert.equal(applicationUrl("https://example.test/application/42").origin, "https://example.test");
  assert.equal(serverOrigin("https://example.test:20443/"), "https://example.test:20443");
  for (const url of ["http://example.test", "https://example.test/path", "https://example.test/?token=secret"]) assert.throws(() => serverOrigin(url));
});

// Real Chromium DOM/input/capture, with Chrome's extension transport mocked.
// Physical installation and permission prompts remain a separate qualification.
test("local window connector manages tabs, isolates other windows, pauses on auth and disconnects on transport loss", { skip: !process.env.PONDEROSA_PLAYWRIGHT_PATH }, async () => {
  const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
  const { LocalBrowserHub } = await import("../../server/dist/local-browser-hub.js");
  const browser = await chromium.launch({ executablePath: process.env.PONDEROSA_CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
  await context.route("https://application.test/**", route => route.fulfill({ contentType: "text/html", body: '<title>Application</title><label>Name<input id="name"></label><button id="save">Save</button><p id="output"></p><script>document.querySelector("#save").onclick=()=>document.querySelector("#output").textContent=document.querySelector("#name").value</script>' }));
  const page = await context.newPage();
  await page.goto("https://application.test/form");
  const cdp = await context.newCDPSession(page);
  const hub = new LocalBrowserHub();
  const listeners = {};
  let attached = false, badge = "", storage = {}, transportFailure = false;
  const attachedIds = new Set();
  const tabs = new Map([[7, { page, cdp, windowId: 1 }]]);
  let activeId = 7, nextId = 8;
  const tabInfo = id => { const tab = tabs.get(id); if (!tab) throw new Error("No tab"); return { id, windowId: tab.windowId, url: tab.page.url(), title: "Application", active: id === activeId }; };
  const oldFetch = globalThis.fetch, oldChrome = globalThis.chrome;
  const calls = [];
  const extensionId = "a".repeat(32);
  globalThis.chrome = {
    runtime: { id: extensionId, onMessage: { addListener: fn => { listeners.message = fn; } } },
    debugger: {
      attach: async ({ tabId }) => { assert.equal(tabs.get(tabId).windowId, 1); assert.equal(attachedIds.has(tabId), false); attachedIds.add(tabId); attached = true; },
      detach: async ({ tabId }) => { attachedIds.delete(tabId); attached = attachedIds.size > 0; },
      sendCommand: async ({ tabId }, method, args) => { assert.equal(tabs.get(tabId).windowId, 1); assert.equal(attachedIds.has(tabId), true); calls.push(method); return tabs.get(tabId).cdp.send(method, args); },
      onDetach: { addListener: fn => { listeners.detach = fn; } },
    },
    tabs: {
      query: async query => query.active ? [tabInfo(activeId)] : [...tabs.keys()].filter(id => tabs.get(id).windowId === query.windowId).map(tabInfo),
      get: async id => tabInfo(id),
      create: async options => { assert.equal(options.windowId, 1); const created = await context.newPage(); await created.goto(options.url); const id = nextId++; tabs.set(id, { page: created, cdp: await context.newCDPSession(created), windowId: 1 }); activeId = id; return tabInfo(id); },
      update: async id => { assert.equal(tabs.get(id).windowId, 1); activeId = id; return tabInfo(id); },
      remove: async id => { await tabs.get(id).page.close(); tabs.delete(id); listeners.removed(id); },
      onUpdated: { addListener: fn => { listeners.updated = fn; } }, onRemoved: { addListener: fn => { listeners.removed = fn; } }, onDetached: { addListener: fn => { listeners.moved = fn; } },
    },
    windows: { onRemoved: { addListener: fn => { listeners.windowRemoved = fn; } } },
    storage: { session: { get: async () => storage, set: async value => { storage = value; }, remove: async () => { storage = {}; } } },
    action: { setBadgeText: async ({ text }) => { badge = text; }, setBadgeBackgroundColor: async () => {} },
  };
  globalThis.fetch = async (raw, options) => {
    if (transportFailure) throw new Error("Network lost");
    const url = new URL(raw), body = JSON.parse(options.body), token = options.headers.Authorization?.slice(7);
    assert.equal(url.origin, "https://ponderosa.test");
    assert.equal(options.credentials, "omit");
    let result;
    try {
      if (url.pathname.endsWith("/claim")) result = hub.claim(body.code, body);
      else {
        const [, id, action] = /connections\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (action === "poll") result = await hub.poll(id, token);
        else if (action === "result") { hub.result(id, token, body.id, body.value, body.failed); result = { ok: true }; }
        else if (action === "state") { hub.state(id, token, body.paused, body.epoch); result = { ok: true }; }
        else { hub.detached(id, token); result = { ok: true }; }
      }
      return { ok: true, json: async () => result };
    } catch { return { ok: false }; }
  };
  const popup = message => new Promise(resolve => assert.equal(listeners.message(message, { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` }, resolve), true));
  const until = async condition => { for (let i = 0; i < 200; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail("condition did not settle"); };
  const connect = async () => {
    const pair = hub.pairing("chat");
    const response = await popup({ action: "connect", server: "https://ponderosa.test", code: pair.code });
    assert.equal(response.error, undefined);
    assert.equal(response.connected, true);
    const grant = hub.list("chat").find(item => item.connected && !item.claimed);
    return hub.factory("chat", grant.id)("session", () => {});
  };
  try {
    await import(`../dist/worker.js?test=${Date.now()}`);
    assert.equal(listeners.message({ action: "connect" }, { id: "foreign", url: "https://evil.test" }, () => assert.fail()), false);
    let driver = await connect();
    assert.equal(badge, "ON");
    await driver.fill("#name", "Kyle Test");
    await driver.click("#save");
    assert.equal(await page.locator("#output").textContent(), "Kyle Test");
    assert.match(await driver.inspect(), /Kyle Test/);
    const frame = await driver.capture();
    assert.ok(frame.readUInt32BE(16) >= 800);
    assert.deepEqual(driver.viewport(), { width: 800, height: 600 }, "DPR must not change click coordinates");
    assert.equal(calls.includes("Page.bringToFront"), false, "watching must not steal local focus");
    assert.equal((await driver.pages()).pages.length, 1);
    const uploadDir = await mkdtemp(join(tmpdir(), "local-upload-"));
    try {
      const body = Buffer.from("%PDF-1.7\nResume test\n%%EOF");
      const stagedPath = join(uploadDir, "resume.pdf");
      await writeFile(stagedPath, body);
      await page.evaluate(() => { const input = document.createElement("input"); input.type = "file"; input.id = "resume"; input.accept = ".pdf"; document.body.append(input); input.onchange = () => document.body.dataset.uploadChanged = "yes"; });
      const result = await driver.upload({ uploadId: "resume-test", stagedPath, expectedName: "resume.pdf", expectedSize: body.length, expectedMediaType: "application/pdf", selector: "#resume" });
      assert.equal(result.pageId, "7");
      assert.deepEqual(result.input, { name: "resume.pdf", size: body.length, type: "application/pdf", count: 1 });
      assert.equal(await page.evaluate(() => document.body.dataset.uploadChanged), "yes");
      assert.equal(await page.evaluate(() => document.querySelector("#resume").files[0].text()), body.toString());
      await driver.clearUploadedFiles("7", "resume-test");
      assert.equal(await page.evaluate(() => document.querySelector("#resume").files.length), 0);
      const { upload } = await import("../dist/uploads.js");
      const args = { uploadId: "negative-test", selector: "#resume", name: "resume.pdf", size: body.length, type: "application/pdf", base64: body.toString("base64") };
      const send = (method, params) => cdp.send(method, params);
      await assert.rejects(upload(send, "7", { ...args, size: 11 * 1024 * 1024 }), /Invalid managed upload/);
      await assert.rejects(upload(send, "7", { ...args, name: "../resume.pdf" }), /Invalid managed upload/);
      await assert.rejects(upload(send, "7", { ...args, size: body.length + 1 }), /size mismatch/);
      await assert.rejects(upload(send, "7", { ...args, selector: "#name" }), /attachment failed/);
      await page.locator("#resume").evaluate(input => input.accept = ".docx");
      await assert.rejects(upload(send, "7", args), /attachment failed/);
      await page.locator("#resume").evaluate(input => { input.accept = ".pdf"; input.disabled = true; });
      await assert.rejects(upload(send, "7", args), /attachment failed/);
      assert.equal(await page.evaluate(() => document.querySelector("#resume").files.length), 0, "rejected uploads attach nothing");
      await page.locator("#resume").evaluate(input => input.remove());
    } finally { await rm(uploadDir, { recursive: true, force: true }); }
    const opened = await driver.newPage();
    const second = opened.activePageId;
    await driver.navigate("https://application.test/second");
    await driver.fill("#name", "Second tab");
    await driver.capture("7");
    assert.equal((await driver.pages()).activePageId, second, "watching another tab does not retarget agent actions");
    await driver.activatePage("7");
    assert.equal(await page.locator("#name").inputValue(), "Kyle Test");
    // A moved tab is removed from the grant and detached; another window is never queried or driven.
    tabs.get(Number(second)).windowId = 2;
    listeners.moved(Number(second), { oldWindowId: 1 });
    await until(() => !attachedIds.has(Number(second)));
    assert.equal((await driver.pages()).pages.length, 1);
    await assert.rejects(driver.capture(second), /no longer in/);
    const third = await driver.newPage();
    await driver.closePage(third.activePageId);
    assert.equal((await driver.pages()).activePageId, "7");
    await driver.newPage();
    await driver.navigate("https://application.test/fourth");
    await driver.activatePage("7");
    assert.equal(attachedIds.size, 2, "more than one tab can be attached within the grant");
    activeId = 7;
    await driver.close();
    await until(() => badge === "");
    assert.equal(attached, false);
    assert.equal(driver.isAlive(), false);

    driver = await connect();
    await assert.rejects(driver.activatePage(second), /could not perform/);
    await until(() => !attached && badge === "");
    assert.equal(driver.isAlive(), false, "foreign-window target revokes the connection without executing there");
    await driver.close();

    driver = await connect();
    await page.evaluate(() => { const input = document.createElement("input"); input.type = "password"; input.value = "never-expose-this"; document.body.append(input); });
    const pairedId = storage.connection.id;
    await assert.rejects(driver.inspect(), /paused/);
    await until(() => !attached && badge === "II");
    assert.equal(driver.isAlive(), true);
    assert.equal(driver.paused(), true);
    const before = calls.length;
    await assert.rejects(driver.fill("#name", "must not run"), /paused/);
    await assert.rejects(driver.capture(), /paused/);
    assert.equal(calls.length, before, "no page commands or screenshots during manual sign-in");
    await page.reload();
    const resumed = await popup({ action: "resume" });
    assert.equal(resumed.error, undefined);
    assert.equal(storage.connection.id, pairedId, "resume keeps the original pairing");
    await driver.fill("#name", "Resumed");
    assert.equal(await page.locator("#name").inputValue(), "Resumed");
    await driver.close();
    await page.reload();

    driver = await connect();
    listeners.updated(7, { url: "https://accounts.google.com/signin" });
    await until(() => !attached && badge === "II");
    assert.equal(driver.isAlive(), true);
    assert.equal(driver.paused(), true);
    await driver.close();
    await until(() => badge === "");

    await page.goto("https://application.test/login");
    driver = await connect();
    assert.equal(driver.paused(), true, "pairing works directly on a sign-in page");
    assert.equal(attached, false, "sign-in pairing never attaches the debugger");
    assert.equal((await driver.pages()).pages[0].title, "Local browser paused");
    await page.goto("https://application.test/form");
    assert.equal((await popup({ action: "resume" })).error, undefined);
    assert.equal(driver.paused(), false);
    assert.equal((await popup({ action: "pause" })).paused, true);
    assert.equal(attached, false);
    assert.equal((await popup({ action: "resume" })).paused, false);
    await driver.close();
    await until(() => badge === "");

    driver = await connect();
    const lastConnection = { ...storage.connection };
    transportFailure = true;
    // Wake its already-started poll; the command executes once, failed transport
    // then revokes local authority instead of retrying the command.
    const pending = assert.rejects(driver.pageInfo(), /disconnected/);
    await until(() => !attached && badge === "");
    transportFailure = false;
    // A lost acknowledgement must not be reported as confirmed server cleanup.
    assert.equal(driver.isAlive(), true);
    hub.detached(lastConnection.id, lastConnection.token);
    await pending;
  } finally {
    transportFailure = false;
    await popup({ action: "disconnect" });
    globalThis.fetch = oldFetch; globalThis.chrome = oldChrome;
    await browser.close();
  }
});
