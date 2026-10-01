import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";
import { AssetStore } from "../../server/dist/assets.js";
import { registerAttachmentRoutes } from "../../server/dist/routes/attachments.js";
import { ProjectFileAuthority, registerProjectFileRoutes } from "../../server/dist/routes/project-files.js";
import { basicDocxXml, docxFixture, WORD_NAMESPACE } from "./fixtures/docx-fixture.mjs";

const Fastify = createRequire(new URL("../../server/package.json", import.meta.url))("fastify");
const { chromium, webkit } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const web = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "ponderosa-docx-browser-")), output = path.join(temporary, "web"), files = path.join(temporary, "files");
const app = Fastify(), assets = new AssetStore(path.join(temporary, "data"), { portableFiles: true });
let browser, slowDisconnected = false, slowStarted = false;
async function waitForServer(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(check(), "expected browser HTTP lifecycle was observed by the server");
}
try {
  await mkdir(files);
  const inertXml = `<?xml-stylesheet type="text/xsl" href="https://example.invalid/never-fetch.xsl"?>${basicDocxXml.replace("</w:body>", '<other:img xmlns:other="http://www.w3.org/1999/xhtml" src="https://example.invalid/never-fetch.png"/></w:body>')}`;
  const bytes = docxFixture(inertXml);
  await writeFile(path.join(files, "Report.docx"), bytes);
  const projectId = randomUUID(), chatId = randomUUID();
  const store = { getProject: id => id === projectId ? { id, hostPath: files } : undefined, getAgent: () => undefined,
    getConversation: id => id === chatId ? { id, projectId, workingDirectory: files } : undefined, projectHasArtifactSourcePath: () => false };
  registerAttachmentRoutes(app, { store, assets, agentDeliveryLeases: new Map(), conversationDeliveryLeases: new Map(),
    conversationDeletionInProgress: () => false, agentDeletionInProgress: () => false, deletingAttachmentKeys: new Set(), reconcilingAssetAgentIds: new Set() });
  registerProjectFileRoutes(app, new ProjectFileAuthority(store, {}), store);
  const asset = await assets.stage({ projectId, agentId: chatId, conversationId: chatId, name: "Report.docx", body: bytes,
    declaredType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  app.get("/api/qualification-docx/:kind", async (request, reply) => {
    if (request.params.kind === "slow") {
      slowStarted = true;
      reply.hijack(); reply.raw.writeHead(200, { "content-type": "application/octet-stream" });
      reply.raw.write(Buffer.from([0x50, 0x4b, 3, 4]));
      reply.raw.on("close", () => { slowDisconnected = true; }); return;
    }
    if (request.params.kind === "partial") return reply.send(docxFixture(`<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${"<w:p><w:r><w:t>Limited paragraph</w:t></w:r></w:p>".repeat(1200)}</w:body></w:document>`));
    if (request.params.kind === "characters") return reply.send(docxFixture(`<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:r><w:t>${"😀".repeat(100_000)}</w:t></w:r></w:p></w:body></w:document>`));
    if (request.params.kind === "dtd") return reply.send(docxFixture(`<!DOCTYPE document [<!ENTITY file SYSTEM "https://example.invalid/never-fetch.dtd">]>${basicDocxXml}`));
    return reply.send(docxFixture("not document XML"));
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    if (!reply.hasHeader("Content-Security-Policy")) reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    return payload;
  });
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()], source: { entry: { index: path.join(web, "test/docx-preview-browser-entry.tsx") } }, output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  app.get("/*", async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) return reply.code(404).send();
    try { return reply.type(/\.m?js$/u.test(file) ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html").send(await readFile(file)); }
    catch { return reply.code(404).send(); }
  });
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  const engine = process.env.PONDEROSA_DOCX_BROWSER === "webkit" ? webkit : chromium;
  browser = await engine.launch({ headless: true, executablePath: process.env.PONDEROSA_DOCX_BROWSER === "webkit" ? undefined : process.env.PONDEROSA_CHROMIUM_PATH });
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.url().startsWith("https://example.invalid")) external.push(request.url()); });
    const url = (mode, download) => `${origin}/?${new URLSearchParams({ case: mode, download })}`;
    await page.goto(url("chat", asset.downloadUrl));
    const opener = page.getByRole("button", { name: "Preview Report.docx", exact: true }); await opener.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: "DOCX preview heading" }).waitFor();
    await dialog.getByText("Table cell text", { exact: true }).waitFor();
    assert.match(await dialog.innerText(), /escaped <script> stays inert/u);
    assert.equal(await dialog.locator("script, iframe, img").count(), 0);
    assert.equal(await dialog.getByRole("link", { name: "Download Report.docx" }).getAttribute("href"), asset.downloadUrl);
    const bounds = await dialog.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    await page.waitForFunction(() => {
      let element = document.querySelector('[role="dialog"]');
      if (!element) return false;
      for (; element; element = element.parentElement) if (getComputedStyle(element).opacity !== "1") return false;
      return true;
    });
    await page.screenshot({ path: `/tmp/ponderosa-docx-${process.env.PONDEROSA_DOCX_BROWSER ?? "chromium"}-${width}.png` });
    await page.keyboard.press("ArrowRight"); await dialog.getByText(/damaged or uses an unsupported format/u).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Try again" }).count(), 1);
    slowStarted = false; slowDisconnected = false;
    await page.keyboard.press("ArrowRight"); await dialog.getByText("Loading Word document…", { exact: true }).waitFor();
    await waitForServer(() => slowStarted);
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await waitForServer(() => slowDisconnected);
    assert.equal(await opener.evaluate(element => document.activeElement === element), true);
    await opener.click(); await dialog.getByRole("heading", { name: "DOCX preview heading" }).waitFor();
    await page.keyboard.press("Escape");
    const workspaceUrl = `/api/projects/${projectId}/workspace-files/download?${new URLSearchParams({ path: "Report.docx", conversationId: chatId })}`;
    await page.goto(url("workspace", workspaceUrl)); await page.getByRole("heading", { name: "DOCX preview heading" }).waitFor();
    assert.equal((await page.request.get(`${origin}/api/projects/${projectId}/workspace-files/download?path=Report.docx&conversationId=other-chat`)).status(), 404);
    await page.goto(url("workspace", "/api/qualification-docx/partial"));
    await page.getByText("This preview shows only part of the document. Download it for the complete contents.", { exact: true }).waitFor();
    assert.equal(await page.getByText("Limited paragraph", { exact: true }).count(), 1000);
    await page.goto(url("workspace", "/api/qualification-docx/characters"));
    await page.getByText("This preview shows only part of the document. Download it for the complete contents.", { exact: true }).waitFor();
    assert.equal(await page.locator('[aria-label="Word document preview: Report.docx"] p').last().textContent(), "😀".repeat(50_000));
    await page.goto(url("workspace", "/api/qualification-docx/dtd")); await page.getByText(/damaged or uses an unsupported format/u).waitFor();
    assert.deepEqual(external, []); assert.deepEqual(errors, []);
    await page.addInitScript(() => {
      const original = window.setTimeout;
      window.setTimeout = ((callback, delay, ...args) => original(callback, delay === 30_000 ? 500 : delay, ...args));
    });
    slowStarted = false; slowDisconnected = false;
    await page.goto(url("workspace", "/api/qualification-docx/slow"));
    await page.getByText("Word document preview took too long. Try again or download the file.", { exact: true }).waitFor();
    await waitForServer(() => slowDisconnected);
    assert.equal(await page.getByRole("button", { name: "Try again", exact: true }).count(), 1);
    await page.close();
  }
  assert.equal(slowDisconnected, true, "closing the preview cancels its stalled HTTP body");
  console.log("Passed DOCX Chat and scoped workspace preview at 390/1440px: headings/text, inert markup, no external fetches, wrong-Chat denial, bounds, paragraph/Unicode limits, partial/error notices, retry, deadline and navigation/close cancellation, reopening.");
} finally { await browser?.close(); await app.close(); assets.close(); await rm(temporary, { recursive: true, force: true }); }
