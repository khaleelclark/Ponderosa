import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserSessionManager } from "../dist/browser-session-manager.js";
import { findBrowserExecutable, playwrightBrowserDriverFactory } from "../dist/chrome-cdp-driver.js";
import { BrowserServiceClient, startBrowserService } from "../dist/browser-service.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("a slow navigation does not hold the current live frame behind DOM readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-navigation-preview-"));
  const scope = { projectId: "preview-project", agentId: "preview-agent", runId: "preview-run" };
  const entered = deferred();
  const release = deferred();
  let alive = true;
  let captures = 0;
  const manager = new BrowserSessionManager(root, async () => ({
    isAlive: () => alive,
    close: async () => { alive = false; release.resolve(); },
    pages: async () => ({ activePageId: "page", pages: [{ pageId: "page", url: "about:blank", title: "Initial", active: true }] }),
    navigate: async () => { entered.resolve(); await release.promise; return { url: "https://example.test/slow", title: "Loaded" }; },
    capture: async () => { captures++; return Buffer.from("current pixels"); },
  }), () => {});
  try {
    await manager.open(scope, undefined, "operator");
    const navigation = manager.navigate(scope, "https://example.test/slow", "operator");
    await entered.promise;
    const frame = await Promise.race([
      manager.captureFrame(scope, "page"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("live frame waited for navigation")), 500)),
    ]);
    assert.equal(frame.body.toString(), "current pixels");
    assert.equal(captures, 1);
    release.resolve();
    assert.equal((await navigation).url, "https://example.test/slow");
  } finally {
    release.resolve();
    await manager.closeAll("test complete");
    await rm(root, { recursive: true, force: true });
  }
});

test("a live frame captured during navigation cannot publish after closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-navigation-close-"));
  const scope = { projectId: "preview-project", agentId: "preview-agent", runId: "preview-run" };
  const entered = deferred();
  const releaseNavigation = deferred();
  const enteredCapture = deferred();
  const releaseCapture = deferred();
  let alive = true;
  const manager = new BrowserSessionManager(root, async () => ({
    isAlive: () => alive,
    close: async () => { alive = false; releaseNavigation.resolve(); },
    pages: async () => ({ activePageId: "page", pages: [{ pageId: "page", url: "about:blank", title: "Initial", active: true }] }),
    navigate: async () => { entered.resolve(); await releaseNavigation.promise; return { url: "https://example.test/slow", title: "Loaded" }; },
    capture: async () => { enteredCapture.resolve(); await releaseCapture.promise; return Buffer.from("stale pixels"); },
  }), () => {});
  try {
    await manager.open(scope, undefined, "operator");
    const navigation = manager.navigate(scope, "https://example.test/slow", "operator");
    void navigation.catch(() => undefined);
    await entered.promise;
    const frame = manager.captureFrame(scope, "page");
    void frame.catch(() => undefined);
    await enteredCapture.promise;
    await manager.close(scope);
    releaseCapture.resolve();
    await assert.rejects(frame, /browser session changed/);
    await assert.rejects(navigation, /browser session changed/);
  } finally {
    releaseNavigation.resolve();
    releaseCapture.resolve();
    await manager.closeAll("test complete");
    await rm(root, { recursive: true, force: true });
  }
});

test("a frame racing navigation settlement is recaptured instead of publishing old pixels", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-navigation-revision-"));
  const scope = { projectId: "preview-project", agentId: "preview-agent", runId: "preview-run" };
  const enteredNavigation = deferred();
  const releaseNavigation = deferred();
  const enteredCapture = deferred();
  const releaseCapture = deferred();
  let captures = 0;
  const manager = new BrowserSessionManager(root, async () => ({
    isAlive: () => true,
    close: async () => { releaseNavigation.resolve(); releaseCapture.resolve(); },
    pages: async () => ({ activePageId: "page", pages: [{ pageId: "page", url: "about:blank", title: "Initial", active: true }] }),
    navigate: async () => { enteredNavigation.resolve(); await releaseNavigation.promise; return { url: "https://example.test/slow", title: "Loaded" }; },
    capture: async () => {
      captures++;
      if (captures === 1) { enteredCapture.resolve(); await releaseCapture.promise; }
      return Buffer.from(captures === 1 ? "old pixels" : "new pixels");
    },
  }), () => {});
  try {
    await manager.open(scope, undefined, "operator");
    const navigation = manager.navigate(scope, "https://example.test/slow", "operator");
    await enteredNavigation.promise;
    const frame = manager.captureFrame(scope, "page");
    await enteredCapture.promise;
    releaseNavigation.resolve();
    await navigation;
    releaseCapture.resolve();
    assert.equal((await frame).body.toString(), "new pixels");
    assert.equal(captures, 2);
  } finally {
    releaseNavigation.resolve();
    releaseCapture.resolve();
    await manager.closeAll("test complete");
    await rm(root, { recursive: true, force: true });
  }
});

test("the real Chrome preview paints while a page defers DOMContentLoaded", { skip: !findBrowserExecutable() }, async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-navigation-real-"));
  const scope = { projectId: "preview-project", agentId: "preview-agent", runId: "preview-run" };
  const scriptRequested = deferred();
  const releaseScript = deferred();
  const server = createServer((request, response) => {
    if (request.url === "/slow.js") {
      scriptRequested.resolve();
      void releaseScript.promise.then(() => { response.setHeader("content-type", "application/javascript"); response.end(""); });
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end('<title>Slow page</title><main>Visible before load</main><script defer src="/slow.js"></script>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const manager = new BrowserSessionManager(root, playwrightBrowserDriverFactory(root), () => {});
  try {
    const opened = await manager.open(scope, undefined, "operator");
    const navigation = manager.navigate(scope, `http://127.0.0.1:${server.address().port}/`, "operator");
    void navigation.catch(() => undefined);
    await scriptRequested.promise;
    const frame = await Promise.race([
      manager.captureFrame(scope, opened.activePageId),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Chrome preview waited for DOMContentLoaded")), 2_000)),
    ]);
    assert.equal(frame.body.subarray(1, 4).toString(), "PNG");
    releaseScript.resolve();
    assert.equal((await navigation).title, "Slow page");
  } finally {
    releaseScript.resolve();
    await manager.closeAll("test complete");
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("a shared Project browser delivers a frame through the broker during slow navigation", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-navigation-service-"));
  const scope = { projectId: "preview-project", agentId: "project-browser:preview-project", runId: "project:preview-project" };
  const entered = deferred();
  const release = deferred();
  let alive = true;
  const service = await startBrowserService(join(root, "browser.sock"), root, async () => ({
    isAlive: () => alive,
    manualState: () => "automation",
    close: async () => { alive = false; release.resolve(); },
    pages: async () => ({ activePageId: "page", pages: [{ pageId: "page", url: "about:blank", title: "Initial", active: true }] }),
    navigate: async () => { entered.resolve(); await release.promise; return { url: "https://example.test/slow", title: "Loaded" }; },
    capture: async () => Buffer.from("shared pixels"),
  }));
  const client = new BrowserServiceClient(join(root, "browser.sock"));
  await client.claim();
  const manager = new BrowserSessionManager(root, (id, _console, _spawned, event, launch) => client.driver(id, event, launch), () => {}, undefined, undefined, () => true, true);
  try {
    await manager.open(scope, undefined, "operator", undefined, true);
    const navigation = manager.navigate(scope, "https://example.test/slow", "operator");
    void navigation.catch(() => undefined);
    await entered.promise;
    const frame = await Promise.race([
      manager.captureFrame(scope, "page"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("broker preview waited for navigation")), 500)),
    ]);
    assert.equal(frame.body.toString(), "shared pixels");
    release.resolve();
    assert.equal((await navigation).url, "https://example.test/slow");
  } finally {
    release.resolve();
    await manager.close(scope).catch(() => undefined);
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a preview racing a broker lease change cannot return under the old app", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-navigation-lease-"));
  const socket = join(root, "browser.sock");
  const enteredNavigation = deferred();
  const releaseNavigation = deferred();
  const enteredCapture = deferred();
  const releaseCapture = deferred();
  const page = { pageId: "page", url: "about:blank", title: "Initial", active: true };
  const service = await startBrowserService(socket, root, async () => ({
    isAlive: () => true,
    manualState: () => "automation",
    close: async () => { releaseNavigation.resolve(); releaseCapture.resolve(); },
    pages: async () => ({ activePageId: "page", pages: [page] }),
    navigate: async () => { enteredNavigation.resolve(); await releaseNavigation.promise; return page; },
    capture: async () => { enteredCapture.resolve(); await releaseCapture.promise; return Buffer.from("old lease pixels"); },
  }));
  try {
    const first = new BrowserServiceClient(socket);
    await first.claim();
    const id = "11111111-1111-4111-8111-111111111111";
    const driver = await first.driver(id, undefined, { nativeManual: true });
    const navigation = driver.navigate("https://example.test/slow");
    const rejectedNavigation = assert.rejects(navigation, /authority changed|lease expired/);
    await enteredNavigation.promise;
    const capture = driver.capture("page");
    const rejectedCapture = assert.rejects(capture, /authority changed|lease expired/);
    await enteredCapture.promise;
    const replacement = new BrowserServiceClient(socket);
    const claim = replacement.claim();
    let fenced = false;
    for (let attempt = 0; attempt < 100 && !fenced; attempt++) {
      try { await driver.suspend(true); }
      catch (error) {
        if (!/lease expired/.test(String(error))) throw error;
        fenced = true;
      }
      if (!fenced) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(fenced, true, "the replacement claimed the lease before the old work settled");
    releaseNavigation.resolve();
    assert.deepEqual(await claim, [id]);
    releaseCapture.resolve();
    await rejectedNavigation;
    await rejectedCapture;
    const adopted = await replacement.driver(id, undefined, undefined, true);
    assert.equal((await adopted.pages()).activePageId, "page");
    await adopted.close();
  } finally {
    releaseNavigation.resolve();
    releaseCapture.resolve();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
