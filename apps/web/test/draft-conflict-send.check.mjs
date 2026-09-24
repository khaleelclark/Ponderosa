import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginReact } from "@rsbuild/plugin-react";
import { createRsbuild } from "@rsbuild/core";

const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const web = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "draft-conflict-send-"));
const output = path.join(temporary, "web");
let browser;
let server;

try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: {
    plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/draft-conflict-send-entry.tsx") } },
    output: { distPath: { root: output } },
    logLevel: "error",
  } });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(output, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
    try {
      const content = await readFile(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH, args: ["--no-sandbox"] });

  for (const mode of ["discard", "resolved-conflict"]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
    let canonical;
    let conflict;
    let initialLoaded = false;
    let discarded = mode === "resolved-conflict";
    let acceptedWrites = 0;
    await page.route("**/api/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      const ownerId = url.searchParams.get("ownerId") ?? "browser-test";
      canonical ??= {
        conversationId: "conflict-chat", ownerId, text: "", attachmentIds: [],
        mentionBindings: [], revision: 1, updatedAt: "2026-09-18T00:00:00.000Z", clientId: "remote",
      };
      if (request.method() === "GET" && url.pathname.endsWith("/draft")) {
        initialLoaded = true;
        await route.fulfill({ json: canonical });
        return;
      }
      if (request.method() === "GET" && url.pathname.endsWith("/draft-conflicts")) {
        await route.fulfill({ json: { conversationId: "conflict-chat", conflicts: conflict && !discarded ? [conflict] : [] } });
        return;
      }
      if (request.method() === "PUT" && url.pathname.endsWith("/draft")) {
        const body = request.postDataJSON();
        if (body.expectedRevision !== canonical.revision) {
          conflict ??= {
            id: "draft-conflict-test", current: canonical,
            displaced: { conversationId: "conflict-chat", text: body.text, attachmentIds: body.attachmentIds,
              mentionBindings: body.mentionBindings ?? [], clientId: body.clientId, capturedAt: "2026-09-18T00:00:01.000Z" },
          };
          await route.fulfill({ status: 409, json: conflict });
          return;
        }
        canonical = { ...canonical, ...body, revision: canonical.revision + 1, updatedAt: "2026-09-18T00:00:02.000Z" };
        acceptedWrites += 1;
        await route.fulfill({ json: canonical });
        return;
      }
      if (request.method() === "DELETE" && url.pathname.includes("/draft-conflicts/")) {
        discarded = true;
        await route.fulfill({ json: { conflictId: "draft-conflict-test", action: "discarded", replayed: false, currentDraft: canonical } });
        return;
      }
      await route.fulfill({ json: { acceptedMediaTypes: ["text/plain"], maxAssetsPerMessage: 20, maxFileBytes: 8388608, maxMessageBytes: 167772160 } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const input = page.locator(".composer-editor-input");
    await input.waitFor();
    await page.waitForFunction(() => document.querySelector(".composer-editor-input")?.textContent === "");
    assert.equal(initialLoaded, true);
    canonical = { ...canonical, text: "remote edit", revision: 2, updatedAt: "2026-09-18T00:00:01.000Z", clientId: "remote-new" };
    await input.click();
    await page.keyboard.insertText(`send after ${mode}`);
    await page.getByText("This draft changed elsewhere.").waitFor();
    if (mode === "discard") await page.getByRole("button", { name: "Discard" }).click();
    else await page.getByRole("button", { name: "Restore" }).click();
    await page.getByText("This draft changed elsewhere.").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByRole("status").getByText("Sending message… Your draft remains here until confirmed.").waitFor();
    assert.equal(await page.locator("#sent").innerText(), "[]", "pending send is visible without claiming delivery");
    await page.waitForFunction(expected => document.querySelector("#sent")?.textContent?.includes(expected), `send after ${mode}`);
    assert.ok(acceptedWrites >= 1, `${mode}: conflict resolution advances the saved draft revision`);
    assert.equal((await page.locator("body").innerText()).includes("Message not sent. 409"), false);
    console.log(`PASS ${mode}: conflict choice leaves the message sendable`);
    await page.close();
  }
} finally {
  await browser?.close();
  server?.close();
  await rm(temporary, { recursive: true, force: true });
}
