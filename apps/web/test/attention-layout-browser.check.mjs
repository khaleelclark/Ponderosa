import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const web = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "attention-layout-"));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
let browser, server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/attention-layout-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try { const content = await readFile(file); response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH });
  const sizes = [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 600, height: 400 }, { width: 1440, height: 900 }];
  for (const size of sizes) for (const questions of [1, 3, 0]) {
    const page = await browser.newPage({ viewport: size });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?questions=${questions}&warning`);
    const chat = page.getByRole("region", { name: "Conversation", exact: true });
    await chat.waitFor();
    const geometry = await page.evaluate(() => {
      const bounds = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, right: r.right }; };
      const chat = document.querySelector(".chat-scroll-region");
      const alert = document.querySelector("[role=alert]");
      const card = document.querySelector('[aria-label="Decision"]');
      return { chat: bounds(chat), alert: bounds(alert), card: card ? bounds(card) : null, footer: bounds(document.querySelector("footer")) };
    });
    if (process.env.EXPECT_OVERLAP === "1") {
      console.log(JSON.stringify({ size, questions, ...geometry, overlaps: geometry.card && geometry.alert.top < geometry.card.bottom - 1 || geometry.chat.top < geometry.alert.bottom - 1 }));
      await page.close(); continue;
    }
    const surface = page.getByRole("region", { name: "Needs your attention", exact: true });
    const surfaceBox = await surface.boundingBox();
    assert.ok(surfaceBox && surfaceBox.y + surfaceBox.height <= geometry.chat.top + 1, "attention area ends before the message scroller");
    assert.ok(geometry.chat.height >= 48, "narrow/short views retain a usable message scroller");
    assert.ok(geometry.chat.bottom <= geometry.footer.top + 1, "messages do not overlap the composer");
    assert.ok(geometry.alert.left >= 0 && geometry.alert.right <= size.width, "warning remains horizontally contained");
    if (questions === 1) assert.ok(geometry.alert.top >= geometry.card.bottom - 1, "warning starts after the decision card");
    if (questions) {
      await surface.getByRole("button", { name: "Answer", exact: true }).last().click();
      await page.getByRole("dialog", { name: "Answer Decision" }).waitFor();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    await surface.getByRole("button", { name: /Review/ }).click();
    await page.getByRole("dialog", { name: "Needs Your Attention" }).waitFor();
    await page.getByRole("dialog", { name: "Needs Your Attention" }).getByRole("button", { name: "Close", exact: true }).click();
    await chat.evaluate(el => { el.scrollTop = 0; });
    const textBounds = await chat.getByText("I've kept this release focused on your notification.").boundingBox();
    assert.ok(textBounds && textBounds.y >= geometry.chat.top - 1, "scrolling to the first message cannot place it under attention cards");
    if (questions === 1 && process.env.PONDEROSA_ATTENTION_SCREENSHOTS === "1") {
      await page.screenshot({ path: path.join(tmpdir(), `attention-layout-after-${size.width}x${size.height}.png`) });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  if (process.env.EXPECT_OVERLAP !== "1") for (const size of sizes) {
    const page = await browser.newPage({ viewport: size });
    await page.goto(`http://127.0.0.1:${server.address().port}/?questions=0`);
    const chat = page.getByRole("region", { name: "Conversation", exact: true });
    await chat.waitFor();
    assert.equal(await page.getByRole("region", { name: "Needs your attention", exact: true }).count(), 0);
    const box = await chat.boundingBox();
    assert.ok(box && box.height >= size.height - 153, "no attention item leaves the full available Chat space");
    await page.close();
  }
  console.log(process.env.EXPECT_OVERLAP === "1" ? "Baseline attention geometry recorded" : "Decision/warning/message separation and actions passed at phone, short-window and desktop sizes");
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
