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
  const dropFiles = async (page, selector, eventType, names) => page.locator(selector).evaluate((element, { eventType, names }) => {
    const transfer = new DataTransfer();
    for (const name of names) transfer.items.add(new File(["fixture bytes"], name, {
      type: name.endsWith(".png") ? "image/png" : name.endsWith(".docx")
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : name.endsWith(".exe") ? "application/octet-stream" : "text/plain",
    }));
    const event = new DragEvent(eventType, { bubbles: true, cancelable: true, dataTransfer: transfer });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, { eventType, names });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.route("**/api/**", route => route.fulfill({ json: {
      maxFileBytes: 80 * 1024 * 1024, maxMessageBytes: 80 * 1024 * 1024,
      maxAssetsPerMessage: 20, acceptedMediaTypes: ["image/png", "text/plain", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    } }));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const input = page.locator(".composer-editor-input");
    await input.waitFor();
    await input.focus(); await page.keyboard.press("End"); await page.keyboard.type("keep this draft");
    const originalText = await input.innerText();
    assert.ok(await dropFiles(page, ".ponderosa-composer", "dragenter", ["photo.png"]), "file drag is claimed by the composer");
    await page.waitForFunction(() => document.querySelector(".ponderosa-composer")?.dataset.fileDragActive === "true");
    assert.equal(await page.locator(".ponderosa-composer").getAttribute("data-file-drag-active"), "true");
    // Nested child transitions must not clear the drop highlight.
    await dropFiles(page, ".composer-editor-input", "dragenter", ["photo.png"]);
    await dropFiles(page, ".composer-editor-input", "dragleave", ["photo.png"]);
    assert.equal(await page.locator(".ponderosa-composer").getAttribute("data-file-drag-active"), "true");
    assert.ok(await dropFiles(page, ".composer-editor-input", "drop", ["photo.png", "notes.txt", "report.docx"]), "file drops never navigate the browser");
    for (const name of ["photo.png", "notes.txt", "report.docx"]) await page.getByRole("button", { name: `Remove ${name}`, exact: true }).waitFor();
    assert.equal(await input.innerText(), originalText, "dropping files preserves the authored text and recipient");
    assert.equal(await page.locator(".ponderosa-composer").getAttribute("data-file-drag-active"), "false");
    await page.getByRole("button", { name: "Remove notes.txt", exact: true }).click();
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.sentFiles !== undefined);
    assert.deepEqual(JSON.parse(await page.evaluate(() => document.body.dataset.sentFiles)), ["photo.png", "report.docx"]);
    await page.getByRole("button", { name: "Remove report.docx", exact: true }).waitFor({ state: "detached" });
    await dropFiles(page, ".ponderosa-composer", "drop", ["unsupported.exe"]);
    await page.getByText(/unsupported.exe wasn’t attached because its file type is not supported/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Remove unsupported.exe", exact: true }).count(), 0);
    await page.locator(".ponderosa-composer").evaluate(element => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([], "folder"));
      Object.defineProperty(transfer, "items", { value: [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }] });
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await page.getByText("Folders can’t be attached. Drop individual files instead.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Remove folder", exact: true }).count(), 0);
    await dropFiles(page, ".ponderosa-composer", "dragenter", ["photo.png"]);
    await page.waitForFunction(() => document.querySelector(".ponderosa-composer")?.dataset.fileDragActive === "true");
    await dropFiles(page, ".ponderosa-composer", "dragleave", ["photo.png"]);
    await page.waitForFunction(() => document.querySelector(".ponderosa-composer")?.dataset.fileDragActive === "false");
    await dropFiles(page, ".ponderosa-composer", "drop", Array.from({ length: 21 }, (_, i) => `bulk-${i}.txt`));
    await page.getByText(/bulk-20.txt wasn’t attached because the 20-file limit was reached/).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Remove bulk-/ }).count(), 20, "drop keeps the shared attachment cap");
    await page.close();
  }
  for (const restriction of ["disabled", "running", "no-attachments"]) {
    const page = await browser.newPage();
    await page.route("**/api/**", route => route.fulfill({ json: {} }));
    await page.goto(`http://127.0.0.1:${server.address().port}/?${restriction}=1`);
    await page.locator(".ponderosa-composer").waitFor();
    assert.ok(await dropFiles(page, ".ponderosa-composer", "drop", ["blocked.png"]), "blocked file drops also prevent browser navigation");
    assert.equal(await page.getByRole("button", { name: "Remove blocked.png", exact: true }).count(), 0, "drop respects composer restrictions");
    await page.close();
  }
  for (const [width, empty] of [[1440, false], [390, true]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    await page.route("**/api/**", route => route.fulfill({ json: {} }));
    await page.goto(`http://127.0.0.1:${server.address().port}/?${empty ? "empty=1" : ""}`);
    const input = page.locator(".composer-editor-input");
    await input.waitFor();
    await input.focus();
    await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.press("Backspace");
    const option = page.getByRole("option", { name: "#broadcast", exact: true });
    await page.keyboard.type("#"); await page.waitForTimeout(100);
    assert.equal(await option.count(), 1, "Broadcast appears in the initial # menu");
    await page.keyboard.type(width === 390 ? "BR" : "br");
    await page.waitForTimeout(100);
    assert.equal(await option.count(), 1, "Broadcast is suggested once even with no Agents");
    if (width === 390) await page.keyboard.press("Enter"); else await option.click();
    await page.getByRole("button", { name: "Remove #broadcast", exact: true }).waitFor();
    await page.waitForTimeout(100);
    await input.focus(); await page.keyboard.press("End"); await page.keyboard.type("update", { delay: 20 });
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.sent !== undefined);
    assert.equal((await page.evaluate(() => document.body.dataset.sent)).trim(), "#broadcast update", "selection submits the existing canonical Broadcast tag");
    await page.close();
  }
  for (const mode of ["structural", "fixed"]) {
    const page = await browser.newPage();
    await page.route("**/api/**", route => route.fulfill({ json: {} }));
    await page.goto(`http://127.0.0.1:${server.address().port}/?${mode}=1`);
    const input = page.locator(".composer-editor-input");
    await input.waitFor(); await input.focus();
    await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.press("Backspace");
    await page.keyboard.type("#br"); await page.waitForTimeout(100);
    assert.equal(await page.getByRole("option", { name: "#broadcast", exact: true }).count(), 0, "Broadcast is not offered outside Project Chat");
    await page.close();
  }
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
  console.log(`PASS ${useWebKit ? "WebKit" : "Chromium"} desktop/mobile composer: file/image/DOCX drop, shared caps/type rejection, folder and disabled/locked rejection, nested drag highlight; Broadcast autocomplete/selection/submission and scope, compact chips, atomic recipient/file Backspace, and touch/keyboard targets`);
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
