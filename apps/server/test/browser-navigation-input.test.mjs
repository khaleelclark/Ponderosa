import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromeBrowserDriverFactory, playwrightBrowserDriverFactory, findBrowserExecutable } from "../dist/chrome-cdp-driver.js";

for (const factory of [chromeBrowserDriverFactory, playwrightBrowserDriverFactory]) test(`${factory.name}: browser history and editing keys operate on the actual Chrome page`, { skip: !findBrowserExecutable() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "browser-navigation-"));
  const server = createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end(`<title>${req.url}</title><input id="field"><input id="next">`); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let driver;
  try {
    driver = await factory(root)("navigation", () => {}, undefined, undefined, { hostedHeaded: false });
    const base = `http://127.0.0.1:${server.address().port}`;
    await driver.navigate(`${base}/first`);
    await driver.navigate(`${base}/second`);
    const eventually = async check => {
      for (let i = 0; i < 50; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      assert.fail("browser state did not settle");
    };
    await driver.key("BrowserBack"); await eventually(async () => (await driver.pageInfo()).url === `${base}/first`);
    await driver.key("BrowserForward"); await eventually(async () => (await driver.pageInfo()).url === `${base}/second`);
    await driver.fill("#field", "abc");
    await driver.key("Backspace");
    const value = async selector => JSON.parse(await driver.inspect()).controls.find(control => control.selector === selector)?.text;
    assert.equal(await value("#field"), "ab");
    await driver.key("Control+a"); await driver.type("résumé");
    assert.equal(await value("#field"), "résumé");
    await driver.key("Tab"); await driver.type("next"); assert.equal(await value("#next"), "next");
    await driver.key("Shift+Tab"); await driver.type("!"); assert.equal(await value("#field"), "!");
    await driver.key("BrowserRefresh"); await eventually(async () => await value("#field") !== "!");
  } finally {
    if (driver) { await driver.close(); assert.equal(driver.isAlive(), false); }
    await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
  }
});
