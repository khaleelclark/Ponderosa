import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "composer-chip-a11y-"));
const { chromium, webkit, devices } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? "playwright");
const useWebKit = process.env.PONDEROSA_BROWSER_ENGINE === "webkit";
let browser;
let server;
try {
  const build = await createRsbuild({
    cwd: root,
    rsbuildConfig: {
      plugins: [pluginReact()],
      source: { entry: { index: path.join(root, "test/project-mention/fixture.tsx") } },
      output: { distPath: { root: output } },
      logLevel: "error",
    },
  });
  await build.build();
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const file = path.join(output, pathname === "/" ? "index.html" : pathname);
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await (useWebKit ? webkit : chromium).launch({
    headless: true,
    executablePath: useWebKit ? undefined : process.env.PONDEROSA_CHROMIUM_PATH,
    args: process.env.PONDEROSA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  for (const [width, coarse, longName, structural] of [
    [1440, false, false, false],
    [390, true, false, false],
    [390, true, true, false],
    [1440, false, true, true],
    [390, true, true, true],
  ]) {
    const context = await browser.newContext(coarse && useWebKit
      ? { ...devices["iPhone 13"], viewport: { width, height: 900 } }
      : { viewport: { width, height: 900 }, hasTouch: coarse });
    const page = await context.newPage();
    await page.route("**/api/**", route => route.fulfill({ json: {} }));
    const query = new URLSearchParams();
    if (longName) query.set("long", "1");
    if (structural) query.set("structural", "1");
    await page.goto(`http://127.0.0.1:${server.address().port}/?${query}`);
    const input = page.locator(".composer-editor-input");
    const recipient = longName ? "Branches-UI-Audit-Coordinator" : "Boston";
    const remove = page.getByRole("button", { name: `Remove #${recipient}` }).first();
    await remove.waitFor();
    assert.ok(await remove.evaluate(element => element.tabIndex >= 0), "chip removal belongs in the Tab order");
    const bounds = await remove.boundingBox();
    assert.ok(bounds && bounds.width >= 24 && bounds.height >= 24,
      "chip removal has an adequate visible pointer target");
    if (coarse) {
      const chip = await page.locator("[data-composer-mention='true']").first().boundingBox();
      assert.ok(chip && chip.height <= 32, "mobile recipient chip stays compact");
      const trailingSpace = chip.x + chip.width - (bounds.x + bounds.width);
      assert.ok(trailingSpace <= 2,
        `the mobile chip ends beside the visible X without trailing blank space (${trailingSpace}px)`);
      const hit = await page.evaluate(({ x, y }) =>
        document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label"),
      { x: bounds.x - 18, y: bounds.y + bounds.height / 2 });
      assert.equal(hit, `Remove #${recipient}`, "compact X retains a 44px effective touch target to its left");
      const nextToChip = await page.evaluate(({ x, y }) =>
        document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label"),
      { x: chip.x + chip.width + 8, y: bounds.y + bounds.height / 2 });
      assert.notEqual(nextToChip, `Remove #${recipient}`,
        "the touch target does not intercept typing beside the chip");
      const verticalHit = await page.evaluate(({ x, y }) =>
        document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label"),
      { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height + 8 });
      assert.equal(verticalHit, `Remove #${recipient}`, "the touch target extends vertically too");
    }
    assert.equal(await page.getByText("Send a message").count(), 0,
      "an Agent chip suppresses the helper text");
    if (coarse) {
      const chip = await page.locator("[data-composer-mention='true']").first().boundingBox();
      const editor = await input.boundingBox();
      assert.ok(chip && editor, "recipient and editor are measurable");
      await page.mouse.click(Math.min(chip.x + chip.width + 8, editor.x + editor.width - 8), chip.y + chip.height / 2);
      assert.ok(await remove.isVisible(), "tapping beside the chip keeps its X separate from typing");
    } else {
      await input.click();
    }
    await page.keyboard.press("End");
    await page.keyboard.type("hello");
    assert.ok((await input.innerText()).includes("hello"), "typing after the recipient works");
    if (coarse) {
      const onChipLine = await input.evaluate(element => {
        const chip = element.querySelector("[data-composer-mention='true']");
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const index = node.textContent?.indexOf("hello") ?? -1;
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const text = range.getBoundingClientRect();
          const recipient = chip?.getBoundingClientRect();
          return Boolean(recipient && text.left >= recipient.right - 1 &&
            text.top < recipient.bottom && text.bottom > recipient.top);
        }
        return false;
      });
      assert.ok(onChipLine, "typing starts beside the Agent chip on mobile");
    }
    for (const _ of "hello") {
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(30);
    }
    assert.ok(await remove.isVisible(), "erasing reply text retains the recipient");
    await page.keyboard.press("Backspace");
    await remove.waitFor({ state: "detached" });
    assert.ok(!(await input.innerText()).includes(`#${recipient}`), "one Backspace removes the whole recipient");
    assert.ok(await page.getByText("Send a message").isVisible(),
      "ordinary helper text returns when the recipient is removed");
    await input.focus();
    await page.keyboard.type("plain");
    await page.keyboard.press("Backspace");
    assert.ok((await input.innerText()).includes("plai"), "ordinary Backspace still deletes only one character");

    if (!structural) {
      await page.getByRole("button", { name: "Mention Boston" }).click();
      const mentionRemove = page.getByRole("button", { name: "Remove #Boston" }).first();
      await mentionRemove.waitFor();
      await mentionRemove.focus();
      await page.keyboard.press("Space");
      await mentionRemove.waitFor({ state: "detached" });
    }
    await context.close();
  }
  for (const [width, coarse] of [[1440, false], [390, true]]) {
    const context = await browser.newContext(coarse && useWebKit
      ? { ...devices["iPhone 13"], viewport: { width, height: 900 } }
      : { viewport: { width, height: 900 }, hasTouch: coarse });
    const page = await context.newPage();
    await page.route("**/api/**", route => route.fulfill({ json: {} }));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const input = page.locator(".composer-editor-input");
    const recipientRemove = page.getByRole("button", { name: "Remove #Boston" }).first();
    await recipientRemove.waitFor();
    await page.getByRole("button", { name: "Mention project file" }).click();
    const fileRemove = page.getByRole("button", { name: "Remove @report.md" });
    await fileRemove.waitFor();
    await input.focus();
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await fileRemove.waitFor({ state: "detached" });
    assert.ok(await recipientRemove.isVisible(), "Backspace removes the file without erasing the recipient");
    assert.ok(!(await input.innerText()).includes("@report.md"), "one Backspace removes the whole file reference");
    await page.keyboard.press("Backspace");
    await recipientRemove.waitFor({ state: "detached" });
    await input.focus();
    await page.keyboard.type("plain");
    await page.keyboard.press("Backspace");
    assert.ok((await input.innerText()).includes("plai"), "ordinary Backspace still deletes one character after file removal");
    await context.close();
  }
  console.log(`PASS ${useWebKit ? "WebKit" : "Chromium"} desktop/mobile composer chips: compact layout, atomic recipient/file Backspace, and touch/keyboard targets`);
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
