import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { LocalBrowserHub } from "../dist/local-browser-hub.js";
import { registerLocalBrowserRoutes } from "../dist/routes/local-browsers.js";
import { registerRequestSecurityHooks } from "../dist/server-request-hooks.js";
import { BrowserSessionManager } from "../dist/browser-session-manager.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("local connection reuses session control fences and closes without launching hosted Chrome", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-browser-manager-"));
  const hub = new LocalBrowserHub();
  const { token, connection } = hub.claim(hub.pairing("chat").code, { url: "https://example.test/form", title: "Application" });
  const scope = { projectId: "chat", agentId: "chat-browser", runId: "chat-session" };
  const manager = new BrowserSessionManager(root, async () => { throw new Error("Hosted Chrome must not launch"); }, () => {});
  const transport = (async () => {
    while (true) {
      const command = await hub.poll(connection.id, token);
      if (!command) continue;
      if (command.action === "disconnect") { hub.detached(connection.id, token); return; }
      assert.equal(command.action, "pages");
      hub.result(connection.id, token, command.id, { activePageId: "7", pages: [{ pageId: "7", url: "https://example.test/form", title: "Application" }] }, false);
    }
  })();
  try {
    const session = await manager.open(scope, undefined, "operator", hub.factory("chat", connection.id));
    assert.equal(session.location, "local");
    assert.equal(session.controlOwner, "operator");
    assert.equal(session.capabilities.fileUpload, true);
    assert.equal(session.capabilities.multiPage, true);
    await assert.rejects(manager.operatorInput(scope, { kind: "type", text: "blocked", expectedControlEpoch: session.controlEpoch + 1 }), /control|changed/i);
    await assert.rejects(manager.reconnect(scope), /local browser extension/);
    await manager.closeAll("test complete");
    await transport;
    assert.equal(manager.get(scope.agentId).status, "closed");
  } finally {
    await manager.closeAll("test cleanup");
    await rm(root, { recursive: true, force: true });
  }
});

test("local pairing is one-use, Chat-bound, command-fenced and explicitly revoked", async () => {
  const hub = new LocalBrowserHub();
  const pair = hub.pairing("chat-a");
  const { token, connection } = hub.claim(pair.code, { url: "https://example.test/application", title: "Application" });
  assert.throws(() => hub.claim(pair.code, { url: "https://example.test", title: "Replay" }));
  assert.throws(() => hub.factory("chat-b", connection.id), /not available/);
  await assert.rejects(hub.poll(connection.id, "wrong"), /authorization/);
  const driver = await hub.factory("chat-a", connection.id)("session", () => {});
  assert.throws(() => hub.factory("chat-a", connection.id), /not available/);
  const pending = driver.pageInfo();
  const command = await hub.poll(connection.id, token);
  assert.equal(command.action, "info");
  assert.throws(() => hub.result(connection.id, token, "wrong", {}, false), /Stale/);
  hub.result(connection.id, token, command.id, { url: "https://example.test/application", title: "Application", width: 800, height: 600 }, false);
  assert.equal((await pending).title, "Application");
  assert.throws(() => hub.result(connection.id, token, command.id, {}, false), /Stale/);
  assert.deepEqual(driver.viewport(), { width: 800, height: 600 });
  const close = driver.close();
  const disconnect = await hub.poll(connection.id, token);
  assert.equal(disconnect.action, "disconnect");
  assert.equal(driver.isAlive(), true, "closing is not confirmed until the extension detaches");
  hub.detached(connection.id, token);
  await close;
  assert.equal(driver.isAlive(), false);
  await assert.rejects(hub.poll(connection.id, token));
});

test("confirmed extension disconnect closes the UI session and permits a fresh pairing", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-window-disconnect-"));
  const hub = new LocalBrowserHub();
  const { token, connection } = hub.claim(hub.pairing("chat").code, { url: "https://example.test/form", title: "Application" });
  const scope = { projectId: "chat", agentId: "chat-browser", runId: "chat-session" };
  const manager = new BrowserSessionManager(root, async () => { throw new Error("No hosted launch"); }, () => {});
  try {
    const opening = manager.open(scope, undefined, "operator", hub.factory("chat", connection.id));
    const command = await hub.poll(connection.id, token);
    hub.result(connection.id, token, command.id, { activePageId: "7", pages: [{ pageId: "7", url: "https://example.test/form", title: "Application" }] }, false);
    await opening;
    hub.detached(connection.id, token);
    assert.equal((await manager.refreshLocalPages(scope)).status, "closed");
    assert.equal(manager.get(scope.agentId).status, "closed");
  } finally { await manager.closeAll("test complete"); await rm(root, { recursive: true, force: true }); }
});

test("pause preserves pairing but discards pending and queued actions across resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-window-pause-"));
  const hub = new LocalBrowserHub();
  const { token, connection } = hub.claim(hub.pairing("chat").code, { url: "https://example.test/form", title: "Application" });
  const scope = { projectId: "chat", agentId: "chat-browser", runId: "chat-session" };
  const manager = new BrowserSessionManager(root, async () => { throw new Error("No hosted launch"); }, () => {});
  try {
    const opening = manager.open(scope, undefined, "operator", hub.factory("chat", connection.id));
    const command = await hub.poll(connection.id, token);
    hub.result(connection.id, token, command.id, { activePageId: "7", pages: [{ pageId: "7", url: "https://example.test/form", title: "Application" }] }, false);
    const session = await opening;
    const first = manager.operatorInput(scope, { kind: "type", text: "first", expectedControlEpoch: session.controlEpoch });
    const firstRejected = assert.rejects(first, /pause|changed|discard/i);
    const pending = await hub.poll(connection.id, token);
    assert.equal(pending.connectionEpoch, 0);
    const second = manager.operatorInput(scope, { kind: "type", text: "queued", expectedControlEpoch: session.controlEpoch });
    const secondRejected = assert.rejects(second, /pause|changed|discard/i);
    hub.state(connection.id, token, true, 1);
    assert.equal(manager.get(scope.agentId).localPaused, true);
    assert.throws(() => hub.result(connection.id, token, pending.id, {}, false), /Stale/);
    hub.state(connection.id, token, false, 2);
    assert.equal(manager.get(scope.agentId).localPaused, false);
    assert.ok(manager.get(scope.agentId).controlEpoch > session.controlEpoch);
    assert.throws(() => hub.state(connection.id, token, true, 1), /stale/i);
    await Promise.all([firstRejected, secondRejected]);
    const refreshing = manager.refreshLocalPages(scope);
    const next = await hub.poll(connection.id, token);
    assert.equal(next.action, "pages", "queued typing was never replayed");
    assert.equal(next.connectionEpoch, 2);
    hub.result(connection.id, token, next.id, { activePageId: "7", pages: [{ pageId: "7", url: "https://example.test/form", title: "Application" }] }, false);
    assert.equal((await refreshing).status, "ready");
  } finally { hub.detached(connection.id, token); await manager.closeAll("test complete"); await rm(root, { recursive: true, force: true }); }
});

test("extension transport credentials cannot reach operator APIs or bypass origin protection", async () => {
  const app = Fastify();
  registerRequestSecurityHooks(app, { opts: { authToken: "operator-secret" }, v3DispatchKey: "internal", agentMessageCapabilities: new Map(), deletingAgentIds: new Set(), validLauncherSession: () => false, artifactFilesystemError: () => undefined, isArtifactDependentWorkIntake: () => false, isPublicWebAssetRequest: () => false });
  registerLocalBrowserRoutes(app, { projectExists: id => id === "chat", projectDeletionInProgress: () => false, projectBrowserSessions: {}, projectBrowserScope: () => ({}) });
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/projects/chat/local-browser/pair" })).statusCode, 401);
    const paired = await app.inject({ method: "POST", url: "/api/projects/chat/local-browser/pair", headers: { authorization: "Bearer operator-secret" } });
    const code = paired.json().code;
    const payload = { code, protocolVersion: 4, paused: false, url: "https://example.test/application", title: "Local" };
    assert.equal((await app.inject({ method: "POST", url: "/api/local-browser/claim", headers: { origin: "https://evil.example" }, payload })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/local-browser/claim", payload: { ...payload, protocolVersion: 1 } })).statusCode, 409, "old tab-only extensions cannot receive a window grant");
    const claim = await app.inject({ method: "POST", url: "/api/local-browser/claim", headers: { origin: `chrome-extension://${"a".repeat(32)}` }, payload });
    assert.equal(claim.statusCode, 200);
    const { token } = claim.json();
    assert.equal((await app.inject({ method: "POST", url: "/api/projects/chat/local-browser/pair", headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/local-browser/claim", payload })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/projects/chat/local-browser", headers: { authorization: "Bearer operator-secret" } })).json()[0].projectId, "chat");
  } finally { await app.close(); }
});
