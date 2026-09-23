import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { playwrightBrowserDriverFactory, findBrowserExecutable } from "../dist/chrome-cdp-driver.js";

for (const hostedHeaded of [false, true]) test(`Playwright ${hostedHeaded ? "headed" : "headless"}: delayed/shadow controls, popup targeting, upload and exact teardown`, { skip: !findBrowserExecutable() }, async () => {
  process.env.PONDEROSA_BROWSER_MULTI_PAGE = "1";
  process.env.PONDEROSA_BROWSER_FILE_UPLOAD = "1";
  const root = mkdtempSync(join(tmpdir(), "playwright-browser-"));
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url === "/scroll") { res.end('<style>body{margin:0}div{height:1000px;background:red}div+div{background:blue}</style><div></div><div></div>'); return; }
    if (req.url === "/embedded") { res.end('<p>Embedded frame region</p><input id="embedded-field" aria-label="Embedded answer">'); return; }
    if (req.url === "/frames") { res.end('<iframe src="/embedded"></iframe><input id="rejecting" oninput="this.value=\'\'">'); return; }
    res.end(req.url === "/popup" ? '<title>Popup</title><input id="popup">' : `<title>Fixture</title><main><input id="password" type="password" value="FAKE_SECRET"><input id="file" type="file" accept="text/plain"><button id="popup" onclick="window.open('/popup')">Popup</button><div id="shadow"></div></main><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<input id="shadow-field">';setTimeout(()=>document.querySelector('main').insertAdjacentHTML('beforeend','<input id="delayed">'),600);</script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let driver;
  const handles = [];
  try {
    driver = await playwrightBrowserDriverFactory(root)("fixture", () => {}, handle => handles.push(handle), undefined, {
      hostedHeaded,
      // GitHub's hosted Ubuntu runner disables the user namespaces Chromium's
      // sandbox requires. Production launches do not set this explicit escape.
      disableSandbox: process.env.CI === "true",
    });
    await driver.navigate(`http://127.0.0.1:${server.address().port}`);
    await driver.fill("#delayed", "waited correctly");
    assert.ok((await driver.inspect()).includes("waited correctly"));
    assert.ok(!(await driver.inspect()).includes("FAKE_SECRET"));
    await driver.fill("#shadow-field", "shadow works");
    await assert.rejects(driver.fill("[", "FAKE_SECRET_LEAK"), error => {
      assert.ok(!error.message.includes("FAKE_SECRET_LEAK"));
      assert.match(error.message, /invalid_selector/);
      return true;
    });
    const first = (await driver.pages()).activePageId;
    await driver.resizeViewport(first, { width: 640, height: 480 });
    const compactLayout = JSON.parse(await driver.inspect()).viewport;
    assert.equal(compactLayout.width, 640, "actual document reflows, not just screenshot clipping");
    assert.equal(compactLayout.height, 480);
    const resizedFrame = await driver.capture(first);
    assert.equal(resizedFrame.readUInt32BE(16), 1280);
    assert.equal(resizedFrame.readUInt32BE(20), 960);
    await driver.resizeViewport(first, { width: 1440, height: 900 });
    assert.equal(JSON.parse(await driver.inspect()).viewport.width, 1440);
    const expandedFrame = await driver.capture(first);
    assert.equal(expandedFrame.readUInt32BE(16), 2880);
    assert.equal(expandedFrame.readUInt32BE(20), 1800);
    const added = await driver.newPage();
    assert.equal(added.pages.length, 2);
    assert.notEqual(added.activePageId, first);
    await driver.navigate(`http://127.0.0.1:${server.address().port}/popup`);
    await driver.capture(first);
    assert.equal((await driver.pages()).activePageId, added.activePageId, "viewing another tab does not change the action target");
    await driver.fill("#popup", "target retained");
    assert.ok((await driver.inspect()).includes("target retained"), "actual input still reaches the working tab after viewing another");
    await driver.closePage(added.activePageId);
    await driver.activatePage(first);
    await driver.fill("#delayed", "activity marker");
    assert.equal(driver.activity().kind, "fill");
    assert.equal(driver.activity().pageId, first);
    assert.ok(driver.activity().width > 0);
    assert.ok(!JSON.stringify(driver.activity()).includes("activity marker"), "activity contains geometry, not input values");
    await driver.click("#popup");
    let pages;
    for (let i = 0; i < 250; i++) {
      pages = await driver.pages();
      const candidate = pages.pages.find(page => page.pageId !== first);
      if (candidate?.url.endsWith("/popup") && candidate.title === "Popup") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(pages.pages.length, 2);
    const popup = pages.pages.find(page => page.pageId !== first);
    assert.equal(popup.title, "Popup", "new popup is loaded before it receives input");
    await driver.activatePage(popup.pageId);
    await driver.fill("#popup", "popup works");
    assert.ok((await driver.inspect()).includes("popup works"));
    await driver.closePage(popup.pageId);
    await driver.activatePage(first);
    await driver.click("#file");
    for (let i = 0; i < 50 && !(await driver.pages()).pendingFileChooser; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok((await driver.pages()).pendingFileChooser, "page chooser remains available for authorized upload");
    const file = join(root, "fixture.txt"); writeFileSync(file, "fixture");
    const receipt = await driver.upload({ uploadId: "fixture", stagedPath: file, expectedName: "fixture.txt", expectedSize: 7, expectedMediaType: "text/plain" });
    assert.equal(receipt.input.name, "fixture.txt");
    assert.ok((await driver.capture()).length > 100);
    await driver.clearUploadedFiles();
    await driver.navigate(`http://127.0.0.1:${server.address().port}/scroll`);
    await driver.resizeViewport(first, { width: 640, height: 480 });
    await driver.scroll(0, 1100);
    for (let i = 0; i < 50 && JSON.parse(await driver.inspect()).viewport.scrollY < 1000; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const pixel = await sharp(await driver.capture(first)).extract({ left: 200, top: 200, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...pixel], [0, 0, 255], "capture follows the scrolled viewport, not the top of the document");
    await driver.navigate(`http://127.0.0.1:${server.address().port}/frames`);
    let embedded;
    for (let i = 0; i < 50 && !embedded; i++) { embedded = JSON.parse(await driver.inspect()).frameControls.find(control => control.id === 'embedded-field'); if (!embedded) await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.ok(embedded, 'inspection exposes an actionable embedded frame control');
    const frame = JSON.parse(await driver.inspect()).frames.find(frame => frame.url.endsWith('/embedded'));
    assert.ok(frame, 'inspection exposes a frame region selector');
    const region = JSON.parse(await driver.inspect(frame.selector));
    assert.equal(region.requestedRegion.error, null);
    assert.match(region.changedRegions[0].text, /Embedded frame region/);
    await driver.fill(embedded.selector, 'embedded answer');
    await assert.rejects(driver.fill('#rejecting', 'rejected value'), { reason: 'fill_unconfirmed' });
    if (!hostedHeaded) {
      while ((await driver.pages()).pages.length < 30) await driver.newPage();
      await assert.rejects(driver.newPage(), /tab limit/);
      assert.equal((await driver.pages()).pages.length, 30, "all thirty existing tabs survive a rejected thirty-first tab");
    }
    if (hostedHeaded) {
      await handles.at(-1).close();
      assert.equal(driver.isAlive(), false, "published process authority covers the Playwright-connected browser");
    }
  } finally {
    if (driver) { await driver.close(); assert.equal(driver.isAlive(), false); }
    else for (const handle of handles.reverse()) if (handle.isAlive()) await handle.close();
    await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
  }
});
