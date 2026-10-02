import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import Fastify from "fastify";
import { validateBrowserKey } from "../dist/browser-security.js";
import { BrowserSessionManager } from "../dist/browser-session-manager.js";
import { playwrightBrowserDriverFactory, findBrowserExecutable } from "../dist/chrome-cdp-driver.js";
import { registerBrowserRoutes } from "../dist/routes/browsers.js";

test("keyboard notation validates narrowly, without blind case normalization", () => {
  for (const key of ["End", "Enter", "Control+A", "Meta+Shift+a", "BrowserBack", "é", "🦊", "+", "Control++"]) assert.equal(validateBrowserKey(key), key);
  for (const key of ["END", "Unidentified", "Control+Control+A", "Control+🦊", "", "a\nb", "NotAKey", null]) assert.throws(() => validateBrowserKey(key), { statusCode: 400, code: "invalid_input" });
});

test("real Chrome accepts valid keys/Unicode and returns structured errors for invalid keys", { skip: !findBrowserExecutable() }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "key-boundary-"));
  const fixture = createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end('<title>Synthetic</title><input id="field" autofocus>'); });
  const scope = { projectId: "synthetic-chat", agentId: "synthetic-browser", runId: "shared" };
  const factory = playwrightBrowserDriverFactory(directory); let driver;
  const manager = new BrowserSessionManager(directory, async (...args) => { driver = await factory(...args); return driver; }, () => {});
  const app = Fastify();
  registerBrowserRoutes(app, { projectExists: () => true, projectDeletionInProgress: () => false, projectBrowserScope: () => scope, projectBrowserDto: (_id, dto) => dto, projectBrowserSessions: manager });
  try {
    await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
    const session = await manager.open(scope, `http://127.0.0.1:${fixture.address().port}`, "operator");
    for (const key of ["End", "Enter", "Control+A", "é", "🦊", "END", "Unidentified"]) {
      const response = await app.inject({ method: "POST", url: "/api/projects/synthetic-chat/browser/input", payload: { kind: "key", key, expectedControlEpoch: session.controlEpoch, expectedPageId: session.activePageId } });
      assert.equal(response.statusCode, ["END", "Unidentified"].includes(key) ? 400 : 200, response.body);
      if (response.statusCode === 400) assert.equal(response.json().code, "invalid_input");
    }
    const stale = await app.inject({ method: "POST", url: "/api/projects/synthetic-chat/browser/input", payload: { kind: "key", key: "End", expectedControlEpoch: session.controlEpoch, expectedPageId: "stale" } });
    assert.equal(stale.statusCode, 409);
    const agentControl = await manager.setControl(scope, "agent", session.controlEpoch);
    const operatorControl = await manager.setControl(scope, "operator", agentControl.controlEpoch);
    const staleControl = await app.inject({ method: "POST", url: "/api/projects/synthetic-chat/browser/input", payload: { kind: "key", key: "End", expectedControlEpoch: session.controlEpoch, expectedPageId: session.activePageId } });
    assert.equal(staleControl.statusCode, 409);
    await assert.rejects(manager.act(scope, { action: "key", key: "End" }), { statusCode: 409 });
    const realKey = driver.key.bind(driver); let attempts = 0;
    driver.key = async key => { attempts++; await driver.close(); return realKey(key); };
    const transport = await app.inject({ method: "POST", url: "/api/projects/synthetic-chat/browser/input", payload: { kind: "key", key: "End", expectedControlEpoch: operatorControl.controlEpoch, expectedPageId: operatorControl.activePageId } });
    assert.ok(transport.statusCode >= 500, transport.body); assert.notEqual(transport.json().code, "invalid_input");
    assert.equal(attempts, 1, "transport failure does not automatically replay a keyboard action");
  } finally { await app.close(); await manager.closeAll("synthetic qualification cleanup"); await new Promise(resolve => fixture.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});
