import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import test from "node:test";
import Fastify from "fastify";
import { AssetStore, prepareAssetUpload } from "../dist/assets.js";
import { registerAttachmentRoutes } from "../dist/routes/attachments.js";
import { registerBodyParsers } from "../dist/server-request-hooks.js";

const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// A real, uncompressed OOXML package; no parser or extraction is needed by upload admission.
function document() {
  const entries = [
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ["_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ["word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX upload regression</w:t></w:r></w:p></w:body></w:document>'],
  ];
  const local = [], central = []; let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), body = Buffer.from(text), crc = crc32(body);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(body.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, body); central.push(directory, filename); offset += header.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test("DOCX admission keeps bytes opaque, handles browser MIME variants and rejects non-ZIP content", async () => {
  const body = document();
  for (const declaredType of [mime, "application/zip", "application/octet-stream", undefined]) {
    const prepared = await prepareAssetUpload({ body, name: "Report.DOCX", declaredType });
    assert.equal(prepared.mediaType, mime);
    assert.equal(prepared.preview, undefined);
  }
  await assert.rejects(prepareAssetUpload({ body: Buffer.from("not a Word document"), name: "fake.docx", declaredType: mime }), /must agree/u);
  await assert.rejects(prepareAssetUpload({ body, name: "report.docm", declaredType: mime }), /must agree/u);
  await assert.rejects(prepareAssetUpload({ body, name: "report.zip", declaredType: mime }), /must agree/u);
  assert.equal((await prepareAssetUpload({ body, name: "archive.zip", declaredType: "application/zip" })).mediaType, "application/zip");
});

for (const portableFiles of process.platform === "linux" ? [true, false] : [true]) {
  test(`DOCX uploads, associates, survives reopening and downloads in both Chat and Agent scopes (portable=${portableFiles})`, async (t) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-docx-"));
    const assets = new AssetStore(dataDir, { portableFiles }), app = Fastify();
    t.after(async () => { await app.close(); assets.close(); await rm(dataDir, { recursive: true, force: true }); });
    const projectId = randomUUID(), agentId = randomUUID(), chatId = randomUUID(), otherChatId = randomUUID();
    const store = { getAgent: id => id === agentId ? { id, projectId } : undefined,
      getConversation: id => [chatId, otherChatId].includes(id) ? { id, projectId } : undefined };
    registerBodyParsers(app);
    registerAttachmentRoutes(app, { store, assets, agentDeliveryLeases: new Map(), conversationDeliveryLeases: new Map(),
      conversationDeletionInProgress: () => false, agentDeletionInProgress: () => false,
      deletingAttachmentKeys: new Set(), reconcilingAssetAgentIds: new Set() });
    const body = document();
    for (const [ownerId, surface] of [[chatId, "conversations"], [agentId, "agents"]]) {
      const upload = await app.inject({ method: "POST", url: `/api/${surface}/${ownerId}/attachments`,
        headers: { "content-type": "application/x-ponderosa-attachment", "x-ponderosa-filename": "report.docx", "x-ponderosa-media-type": mime }, payload: body });
      assert.equal(upload.statusCode, 201, upload.body);
      const asset = upload.json(); assert.equal(asset.mediaType, mime); assert.equal(asset.previewUrl, undefined);
      const download = await app.inject({ method: "GET", url: asset.downloadUrl });
      assert.equal(download.statusCode, 200); assert.deepEqual(download.rawPayload, body);
      assert.match(download.headers["content-disposition"], /attachment;.*report\.docx/u);
      assert.equal(download.headers["content-type"], "application/octet-stream");
      assert.equal((await app.inject({ method: "GET", url: `/api/conversations/${otherChatId}/assets/${asset.id}/download` })).statusCode, 404);
      assert.equal((await assets.associate(projectId, ownerId, [asset.id]))[0].state, "associated");
      const authoritative = assets.authoritativeRuntimeAttachment(projectId, ownerId, asset.id);
      assert.equal(authoritative?.attachment.name, "report.docx"); assert.equal(authoritative?.attachment.mediaType, mime);
      assert.deepEqual(await readFile(authoritative.localPath), body);
      assert.equal(assets.authoritativeRuntimeAttachment(randomUUID(), ownerId, asset.id), undefined);
      const reopened = new AssetStore(dataDir, { portableFiles });
      try { assert.deepEqual((await reopened.content(projectId, ownerId, asset.id, false))?.body, body); }
      finally { reopened.close(); }
    }
  });
}
