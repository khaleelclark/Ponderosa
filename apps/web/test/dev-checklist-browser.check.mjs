import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { createServer } from "../../server/dist/app.js";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const { AgentStore, WorkspaceStore } = require("@ponderosa/agents");
const playwright = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const engine = process.env.PONDEROSA_TEST_BROWSER ?? "chromium";
const beforeFix = process.env.PONDEROSA_EXPECT_CHECKLIST_GAPS === "1";
const web = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "dev-checklist-browser-"));
const output = path.join(temporary, "web"), data = path.join(temporary, "data");
const pdfjsRoot = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
let browser, app;
const store = new AgentStore(data);
new WorkspaceStore(data).updatePreferences({ defaultEngine: "codex", providerAvailability: { codex: true } });

function pdf() {
  const text = "BT /F1 24 Tf 30 100 Td (Exact Chat PDF preview) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  let body = "%PDF-1.4\n"; const offsets = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, "test/dev-checklist-browser-entry.tsx") } },
    output: { distPath: { root: output }, copy: [
      { from: path.join(pdfjsRoot, "cmaps"), to: "static/pdfjs/6.3.289/cmaps" },
      { from: path.join(pdfjsRoot, "standard_fonts"), to: "static/pdfjs/6.3.289/standard_fonts" },
    ] }, logLevel: "error" } });
  await build.build();
  const project = store.createProject({ label: "Disposable checklist", hostPath: temporary, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Checklist Chat" });
  const other = store.createConversation(project.id, { title: "Wrong Chat" });
  const otherAgent = store.createAgent(project.id, { title: "Wrong owner", engine: "codex", conversationId: other.id });
  const adapter = { id: "codex", displayName: "Synthetic", listModels: () => [], listEfforts: () => [] };
  app = createServer({ dataDir: data, store, webDist: output, engines: [{ adapter, authStatus: async () => ({ authenticated: true }) }], logger: false, startDrained: true });
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  const engineStatus = await app.inject("/api/engines");
  console.log(JSON.stringify({ fixtureEngines: engineStatus.json().map(engine => ({ id: engine.id, authentication: engine.authentication, enabled: engine.enabled, intakeReady: engine.intakeReady })) }));
  const bytes = pdf(), font = Buffer.from("inert opaque font bytes");
  const attachments = [];
  for (const [name, mediaType, body] of [["report.pdf", "application/pdf", bytes], ["font.ttf", "font/ttf", font]]) {
    const uploaded = await app.inject({ method: "POST", url: `/api/conversations/${chat.id}/draft-attachments`,
      headers: { "content-type": "application/octet-stream", "x-ponderosa-filename": name,
        "x-ponderosa-media-type": mediaType, "x-ponderosa-draft-owner": "checklist-owner" }, payload: body });
    assert.equal(uploaded.statusCode, 201, uploaded.body); attachments.push(uploaded.json().id);
  }
  const created = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agents`,
    payload: { title: "Boston", engine: "codex", conversationId: chat.id, initialMessage: "#new-agent exact browser opening",
      draftAttachmentIds: attachments, draftOwnerId: "checklist-owner", idempotencyKey: "checklist-opening" } });
  assert.equal(created.statusCode, 200, created.body);
  const agent = created.json();
  for (const [openingAgent, canonicalChat, marker] of [
    [otherAgent, chat.id, "wrong canonical owner opening"],
  ]) {
    const event = { eventId: `agent-opening:${openingAgent.id}`, schemaVersion: 2, projectId: project.id,
      conversationId: canonicalChat, sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id }, text: `#new-agent ${marker}`, createdAt: new Date().toISOString() };
    store.appendCommunicationEvent(event);
    store.appendCommunicationProjection(project.id, { eventId: event.eventId, surface: "conversation", projectionKey: chat.id,
      projectedAt: event.createdAt, message: { messageId: event.eventId, role: "user", createdAt: event.createdAt } });
  }
  // Passive synthetic reply gives All Messages a real, explicit reply target.
  // This is fixture data, not evidence that a provider consumed the opening.
  const reply = { eventId: "checklist-synthetic-reply", schemaVersion: 2, projectId: project.id,
    conversationId: chat.id, sender: { kind: "agent", agentId: agent.id }, intent: "broadcast",
    audience: { kind: "organization", organizationId: project.id }, text: "Synthetic reply for recovery checks", createdAt: new Date().toISOString() };
  store.appendCommunicationEvent(reply);
  store.appendCommunicationProjection(project.id, { eventId: reply.eventId, surface: "conversation", projectionKey: chat.id,
    projectedAt: reply.createdAt, message: { messageId: reply.eventId, role: "assistant", authorAgentId: agent.id, createdAt: reply.createdAt } });
  const allItems = (await app.inject("/api/all-chat")).json().items;
  assert(allItems.some(item => item.communicationEventId === reply.eventId && item.directMessageAgent?.id === agent.id), "synthetic reply must be a real explicit All Messages target");
  const getOpening = async () => {
    const response = await app.inject(`/api/conversations/${chat.id}`); assert.equal(response.statusCode, 200, response.body);
    return response.json().messages.find(message => message.communicationEventId === `agent-opening:${agent.id}`);
  };
  const opening = await getOpening(); assert(opening);
  const pdfAttachment = opening.attachments.find(attachment => attachment.name === "report.pdf"); assert(pdfAttachment);
  assert.equal(pdfAttachment.previewUrl, undefined, "PDF uses the canonical download URL, not an image preview");
  const original = await app.inject(pdfAttachment.downloadUrl); assert.equal(original.statusCode, 200); assert.deepEqual(original.rawPayload, bytes);
  const wrongScopeUrl = pdfAttachment.downloadUrl.replace(`/agents/${agent.id}/`, `/agents/${otherAgent.id}/`);
  assert.notEqual(wrongScopeUrl, pdfAttachment.downloadUrl);
  const wrongChat = await app.inject(wrongScopeUrl); assert.equal(wrongChat.statusCode, 404);
  browser = await playwright[engine].launch({ headless: true,
    executablePath: engine === "chromium" ? process.env.PONDEROSA_CHROMIUM_PATH : process.env.PONDEROSA_WEBKIT_PATH });
  const errors = [];
  for (const width of [320, 390, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 932 } });
    page.on("pageerror", error => { errors.push(error.message); });
    const url = `${origin}/?${new URLSearchParams({ chat: chat.id, agent: agent.id })}`;
    await page.goto(url);
    if (!beforeFix) {
      for (const marker of ["wrong canonical owner opening"]) {
        const invalidOpening = page.getByRole("article").filter({ hasText: marker }); await invalidOpening.waitFor();
        assert.equal(await invalidOpening.getByRole("button", { name: /Open agent/ }).count(), 0, "wrong-owner opening has no navigation");
      }
    }
    const article = page.getByRole("article").filter({ hasText: "exact browser opening" }); await article.waitFor();
    const mention = article.getByRole("button", { name: /Open agent/ });
    assert.equal(await mention.count(), beforeFix ? 0 : 1, "actual HTTP opening resolves to exactly one clickable Agent");
    if (!beforeFix) { await mention.click(); assert.equal(await page.locator("body").getAttribute("data-opened-agent"), agent.id); }
    assert.equal(await article.getByRole("button", { name: "Preview font.ttf", exact: true }).count(), 0);
    const preview = article.getByRole("button", { name: "Preview report.pdf", exact: true });
    assert.equal(await preview.count(), beforeFix ? 0 : 1, "PDF card exposes the existing bounded viewer");
    if (!beforeFix) {
      for (let cycle = 0; cycle < 2; cycle++) {
        await preview.click();
        const dialog = page.getByRole("dialog");
        const canvas = dialog.locator('canvas[aria-label="report.pdf, page 1"]'); await canvas.waitFor();
        await page.waitForFunction(() => {
          const canvas = document.querySelector('canvas[aria-label="report.pdf, page 1"]');
          return canvas?.width > 0 && [...canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data]
            .some((value, index) => index % 4 !== 3 && value < 200);
        });
        assert.equal(await dialog.locator("iframe, object, embed").count(), 0, "no active embedded document");
        assert.match(await dialog.innerText(), /Exact Chat PDF preview/);
        const bounds = await dialog.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= width);
        if (cycle === 0) await page.screenshot({ path: path.join(tmpdir(), `dev-checklist-${engine}-pdf-${width}.png`) });
        await dialog.getByRole("button", { name: "Close attachment preview" }).click(); await dialog.waitFor({ state: "hidden" });
        assert(await preview.evaluate(node => node === document.activeElement), "closing restores focus");
      }
      await page.reload(); await mention.waitFor(); assert.equal(await article.count(), 1, "reloading preserves one opening");
      await page.goto(`${url}&surface=all`);
      for (const marker of ["wrong canonical owner opening"]) {
        const invalidOpening = page.getByRole("article").filter({ hasText: marker }); await invalidOpening.waitFor();
        assert.equal(await invalidOpening.getByRole("button", { name: /Open agent/ }).count(), 0, "All Messages cannot navigate a wrong-owner opening");
      }
      const allValid = page.getByRole("article").filter({ hasText: "exact browser opening" });
      await allValid.getByRole("button", { name: /Open agent/ }).click();
      assert.equal(await page.locator("body").getAttribute("data-opened-agent"), agent.id);
    }
    console.log(`Checked opening/PDF at ${width}px`);
    await page.close();
  }
  // Fail at the transport boundary: no canonical intake, provider or live data.
  const authority = () => ({ communications: store.readCommunicationEvents(project.id),
    runs: store.sqlite.prepare("SELECT count(*) n FROM scheduler_runs").get().n,
    intakes: store.sqlite.prepare("SELECT count(*) n FROM runtime_communications").get().n,
    creations: store.sqlite.prepare("SELECT count(*) n FROM agent_creation_operations").get().n });
  const acceptedAuthority = authority();
  for (const surface of ["project", "agent", "all"]) {
    console.log(`Checking failed send in ${surface}`);
    const page = await browser.newPage({ viewport: { width: 390, height: 932 }, hasTouch: true });
    page.on("pageerror", error => { errors.push(error.message); });
    await page.route("**/api/**", async route => {
      if (route.request().method() === "POST" && /\/(messages|direct-messages|agents)$/.test(new URL(route.request().url()).pathname)) {
        return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Exact checklist rejection." }) });
      }
      await route.continue();
    });
    const draftLoaded = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/draft") && response.request().method() === "GET" && response.status() === 200).catch(error => error);
    await page.goto(`${origin}/?${new URLSearchParams({ chat: chat.id, agent: agent.id, surface })}`);
    if (surface === "all") await page.getByRole("button", { name: "Reply to Boston", exact: true }).click().catch(async error => {
      console.error(`All Messages fixture state: ${await page.locator("body").innerText()}`); throw error;
    });
    const loaded = await draftLoaded; assert(!(loaded instanceof Error), `${surface}: draft must finish loading`);
    const input = page.locator(".composer-editor-input"); await input.waitFor();
    if (surface === "all") {
      // Preserve the structural recipient established by Reply. Replacing the
      // whole editor would intentionally clear that routing authority.
      await input.press("End");
      await page.keyboard.insertText(" Recover this exact draft\nwith its second line");
    } else await input.fill(`${surface === "agent" ? "" : "#Boston "}Recover this exact draft\nwith its second line`);
    const recoveryName = `recovery-${surface}.txt`;
    const recoveryBytes = Buffer.from("exact recovery attachment bytes");
    const uploadedRecovery = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/draft-attachments") && response.request().method() === "POST" && response.status() === 201);
    await page.getByLabel("Choose files", { exact: true }).setInputFiles({ name: recoveryName, mimeType: "text/plain", buffer: recoveryBytes });
    const retainedFile = await (await uploadedRecovery).json();
    const recoveryFile = page.getByRole("button", { name: `Remove ${recoveryName}`, exact: true });
    await recoveryFile.waitFor();
    await page.getByRole("button", { name: "Send message", exact: true }).click().catch(async error => {
      console.error(`${surface} send fixture state: ${await page.locator("body").innerText()}`); throw error;
    });
    const rejection = page.getByRole("alert").filter({ hasText: "Exact checklist rejection." }); await rejection.first().waitFor();
    assert.equal(await rejection.count(), beforeFix ? 2 : 1, `${surface}: one owner for the failed-send notice`);
    assert.match(await input.innerText(), /Recover this exact draft\nwith its second line/);
    await recoveryFile.waitFor();
    assert.equal(await recoveryFile.count(), 1, "failed send retains one attachment");
    const recoveredBytes = await page.request.get(origin + retainedFile.downloadUrl);
    assert.equal(recoveredBytes.status(), 200); assert.deepEqual(await recoveredBytes.body(), recoveryBytes, "exact draft attachment bytes remain recoverable");
    assert.deepEqual(authority(), acceptedAuthority, "rejected sends cannot create canonical messages, intakes, Runs or Agents");
    await page.screenshot({ path: path.join(tmpdir(), `dev-checklist-${engine}-error-${surface}.png`) });
    if (!beforeFix) {
      await rejection.getByRole("button", { name: "Close", exact: true }).click();
      assert.equal(await page.getByRole("alert").filter({ hasText: "Exact checklist rejection." }).count(), 0, "one dismissal clears the error");
      assert.match(await input.innerText(), /Recover this exact draft/);
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: ${beforeFix ? "reproduced three original gaps" : "actual creation/draft/association/read/download routes, clickable opening after reload, painted inert scoped PDF and single recoverable send errors"}; disposable drained backend only, 320/390/768/1440px`);
} finally {
  await browser?.close(); if (app) { app.prepareForShutdown(); await app.close(); } store.close();
  await rm(temporary, { recursive: true, force: true });
}
