import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const web = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "optimistic-send-"));
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
let browser, server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/optimistic-send-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/")) { response.writeHead(200, { "Content-Type": "application/json" }).end("[]"); return; }
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try {
      const content = await readFile(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await playwright[engine].launch({ headless: true,
    ...(engine === "chromium" ? { executablePath: process.env.PONDEROSA_CHROMIUM_PATH } : {}) });
  const errors = [];
  for (const width of [390, 1440]) {
    for (const scenario of ["accepted", "rejected", "scope", "creation", "direct", "direct-rejected"]) {
      const context = await browser.newContext({ viewport: { width, height: 932 } });
      const page = await context.newPage();
      page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
      await page.goto(`http://127.0.0.1:${server.address().port}/?case=${scenario}`);
      const input = page.locator('[contenteditable="true"]');
      if (scenario === "accepted") await page.getByLabel("Choose files", { exact: true }).setInputFiles({
        name: "evidence.txt", mimeType: "text/plain", buffer: Buffer.from("attachment evidence"),
      });
      await input.fill(`Immediate message ${scenario}`);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const pending = page.getByRole("article", { name: "Sending message", exact: true });
      await pending.waitFor();
      assert.match(await pending.innerText(), /Immediate message/);
      assert.match(await pending.innerText(), /Sending…/);
      if (scenario === "accepted") assert.match(await pending.innerText(), /evidence.txt/);
      assert.equal(await page.locator("body").getAttribute("data-send-calls"), null,
        "pending bubble appears while durable journal is blocked, before HTTP intake");
      assert(!/Delivered to|Message sent to|Deleted Agent/.test(await page.locator("body").innerText()));
      await page.getByRole("button", { name: "Release journal", exact: true }).click();
      await page.waitForFunction(() => document.body.dataset.sendCalls === "1");
      assert.equal(await pending.count(), 1, "still pending while intake response is delayed");
      if (scenario === "scope") {
        await page.getByRole("button", { name: "Switch Chat", exact: true }).click();
        await pending.waitFor({ state: "detached" });
        await page.getByRole("button", { name: "Release send", exact: true }).click();
        assert.equal(await page.getByRole("article").count(), 0, "old send must not leak into new Chat");
      } else if (scenario.endsWith("rejected")) {
        if (scenario === "direct-rejected") {
          await page.getByRole("button", { name: "Publish incoming", exact: true }).click();
          await page.getByText("Unrelated incoming reply", { exact: true }).waitFor();
        }
        await page.getByRole("button", { name: "Reject send", exact: true }).click();
        await pending.waitFor({ state: "detached" });
        await page.getByText("Message not sent. Test rejection.", { exact: true }).waitFor();
        assert.match(await input.innerText(), new RegExp(`Immediate message ${scenario}`), "failed send retains its draft");
        if (scenario === "direct-rejected") {
          assert.equal(await page.getByRole("article").count(), 1);
          await page.getByText("Unrelated incoming reply", { exact: true }).waitFor();
        } else assert.equal(await page.getByRole("article").count(), 0, "failed message cannot become canonical");
      } else {
        await page.getByRole("button", { name: "Release send", exact: true }).click();
        await pending.waitFor({ state: "detached" });
        const canonical = page.locator('article[id*="canonical-"]');
        await canonical.waitFor();
        assert.equal(await canonical.count(), 1);
        assert(!/Delivered to|Message sent to|Deleted Agent/.test(await page.locator("body").innerText()),
          "accepted/queued message is not successful provider delivery or a deleted Agent");
        if (scenario === "creation") {
          assert.match(await canonical.innerText(), /Immediate message creation/);
          assert(!/Deleted-Agent/.test(await canonical.innerText()));
        } else if (scenario !== "direct") {
          await page.getByRole("button", { name: "Confirm delivery", exact: true }).click();
          await page.getByText("Delivered to Grand Canyon.", { exact: true }).waitFor();
          assert.equal(await page.getByRole("article").count(), 1);
        }
      }
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: immediate pending before journal/intake, attachment names, confirmed-only delivery, failed-draft recovery, scope isolation, real Chat creation/roster lag and direct-Agent sends preserving concurrent replies at 390/1440px`);
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
