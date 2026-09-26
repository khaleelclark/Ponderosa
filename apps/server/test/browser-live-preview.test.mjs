import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromeBrowserDriverFactory, findBrowserExecutable } from "../dist/chrome-cdp-driver.js";

test("live browser preview follows painted scroll frames while evidence remains PNG", { skip: !findBrowserExecutable() }, async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-live-preview-"));
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<body style="margin:0"><div style="height:4000px;background:linear-gradient(red,blue)"></div></body>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let driver;
  try {
    driver = await chromeBrowserDriverFactory(root)("preview", () => {}, undefined, undefined, { hostedHeaded: false });
    await driver.navigate(`http://127.0.0.1:${server.address().port}`);
    const first = await driver.preview();
    assert.ok(first.data.startsWith("/9j/"), "the live view receives a JPEG");
    const png = await driver.capture();
    assert.deepEqual([...png.subarray(0, 4)], [137, 80, 78, 71], "evidence remains a lossless PNG");
    await driver.scroll(0, 500);
    let changed;
    for (let attempt = 0; attempt < 30; attempt++) {
      const frame = await driver.preview();
      if (frame.sequence > first.sequence && frame.data !== first.data) { changed = frame; break; }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(changed, "the stream advances to the painted scrolled page");
    assert.ok(changed.sequence > first.sequence);
  } finally {
    await driver?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
