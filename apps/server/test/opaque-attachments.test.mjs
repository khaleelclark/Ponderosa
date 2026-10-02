import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { AssetStore, prepareAssetUpload } from "../dist/assets.js";
import { registerAttachmentRoutes } from "../dist/routes/attachments.js";
import { registerBodyParsers } from "../dist/server-request-hooks.js";
import { WorkspaceStore } from "@ponderosa/agents";
import { DraftService, registerDraftRoutes } from "../dist/routes/drafts.js";
import { runtimeAttachmentName } from "../dist/routes/agent-run-preparation.js";

test("opaque fonts and arbitrary formats retain original bytes through scoped HTTP, association, runtime reads and reopening", async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-opaque-"));
  const assets = new AssetStore(dataDir, { portableFiles: true }), app = Fastify();
  t.after(async () => { await app.close(); assets.close(); await rm(dataDir, { recursive: true, force: true }); });
  const projectId = randomUUID(), agentId = randomUUID(), chatId = randomUUID(), otherChatId = randomUUID();
  registerBodyParsers(app);
  registerAttachmentRoutes(app, { store: { getAgent: id => id === agentId ? { id, projectId } : undefined,
    getConversation: id => [chatId, otherChatId].includes(id) ? { id, projectId } : undefined }, assets,
    agentDeliveryLeases: new Map(), conversationDeliveryLeases: new Map(), conversationDeletionInProgress: () => false,
    agentDeletionInProgress: () => false, deletingAttachmentKeys: new Set(), reconcilingAssetAgentIds: new Set() });
  for (const [name, type, body] of [
    ["Regular.ttf", "font/ttf", Buffer.from([0, 1, 0, 0, 0, 4, 9])],
    ["Bold.otf", "font/otf", Buffer.from("OTTO\0font fixture")],
    ["Web.woff", "font/woff", Buffer.from("wOFF\0font fixture")],
    ["Web.woff2", "font/woff2", Buffer.from("wOF2\0font fixture")],
    ["source.ts", "text/plain", Buffer.from("export const value = 42;")],
    ["script.py", "text/x-python", Buffer.from("print('explicitly attached, not executed')\n")],
    ["module.py", "application/x-python-code", Buffer.from("value = 42\n")],
    ["empty-mime.py", "", Buffer.from("# original Python source\n")],
    ["sheet.xlsx", "application/zip", Buffer.from("PK\x03\x04\0opaque fixture")],
    ["sound.wav", "audio/wav", Buffer.from("RIFF\0audio fixture")],
    ["custom.bin", "application/octet-stream", Buffer.from([0, 255, 4, 8])],
    ["case.bin", "APPLICATION/OCTET-STREAM; charset=binary", Buffer.from([0, 255, 4, 8])],
  ]) {
    for (const [owner, surface] of [[chatId, "conversations"], [agentId, "agents"]]) {
      const upload = await app.inject({ method: "POST", url: `/api/${surface}/${owner}/attachments`,
        headers: { "content-type": "application/x-ponderosa-attachment", "x-ponderosa-filename": name, "x-ponderosa-media-type": type }, payload: body });
      assert.equal(upload.statusCode, 201, upload.body);
      const asset = upload.json(); assert.equal(asset.mediaType, "application/octet-stream"); assert.equal(asset.previewUrl, undefined);
      assert.equal(asset.sha256, createHash("sha256").update(body).digest("hex"));
      const download = await app.inject({ method: "GET", url: asset.downloadUrl });
      assert.deepEqual(download.rawPayload, body); assert.match(download.headers["content-disposition"], /^attachment;/);
      assert.equal(download.headers["content-type"], "application/octet-stream"); assert.equal(download.headers["x-content-type-options"], "nosniff");
      assert.equal((await app.inject({ method: "GET", url: `/api/conversations/${otherChatId}/assets/${asset.id}/download` })).statusCode, 404);
      await assets.associate(projectId, owner, [asset.id]);
      const runtime = assets.authoritativeRuntimeAttachment(projectId, owner, asset.id);
      assert.equal(runtime.attachment.name, name); assert.deepEqual(await readFile(runtime.localPath), body);
      assert(runtimeAttachmentName(runtime.attachment).endsWith(`-${name}`));
      assert.equal(assets.authoritativeRuntimeAttachment(randomUUID(), owner, asset.id), undefined);
      const reopened = new AssetStore(dataDir, { portableFiles: true });
      try { assert.deepEqual((await reopened.content(projectId, owner, asset.id, false)).body, body); }
      finally { reopened.close(); }
    }
  }
});

test("opaque font drafts preserve bytes and owner scope through restoration and prepared promotion", async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-font-draft-"));
  const assets = new AssetStore(dataDir, { portableFiles: true }), workspace = new WorkspaceStore(dataDir);
  const store = { getAgent: () => undefined, getConversation: id => id === "chat-a" ? { id } : undefined };
  const drafts = new DraftService(dataDir, store, workspace, assets), app = Fastify();
  t.after(async () => { await app.close(); assets.close(); await rm(dataDir, { recursive: true, force: true }); });
  registerBodyParsers(app); registerDraftRoutes(app, drafts, workspace, 8, () => undefined);
  const body = Buffer.from([0, 1, 0, 0, 255, 7]);
  const upload = await app.inject({ method: "POST", url: "/api/conversations/chat-a/draft-attachments",
    headers: { "content-type": "application/x-ponderosa-attachment", "x-ponderosa-draft-owner": "browser-one", "x-ponderosa-filename": "Family.ttf", "x-ponderosa-media-type": "font/ttf" }, payload: body });
  assert.equal(upload.statusCode, 201, upload.body); const attachment = upload.json();
  assert.equal(attachment.mediaType, "application/octet-stream"); assert.equal(attachment.previewUrl, undefined);
  assert.deepEqual((await app.inject({ method: "GET", url: attachment.downloadUrl })).rawPayload, body);
  assert.equal((await app.inject({ method: "GET", url: attachment.downloadUrl.replace("browser-one", "browser-two") })).statusCode, 404);
  const restoredService = new DraftService(dataDir, store, workspace, assets);
  const restored = await restoredService.prepared("chat-a", "browser-one", attachment.id); assert(restored);
  const asset = await assets.stage({ projectId: "project-a", agentId: "agent-a", body: restored.body, prepared: restored.prepared });
  assert.deepEqual((await assets.content("project-a", "agent-a", asset.id, false)).body, body);
  assert.equal(assets.authoritativeRuntimeAttachment("project-a", "agent-a", asset.id).attachment.name, "Family.ttf");
});

test("opaque admission cannot bypass protected format suffixes, spoof preview MIME, or exceed byte budgets", async () => {
  const binary = Buffer.from([0, 255, 1, 7]);
  for (const name of ["image.png", "image.jpg", "image.webp", "image.gif", "image.avif", "image.heic", "report.pdf", "report.docx", "data.json", "notes.txt", "archive.zip"]) {
    await assert.rejects(prepareAssetUpload({ body: binary, name, declaredType: "application/octet-stream" }), error => error.statusCode === 415, name);
  }
  for (const declaredType of ["image/png", "image/jpeg", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]) {
    await assert.rejects(prepareAssetUpload({ body: binary, name: "font.ttf", declaredType }), error => error.statusCode === 415);
  }
  await assert.rejects(prepareAssetUpload({ body: Buffer.alloc(80 * 1024 * 1024 + 1), name: "large.ttf" }), error => error.statusCode === 413);
});
