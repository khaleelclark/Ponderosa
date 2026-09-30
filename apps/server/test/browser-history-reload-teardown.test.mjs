import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { playwrightBrowserDriverFactory, findBrowserExecutable } from "../dist/chrome-cdp-driver.js";

test("real owned Chrome serial history, reload, floating-size capture and teardown", { skip: !findBrowserExecutable() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ponderosa-browser-serial-"));
  const server = createServer((request, response) => response.end(`<title>${request.url}</title><main>${request.url}</main>`));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let driver; const handles = [];
  try {
    driver = await playwrightBrowserDriverFactory(root)("serial-fixture", () => {}, handle => handles.push(handle), undefined, { hostedHeaded: false, disableSandbox: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" });
    await driver.navigate(`${origin}/first`);
    await driver.navigate(`${origin}/second`);
    await driver.key("BrowserBack");
    assert.match(await driver.inspect(), /\/first/);
    await driver.key("BrowserForward");
    assert.match(await driver.inspect(), /\/second/);
    await driver.key("BrowserRefresh");
    assert.match(await driver.inspect(), /\/second/);
    const page = (await driver.pages()).activePageId;
    await driver.resizeViewport(page, { width: 700, height: 500 });
    const frame = await driver.capture(page);
    assert.equal(frame.subarray(1, 4).toString(), "PNG");
    await driver.close();
    assert.ok(handles.length > 0);
    assert.ok(handles.every(handle => !handle.isAlive()), "owned Chrome descendants are observed stopped");
  } finally { await driver?.close(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});
