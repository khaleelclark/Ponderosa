import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserSessionManager } from "../dist/browser-session-manager.js";
import { playwrightBrowserDriverFactory, findBrowserExecutable } from "../dist/chrome-cdp-driver.js";

test("viewer tab isolation, viewport fencing, agent resize rejection and frame metadata", { skip: !findBrowserExecutable() }, async () => {
  process.env.PONDEROSA_BROWSER_MULTI_PAGE = "1";
  const root = mkdtempSync(join(tmpdir(), "browser-viewer-"));
  const scope = { projectId: "viewer-project", agentId: "viewer-agent", runId: "viewer-run" };
  const manager = new BrowserSessionManager(root, playwrightBrowserDriverFactory(root), () => {});
  try {
    let session = await manager.open(scope, undefined, "operator");
    const first = session.activePageId;
    session = await manager.newPage(scope, session.controlEpoch);
    const second = session.activePageId;
    assert.notEqual(first, second);
    await manager.resizeViewport(scope, first, { width: 640, height: 480 }, session.controlEpoch);
    const frame = await manager.captureFrame(scope, first);
    assert.equal(frame.metadata.pageId, first);
    assert.deepEqual(frame.metadata.viewport, { width: 640, height: 480 });
    assert.equal(frame.body.readUInt32BE(16), 1280, "2x pixels preserve sharp text without changing CSS input coordinates");
    assert.equal(manager.get(scope.agentId).activePageId, second);
    const other = await manager.captureFrame(scope, second);
    assert.equal(other.metadata.pageId, second, "frame cache is scoped to the viewed tab");
    await assert.rejects(manager.operatorInput(scope, { kind: "click", x: 10, y: 10, expectedPageId: first, expectedControlEpoch: session.controlEpoch }), /tab or size changed/);
    await assert.rejects(manager.operatorInput(scope, { kind: "scroll", deltaX: 0, deltaY: 200, expectedPageId: first, expectedControlEpoch: session.controlEpoch }), /tab or size changed/);
    await assert.rejects(manager.operatorInput(scope, { kind: "click", x: 10, y: 10, expectedPageId: second, expectedViewport: { width: 640, height: 480 }, expectedControlEpoch: session.controlEpoch }), /tab or size changed/);
    await manager.operatorInput(scope, { kind: "click", x: 10, y: 10, expectedPageId: second, expectedViewport: { width: 1280, height: 720 }, expectedControlEpoch: session.controlEpoch });
    await manager.operatorInput(scope, { kind: "scroll", deltaX: 0, deltaY: 200, expectedPageId: second, expectedControlEpoch: session.controlEpoch });
    const oldEpoch = session.controlEpoch;
    session = await manager.setControl(scope, "agent", oldEpoch);
    await assert.rejects(manager.newPage(scope, oldEpoch));
    await assert.rejects(manager.resizeViewport(scope, second, { width: 700, height: 500 }, session.controlEpoch));
    await manager.captureFrame(scope, first);
    assert.equal(manager.get(scope.agentId).activePageId, second, "agent's target is untouched by viewing");
  } finally {
    await manager.closeAll("test complete");
    rmSync(root, { recursive: true, force: true });
  }
});
