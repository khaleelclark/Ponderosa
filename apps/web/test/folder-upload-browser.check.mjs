import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";
import { AssetStore } from "../../server/dist/assets.js";
import { registerBodyParsers } from "../../server/dist/server-request-hooks.js";
import { DraftService, registerDraftRoutes } from "../../server/dist/routes/drafts.js";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const Fastify = require("fastify");
const { WorkspaceStore } = require("@ponderosa/agents");
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
const web = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "folder-upload-browser-"));
const output = path.join(temporary, "web"), data = path.join(temporary, "data");
const app = Fastify(), assets = new AssetStore(data, { portableFiles: true }), workspace = new WorkspaceStore(data);
const store = { getAgent: () => undefined, getConversation: id => id === "folder-chat" ? { id } : undefined };
const drafts = new DraftService(data, store, workspace, assets);
let browser, requests = 0;
try {
  registerBodyParsers(app); registerDraftRoutes(app, drafts, workspace, 8, () => undefined);
  app.addHook("onRequest", async request => { if (request.method === "POST") requests++; });
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/folder-upload-browser-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  app.get("/*", async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) return reply.code(404).send();
    try { return reply.type(file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html").send(await readFile(file)); }
    catch { return reply.code(404).send(); }
  });
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  browser = await playwright[engine].launch({ headless: true,
    executablePath: engine === "chromium" ? process.env.PONDEROSA_CHROMIUM_PATH : process.env.PONDEROSA_WEBKIT_PATH });
  for (const width of [390, 1440]) for (const root of ["Fonts", "日本語", "🎨 Fonts", "école"]) for (const mode of ["picker", "drop"]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${origin}/?${new URLSearchParams({ root })}`);
    const before = requests;
    if (mode === "picker") {
      const folder = path.join(temporary, "picked", root);
      await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, "字形.ttf"), "exact font bytes");
      await page.getByLabel("Choose folder", { exact: true }).setInputFiles(folder);
    } else await page.getByRole("button", { name: "Prepare dropped folder", exact: true }).click();
    await page.waitForFunction(() => {
      const file = document.querySelector("[data-file-name]");
      return document.body.dataset.error || (file && /^(complete|failed):/.test(file.textContent));
    });
    assert.equal(await page.locator("body").getAttribute("data-error"), null);
    const row = page.locator("[data-file-name]");
    assert.match(await row.innerText(), /^complete:/, `${engine}/${width}/${root}/${mode}: actual draft upload succeeds`);
    assert.equal(requests, before + 1, "one actual HTTP upload, no mocked callback");
    const name = await row.getAttribute("data-file-name"), id = await row.getAttribute("data-attachment-id");
    assert.match(name, /^[\x20-\x7e]+\.zip$/);
    const prepared = await drafts.prepared("folder-chat", "folder-owner", id); assert(prepared);
    assert.equal(prepared.prepared.name, name);
    const bytes = prepared.body, nameSize = bytes.readUInt16LE(26), size = bytes.readUInt32LE(18);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50); assert.equal(bytes.readUInt16LE(6), 0x800);
    assert.equal(bytes.subarray(30, 30 + nameSize).toString("utf8"), `${root}/字形.ttf`, "Unicode root/member paths are not renamed");
    const body = bytes.subarray(30 + nameSize, 30 + nameSize + size);
    assert.equal(body.toString(), "exact font bytes"); assert.equal(crc32(body), bytes.readUInt32LE(14));
    const download = await page.request.get(`${origin}/api/conversations/folder-chat/draft-attachments/${id}?ownerId=folder-owner`);
    assert.equal(download.status(), 200); assert.deepEqual(await download.body(), bytes);
    await page.close();
  }
  console.log(`PASS ${engine}: ASCII/Japanese/emoji/accented folder roots through picker and paginated drop preparation, real draft HTTP/store upload, original UTF-8 paths/bytes/CRC and scoped downloads at 390/1440px`);
} finally {
  await browser?.close(); await app.close(); assets.close();
  await rm(temporary, { recursive: true, force: true });
}
