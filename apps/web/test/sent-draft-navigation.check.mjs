import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { WorkspaceStore } from "../../../packages/agents/dist/workspace-store.js";

const web = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "sent-draft-navigation-"));
const output = path.join(temporary, "web");
const workspace = new WorkspaceStore(path.join(temporary, "data"));
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const owners = new Map(), clearAttempts = [], deletedAttachments = [];
let browser, server, holdClear, releaseClear;
const json = (response, value, status = 200) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/sent-draft-navigation-entry.tsx") } },
    output: { distPath: { root: output } }, logLevel: "error" } });
  await build.build();
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const match = /^\/api\/conversations\/([^/]+)\/(draft|draft-conflicts|draft-attachments\/[^/]+)$/.exec(url.pathname);
      if (match) {
        const [, id, resource] = match;
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        const owner = body?.ownerId ?? url.searchParams.get("ownerId");
        owners.set(id, owner);
        if (resource.startsWith("draft-attachments/")) { deletedAttachments.push(id); return json(response, {}); }
        if (resource === "draft-conflicts") return json(response, workspace.listDraftConflicts(id, owner));
        if (request.method === "PUT") {
          if (!body.text) clearAttempts.push(id);
          const saved = workspace.putDraft(id, body);
          if (!body.text && holdClear) await holdClear;
          return json(response, saved);
        }
        let saved = workspace.getDraft(id, owner);
        if (id.startsWith("attachment-") && id.endsWith("-a") && !saved.revision) saved = workspace.putDraft(id, {
          text: "Photo assignment", attachmentIds: ["photo"], mentionBindings: [], expectedRevision: 0,
          clientId: "prior", ownerId: owner });
        return json(response, { ...saved, attachments: saved.attachmentIds.map(id => ({ id,
          conversationId: saved.conversationId, ownerId: owner, name: "photo.txt", mediaType: "text/plain", size: 5,
          createdAt: saved.updatedAt, downloadUrl: "/photo" })) });
      }
      if (url.pathname === "/photo") { response.writeHead(200, { "Content-Type": "text/plain" }).end("photo"); return; }
      if (url.pathname.startsWith("/api/")) return json(response, { acceptedMediaTypes: ["text/plain"], maxAssetsPerMessage: 20,
        maxFileBytes: 80 * 1024 ** 2, maxMessageBytes: 80 * 1024 ** 2 });
      const file = path.resolve(output, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      if (!file.startsWith(output + "/")) { response.writeHead(404).end(); return; }
      const content = await readFile(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content);
    } catch (error) { json(response, error.conflict ?? { error: error.message }, error.code === "DRAFT_CONFLICT" ? 409 : error.code === "ENOENT" ? 404 : 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await playwright[engine].launch({ headless: true,
    ...(engine === "chromium" ? { executablePath: process.env.PONDEROSA_CHROMIUM_PATH } : {}) });
  const scenarios = ["leave", "return-pending", "other-chat", "new-edit", "same-text-new-visit", "unsaved-edit", "failure", "stay",
    "delayed-clear", "local", "reuse", "attachment", "command-success", "command-edit", "command-failure"];
  for (const [index, scenario] of scenarios.entries()) {
    const width = index % 2 ? 390 : 1280;
    const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: width === 390 });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const id = `${scenario}-a`;
    const canonical = () => workspace.getDraft(id, owners.get(id));
    await page.goto(`http://127.0.0.1:${server.address().port}/?scenario=${scenario}${scenario === "local" ? "&local" : ""}${scenario === "reuse" ? "&reuse" : ""}`);
    const input = page.locator(".composer-editor-input");
    await input.waitFor();
    if (scenario !== "local") await page.waitForFunction(() => JSON.parse(document.body.dataset.draftCache ?? "[]").length > 0);
    if (scenario === "attachment") await input.getByText("Photo assignment", { exact: true }).waitFor();
    const submitted = scenario.startsWith("command") ? "/status" : "Submitted marketing message";
    await input.fill(submitted);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("Pending", { exact: true }).waitFor();
    const navigate = !["stay", "command-success", "command-edit", "command-failure"].includes(scenario);
    if (navigate) { await page.getByRole("button", { name: "Chat B", exact: true }).click(); await input.waitFor(); }
    const newer = scenario === "same-text-new-visit" ? submitted : "New unsent edit";
    if (["return-pending", "new-edit", "same-text-new-visit", "unsaved-edit"].includes(scenario)) {
      await page.getByRole("button", { name: "Chat A", exact: true }).click();
      await page.waitForFunction(text => document.querySelector(".composer-editor-input")?.textContent === text, submitted);
      if (scenario !== "return-pending") {
        if (scenario === "same-text-new-visit") await input.fill("Temporary new edit");
        await input.fill(newer);
        // Let the actual autosave claim a later surface incarnation before the old send completes.
        if (scenario !== "unsaved-edit") {
          await page.waitForTimeout(800);
          assert.equal(canonical().text, newer);
        }
      }
    }
    if (scenario === "other-chat") await input.fill("Chat B unsent work");
    if (scenario === "command-edit") await input.fill(newer);
    if (scenario === "delayed-clear") holdClear = new Promise(resolve => { releaseClear = resolve; });
    await page.getByRole("button", { name: scenario.endsWith("failure") ? "Fail send" : "Confirm send", exact: true }).click();
    await page.getByText(scenario.endsWith("failure") ? "Failed" : "Confirmed", { exact: true }).waitFor();
    if (scenario === "delayed-clear") {
      await page.waitForTimeout(100);
      assert.equal(canonical().text, "", "clear accepted before its response is released");
      await page.getByRole("button", { name: "Chat A", exact: true }).click();
      await page.waitForFunction(({ id, revision }) => JSON.parse(document.body.dataset.draftCache ?? "[]")
        .some(d => d.conversationId === id && d.revision === revision), { id, revision: canonical().revision });
      await input.fill(newer); await page.waitForTimeout(800);
      assert.equal(canonical().text, newer);
      releaseClear(); holdClear = undefined;
    }
    await page.waitForTimeout(200);
    if (navigate) await page.getByRole("button", { name: "Chat A", exact: true }).click();
    // Without a durable draft incarnation, do not broaden the old surface-only
    // clear into authority to erase an untracked later visit's identical text.
    const expected = scenario.endsWith("failure") || scenario === "local" ? submitted
      : ["new-edit", "same-text-new-visit", "unsaved-edit", "delayed-clear", "command-edit"].includes(scenario) ? newer : "";
    await page.waitForFunction(text => document.querySelector(".composer-editor-input")?.textContent === text, expected);
    if (scenario === "local") assert.equal(await page.evaluate(key => localStorage.getItem(key), `sent-draft-${scenario}-a`), submitted);
    else if (scenario === "unsaved-edit") {
      assert.equal(canonical().text, "", "only the confirmed old snapshot was cleared");
      assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).text,
        `sent-draft-${scenario}-a.pending-text.v1`), newer, "new typing before autosave remains recoverable");
    } else if (!scenario.startsWith("command") || scenario === "command-success") assert.equal(canonical().text, expected);
    if (scenario === "other-chat") {
      await page.getByRole("button", { name: "Chat B", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".composer-editor-input")?.textContent === "Chat B unsent work");
    }
    if (scenario === "delayed-clear") assert.equal(await page.evaluate(id => JSON.parse(document.body.dataset.draftCache).find(d => d.conversationId === id).revision, id), canonical().revision, "late clear response cannot regress the newer cache revision");
    if (scenario === "attachment") { assert.deepEqual(canonical().attachmentIds, []); assert(deletedAttachments.includes(id)); }
    if (scenario === "failure") assert(!clearAttempts.includes(id));
    if (scenario === "command-edit") assert(!clearAttempts.includes(id));
    // A complete reload must not resurrect the sent snapshot either.
    if (scenario === "other-chat") await page.getByRole("button", { name: "Chat A", exact: true }).click();
    await page.reload(); await input.waitFor();
    await page.waitForFunction(text => document.querySelector(".composer-editor-input")?.textContent === text, expected);
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine} ${width}px ${scenario}`); await page.close();
  }
} finally {
  releaseClear?.(); await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(temporary, { recursive: true, force: true });
}
