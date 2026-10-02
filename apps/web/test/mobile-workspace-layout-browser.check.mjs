import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const web = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "mobile-workspace-layout-"));
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
let browser, server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/mobile-workspace-layout-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/fixture/")) {
      response.writeHead(200, { "Content-Type": "text/plain" }).end(`Readable result: ${pathname}`); return;
    }
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try {
      const content = await readFile(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright[engine].launch({ headless: true,
    executablePath: engine === "chromium" ? process.env.PONDEROSA_CHROMIUM_PATH : process.env.PONDEROSA_WEBKIT_PATH });
  const errors = [];
  const pageFor = async (viewport, query) => {
    const page = await browser.newPage({ viewport, hasTouch: viewport.width < 900 });
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    if (query === "case=composer") await page.addInitScript(() => {
      window.recognitions = [];
      window.SpeechRecognition = class {
        results = []; continuous = false; interimResults = false;
        constructor() { window.recognitions.push(this); }
        start() { this.onstart?.(); }
        stop() { this.onend?.(); }
        abort() { this.onend?.(); }
        final(text) { this.results.push({ isFinal: true, 0: { transcript: text }, length: 1 }); this.replay(); }
        replay() { this.onresult?.({ resultIndex: 0, results: this.results }); }
        androidHypotheses() {
          // Android continuous mode promotes requested partials to final results.
          if (this.interimResults) for (const text of ["hello", "hello from", "hello from Android"]) this.final(text);
          else this.final("hello from Android");
        }
      };
    });
    await page.goto(`${url}/?${query}`); return page;
  };
  for (const width of [390, 320, 430]) for (const mode of ["target-required", "project-chat", "fixed"]) {
    const page = await pageFor({ width, height: 900 }, `case=composer&reply&${mode}`);
    const input = page.locator(".composer-editor-input");
    await input.waitFor();
    if (mode !== "fixed") await page.getByRole("button", { name: "Remove #Boston", exact: true }).waitFor();
    await input.focus(); await page.keyboard.type("Keep this draft");
    await page.keyboard.press("ArrowLeft");
    const snapshot = () => input.evaluate(element => {
      const selection = window.getSelection();
      return { html: element.innerHTML, focus: document.activeElement === element,
        anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset,
        anchorText: selection.anchorNode?.textContent, focusText: selection.focusNode?.textContent };
    });
    const before = await snapshot();
    const trigger = page.getByRole("button", { name: /Choose engine, model/ });
    for (const submenu of [false, true]) {
      await trigger.tap();
      if (submenu) await page.getByRole("menuitem", { name: /Model GPT/ }).tap();
      assert.deepEqual(await snapshot(), before, "touch-open preserves the draft, destination and caret");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("body").getAttribute("data-recipient-cleared"), null, "picker dismissal cannot clear the All Messages recipient");
      assert.equal(await trigger.getAttribute("aria-expanded"), "false", "Escape closes the touch-open picker before composer handling");
      assert.deepEqual(await snapshot(), before, "picker Escape preserves editor focus, selection and canonical draft text");
    }
    if (mode === "target-required") {
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.body.dataset.recipientCleared === "yes");
    }
    await page.close();
  }
  for (const width of [320, 390, 1440]) {
    const page = await pageFor({ width, height: 900 }, "case=composer");
    const input = page.locator(".composer-editor-input");
    await input.fill("Typed prefix ");
    await page.getByRole("button", { name: "Start voice dictation", exact: true }).click();
    await page.getByRole("button", { name: "Pause voice dictation", exact: true }).waitFor();
    await page.evaluate(() => window.recognitions[0].androidHypotheses());
    await page.waitForFunction(() => document.querySelector(".composer-editor-input").innerText.includes("Android"));
    assert.equal((await input.innerText()).trim(), "Typed prefix hello from Android", "growing Android partials are not duplicated");
    await page.evaluate(() => { window.recognitions[0].replay(); window.recognitions[0].final("one"); window.recognitions[0].final("two"); window.recognitions[0].final("yes yes"); window.oldResult = window.recognitions[0].onresult; });
    await page.getByRole("button", { name: "Pause voice dictation", exact: true }).click();
    await page.getByRole("button", { name: "Resume voice dictation", exact: true }).click();
    await page.evaluate(() => { window.oldResult({ results: [{ isFinal: true, 0: { transcript: "stale text" } }] }); window.recognitions[1].final("yes yes"); });
    await page.getByRole("button", { name: "Stop voice dictation", exact: true }).click();
    await page.getByRole("button", { name: "Start voice dictation", exact: true }).waitFor();
    assert.equal((await input.innerText()).trim(), "Typed prefix hello from Android one two yes yes yes yes", "rapid distinct finals, intentional repetition and restart survive; replay and old generation are fenced");
    if (width < 900) {
      await input.focus(); await page.keyboard.press("End");
      const trigger = page.getByRole("button", { name: /Choose engine, model/ });
      await trigger.tap();
      assert(await input.evaluate(e => document.activeElement === e), "touch-opening picker keeps editor focus and software-keyboard owner");
      await page.getByRole("menuitem", { name: /Model GPT/ }).tap();
      await page.getByRole("menuitem", { name: "Other model", exact: true }).tap();
      assert(await input.evaluate(e => document.activeElement === e), "model selection preserves editor focus");
      for (const size of [{ width, height: 430 }, { width: 900, height: 390 }, { width, height: 900 }]) {
        await page.setViewportSize(size);
        await page.waitForFunction(() => { const r = document.querySelector('.MuiPaper-root[role="menu"]')?.getBoundingClientRect(); return r && r.top >= -0.5 && r.bottom <= innerHeight + 0.5 && r.left >= -0.5 && r.right <= innerWidth + 0.5; }, undefined, { timeout: 5000 }).catch(async error => {
          console.log(await page.evaluate(() => ({ viewport: [innerWidth, innerHeight], menu: document.querySelector('.MuiPaper-root[role="menu"]')?.getBoundingClientRect().toJSON(), height: getComputedStyle(document.documentElement).getPropertyValue("--ponderosa-app-viewport-block-size") })));
          await page.screenshot({ path: `/tmp/round2-picker-failure-${engine}.png` }); throw error;
        });
      }
      await trigger.tap();
      await page.locator('.MuiPaper-root[role="menu"]').waitFor({ state: "detached" });
      await page.keyboard.type(" ending");
      assert.match(await input.innerText(), /yes yes ending$/);
    } else {
      const trigger = page.getByRole("button", { name: /Choose engine, model/ });
      await trigger.focus(); await page.keyboard.press("Enter");
      await page.keyboard.press("Enter"); // Model section.
      await page.getByRole("menuitem", { name: "Other model", exact: true }).waitFor();
      await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
      assert.equal(await page.locator("body").getAttribute("data-selected-model"), "other");
      await page.keyboard.press("Escape");
      await page.locator('.MuiPaper-root[role="menu"]').waitFor({ state: "detached" });
      assert(await trigger.evaluate(e => document.activeElement === e), "keyboard dismissal returns focus to the picker trigger");
    }
    await input.fill("hi #new");
    await page.getByRole("option", { name: "#new-agent", exact: true }).click();
    await page.keyboard.type("after");
    assert.match((await input.innerText()).replace(/\s+/g, " ").trim(), /^hi #new-agent\s*after$/, "autocomplete caret follows creation chip");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.sent !== undefined);
    await input.focus(); await page.keyboard.type("next");
    assert(!/^next#/.test(await input.innerText()), "typing after send does not land before a lone chip");
    await input.fill("note #Bo");
    await page.getByRole("option", { name: "#Boston", exact: true }).click();
    await page.keyboard.type("after");
    assert.match((await input.innerText()).replace(/\s+/g, " ").trim(), /^note #Boston\s*after$/, "ordinary Agent autocomplete also leaves the caret after its chip");
    await page.close();
    const reply = await pageFor({ width, height: 900 }, "case=composer&reply");
    const replyInput = reply.locator(".composer-editor-input");
    await reply.getByRole("button", { name: "Remove #Boston", exact: true }).waitFor();
    await replyInput.focus(); await reply.keyboard.type("first");
    assert.match((await replyInput.innerText()).replace(/\s+/g, " ").trim(), /^#Boston\s*first$/, "initial reply typing follows its chip");
    await reply.getByRole("button", { name: "Send message", exact: true }).click();
    await reply.waitForFunction(() => document.body.dataset.sent !== undefined &&
      document.querySelector('.composer-editor-input[contenteditable="true"]')?.innerText.trim() === "#Boston", undefined, { timeout: 5000 }).catch(async error => {
        console.log({ engine, width, text: await replyInput.innerText(), sent: await reply.locator("body").getAttribute("data-sent"), html: await replyInput.innerHTML() }); throw error;
      });
    await replyInput.focus(); await reply.keyboard.type("next");
    assert.match((await replyInput.innerText()).replace(/\s+/g, " ").trim(), /^#Boston\s*next$/, "post-send reply typing follows the retained chip without pressing End");
    await reply.close();
  }
  for (const width of [320, 390, 430, 1440]) {
    const page = await pageFor({ width, height: 900 }, "case=chat-header&long");
    for (const expanded of width < 900 ? [false, true] : [true]) {
      if (expanded && width < 900) await page.getByRole("button", { name: "Expand workspace header", exact: true }).click();
      for (const name of [/Open provider usage/, "Open Project Browser", "Chat settings and actions"]) {
        const button = page.getByRole("button", { name });
        await button.waitFor();
        const r = await button.boundingBox();
        const title = await page.locator("h1").boundingBox();
        assert(r.x >= 0 && r.x + r.width <= width + 0.5, "Chat header action stays reachable");
        assert(Math.abs(r.y + r.height/2 - (title.y + title.height/2)) < 30, "Chat actions stay beside the title, not a separate controls row");
      }
      await page.getByRole("button", { name: "Open Project Browser", exact: true }).click();
      assert.equal(await page.locator("body").getAttribute("data-browser-opened"), "yes");
      await page.getByRole("button", { name: "Chat settings and actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Rename", exact: true }).waitFor();
      await page.keyboard.press("Escape");
    }
    await page.close();
  }
  for (const width of [320, 360, 390, 412, 430, 480, 600, 899, 1440]) {
    for (const connection of ["live", "reconnecting", "stale", "unavailable"]) {
      const page = await pageFor({ width, height: 932 }, `case=header&connection=${connection}&long&minutes=111&theme=${width % 2 ? "light" : "dark"}`);
      if (width < 900) await page.getByRole("button", { name: "Expand workspace header", exact: true }).click();
      await page.getByRole("button", { name: /Open provider usage/ }).waitFor();
      const geometry = await page.evaluate(() => {
        const title = document.querySelector("h1").getBoundingClientRect();
        const collapse = document.querySelector('[aria-label="Collapse workspace header"]').getBoundingClientRect();
        return { titleWidth: title.width, collapseLeft: collapse.left, collapseRight: collapse.right,
          overflow: document.documentElement.scrollWidth > innerWidth,
          containedChips: [...document.querySelectorAll(".MuiChip-root")].every(e => { const r = e.getBoundingClientRect(); return r.left >= -0.5 && r.right <= innerWidth + 0.5; }) };
      });
      assert(geometry.titleWidth >= 24, `Agent identity remains visible at ${width}/${connection}`);
      assert(geometry.collapseLeft >= 0 && geometry.collapseRight <= width + 0.5, "collapse remains wholly reachable");
      assert(!geometry.overflow && geometry.containedChips, "status and controls stay contained");
      if (width < 900) {
        const status = page.getByRole("button", { name: /Agent status:/ });
        await status.click();
        await page.getByRole("status").filter({ hasText: /Agent status:/ }).waitFor();
        await page.keyboard.press("Escape");
      }
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      assert.equal(await page.locator("body").getAttribute("data-stopped"), "yes");
      if (width === 430 && connection === "live") {
        const right = page.getByRole("button", { name: "Scroll tabs right", exact: true });
        await right.focus(); await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector(".MuiTabs-scroller").scrollLeft > 0);
        await right.click();
        await page.getByRole("tab", { name: "Settings", exact: true }).click();
        assert.equal(await page.getByRole("tab", { name: "Settings", exact: true }).getAttribute("aria-selected"), "true");
        await page.getByRole("tab", { name: "Chat", exact: true }).focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(await page.evaluate(() => document.activeElement.textContent), "Subagents");
        const left = page.getByRole("button", { name: "Scroll tabs left", exact: true });
        await left.focus(); await page.keyboard.press("Enter");
        await page.getByRole("tab", { name: "Chat", exact: true }).click();
        await page.getByRole("button", { name: "Collapse workspace header", exact: true }).click();
        await page.getByRole("button", { name: "Expand workspace header", exact: true }).waitFor();
        await page.getByRole("button", { name: "Expand workspace header", exact: true }).click();
        if (process.env.PONDEROSA_LAYOUT_SCREENSHOTS) await page.screenshot({ path: path.join(tmpdir(), `mobile-workspace-header-${engine}.png`) });
      }
      await page.close();
    }
  }
  const noChildren = await pageFor({ width: 430, height: 932 }, "case=header&no-descendants");
  await noChildren.getByRole("button", { name: "Expand workspace header", exact: true }).click();
  assert.equal(await noChildren.getByRole("tab", { name: "Subagents", exact: true }).count(), 0);
  await noChildren.close();
  for (const theme of ["dark", "light"]) {
    const page = await pageFor({ width: 430, height: 932 }, `case=picker&theme=${theme}`);
    const trigger = page.getByRole("button", { name: /Choose engine, model/ });
    await trigger.click();
    const menu = page.locator('.MuiPaper-root[role="menu"]');
    await menu.waitFor();
    for (const size of [{ width: 430, height: 500 }, { width: 932, height: 430 }, { width: 430, height: 932 }]) {
      await page.setViewportSize(size);
      await page.waitForFunction(() => { const r = document.querySelector('.MuiPaper-root[role="menu"]')?.getBoundingClientRect(); return r && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; });
    }
    await page.getByRole("menuitem", { name: /Model GPT/ }).click();
    await page.getByRole("menuitem", { name: "Other model", exact: true }).click();
    assert.equal(await page.locator("body").getAttribute("data-selected-model"), "other");
    await trigger.click(); assert.equal(await menu.count(), 0);
    await page.setViewportSize({ width: 430, height: 500 }); await trigger.click(); await menu.waitFor();
    if (process.env.PONDEROSA_LAYOUT_SCREENSHOTS) await page.screenshot({ path: path.join(tmpdir(), `mobile-workspace-picker-${engine}-${theme}.png`) });
    await page.close();
  }
  for (const size of [{ width: 430, height: 932 }, { width: 430, height: 500 }, { width: 1440, height: 932 }]) {
    const page = await pageFor(size, "case=files");
    await page.getByText("20 loaded items created by Agents in this Chat", { exact: true }).waitFor();
    const scroller = page.locator('#chat-workspace-files-panel .ponderosa-scroll');
    assert(await scroller.evaluate(e => e.scrollHeight > e.clientHeight), "populated results use the real Chat scroller");
    const r = await scroller.boundingBox(); await page.mouse.move(r.x + r.width / 2, r.y + r.height - 30); await page.mouse.wheel(0, 2500);
    await page.waitForFunction(() => document.querySelector('#chat-workspace-files-panel .ponderosa-scroll').scrollTop > 0);
    await scroller.evaluate(e => { e.scrollTop = e.scrollHeight; });
    const last = page.getByRole("button", { name: "Preview report-0.txt from Deleted Agent", exact: true });
    const lastBox = await last.boundingBox(); const scrollBox = await scroller.boundingBox();
    assert(lastBox.y >= scrollBox.y && lastBox.y + lastBox.height <= scrollBox.y + scrollBox.height + 1, "last result is reachable");
    await last.click(); await page.getByRole("dialog").waitFor();
    await page.getByText(/Readable result/).waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    if (engine === "chromium" && size.width < 900) {
      await scroller.evaluate(e => { e.scrollTop = e.scrollHeight / 2; });
      const beforeSwipe = await scroller.evaluate(e => e.scrollTop);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const cdp = await page.context().newCDPSession(page);
      const x = r.x + r.width / 2, y = r.y + r.height - 40;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 6; step++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 25 }] });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(before => document.querySelector('#chat-workspace-files-panel .ponderosa-scroll').scrollTop > before, beforeSwipe);
      await cdp.detach();
    }
    await scroller.evaluate(e => { e.scrollTop = 0; });
    const before = Number(await page.locator("body").getAttribute("data-folder-reads"));
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.waitForFunction(before => Number(document.body.dataset.folderReads) > before, before);
    await page.getByRole("textbox", { name: "Search Chat files and results", exact: true }).fill("report-19");
    await page.getByText("1 matching item created by Agents in this Chat", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "Search Chat files and results", exact: true }).fill("");
    await page.getByText("20 loaded items created by Agents in this Chat", { exact: true }).waitFor();
    if (process.env.PONDEROSA_LAYOUT_SCREENSHOTS) await page.screenshot({ path: path.join(tmpdir(), `mobile-workspace-files-${engine}-${size.width}x${size.height}.png`) });
    await page.close();
  }
  const ordered = await pageFor({ width: 390, height: 800 }, "case=files&pagination");
  const fileNames = () => ordered.getByRole("button", { name: /^Preview report-/ }).evaluateAll(elements => elements.map(e => e.getAttribute("aria-label")));
  for (let visit = 0; visit < 2; visit++) {
    await ordered.getByText("10 loaded items created by Agents in this Chat", { exact: true }).waitFor();
    assert.deepEqual(await fileNames(), Array.from({ length: 10 }, (_, i) => `Preview report-${19-i}.txt from Deleted Agent`));
    await ordered.getByRole("button", { name: "Load Older Files", exact: true }).click();
    await ordered.getByText("20 loaded items created by Agents in this Chat", { exact: true }).waitFor();
    assert.deepEqual(await fileNames(), Array.from({ length: 20 }, (_, i) => `Preview report-${19-i}.txt from Deleted Agent`), "older pagination retains newest-first artifact chronology");
    if (visit === 0) await ordered.reload();
  }
  await ordered.close();
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: final-only dictation, rapid finals/replay/restarts, caret before/after send, touch picker focus/orientation, responsive Chat/Agent headers, named tab arrows/keyboard, real file scrolling/search/preview/refresh and newest-first older pagination`);
} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(output, { recursive: true, force: true });
}
