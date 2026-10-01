import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import sharp from "sharp";
import { WorkspaceStore } from "@ponderosa/agents";
import { AssetStore, prepareAssetUpload } from "../dist/assets.js";
import { hasSamsungScreenshotTrailer } from "../dist/jpeg-container.js";
import { registerAttachmentRoutes } from "../dist/routes/attachments.js";
import { DraftService, registerDraftRoutes } from "../dist/routes/drafts.js";
import { registerBodyParsers } from "../dist/server-request-hooks.js";

// Synthetic capture metadata mirrors the phone's SEF structure. No user's
// screenshots, health information, or captured application identity is retained.
function screenshot(jpeg, fields = [
  [0x0c51, "Samsung_Capture_Info", Buffer.from("Screenshot")],
  [0x0da1, "Captured_App_Info", Buffer.from(Buffer.from(JSON.stringify({ comp: "example.test/.MainActivity" })).toString("base64"))],
]) {
  const blocks = fields.map(([type, name, value]) => {
    const header = Buffer.alloc(8), bytes = Buffer.from(name);
    header.writeUInt16LE(type, 2); header.writeUInt32LE(bytes.length, 4);
    return Buffer.concat([header, bytes, value]);
  });
  const directory = Buffer.alloc(12 + 12 * fields.length);
  directory.write("SEFH"); directory.writeUInt32LE(107, 4); directory.writeUInt32LE(fields.length, 8);
  let back = blocks.reduce((sum, block) => sum + block.length, 0);
  blocks.forEach((block, index) => {
    const entry = 12 + 12 * index;
    block.copy(directory, entry, 0, 4);
    directory.writeUInt32LE(back, entry + 4); directory.writeUInt32LE(block.length, entry + 8);
    back -= block.length;
  });
  const footer = Buffer.alloc(8); footer.writeUInt32LE(directory.length); footer.write("SEFT", 4);
  return Buffer.concat([jpeg, ...blocks, directory, footer]);
}

const jpeg = await sharp({ create: { width: 24, height: 32, channels: 3, background: "#123456" } }).jpeg().toBuffer();
const body = screenshot(jpeg);
function screenshotWithAppInfo(image, value) {
  return screenshot(image, [
    [0x0c51, "Samsung_Capture_Info", Buffer.from("Screenshot")],
    [0x0da1, "Captured_App_Info", value],
  ]);
}
const plainPackageBody = screenshotWithAppInfo(jpeg, Buffer.from("example.browser"));
const screenshotBodies = [body, plainPackageBody];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const directory = body.length - 8 - body.readUInt32LE(body.length - 8);

test("Samsung screenshot metadata is admitted unchanged and produces the same safe preview", async () => {
  for (const image of [jpeg, await sharp(jpeg).jpeg({ progressive: true }).toBuffer()]) {
    for (const declaredType of ["image/jpeg", "application/octet-stream", undefined]) {
      const bytes = screenshot(image);
      const prepared = await prepareAssetUpload({ body: bytes, name: "Screenshot.jpg", declaredType });
      assert.equal(prepared.mediaType, "image/jpeg"); assert.equal(prepared.sha256, hash(bytes));
      assert.equal(prepared.width, 24); assert.equal(prepared.height, 32);
      const plain = await prepareAssetUpload({ body: image, name: "Screenshot.jpg", declaredType });
      assert.deepEqual(prepared.preview, plain.preview);
    }
  }
  assert.equal(hasSamsungScreenshotTrailer(screenshot(jpeg, [[0x0c51, "Samsung_Capture_Info", Buffer.from("Screenshot")]])), true);
  // FF D9 inside an APP segment must not be mistaken for the actual JPEG end.
  const app = Buffer.from([0xff, 0xe2, 0, 4, 0xff, 0xd9]);
  assert.equal(hasSamsungScreenshotTrailer(screenshot(Buffer.concat([jpeg.subarray(0, 2), app, jpeg.subarray(2)]))), true);
});

test("malformed Samsung trailers, unknown payloads, and arbitrary appended data still fail closed", async () => {
  const mutate = change => { const bytes = Buffer.from(body); change(bytes); return bytes; };
  const cases = [
    ["arbitrary data", Buffer.concat([jpeg, Buffer.from("not Samsung metadata")])],
    ["bad footer", mutate(b => b[b.length - 1] = 0)],
    ["non-ASCII footer", mutate(b => b[b.length - 1] |= 0x80)],
    ["non-ASCII header", mutate(b => b[directory] |= 0x80)],
    ["unbounded directory", mutate(b => b.writeUInt32LE(0xffffffff, b.length - 8))],
    ["unbounded count", mutate(b => b.writeUInt32LE(0xffffffff, directory + 8))],
    ["unsupported version", mutate(b => b.writeUInt32LE(108, directory + 4))],
    ["offset outside file", mutate(b => b.writeUInt32LE(0xffffffff, directory + 16))],
    ["overlap directory", mutate(b => b.writeUInt32LE(0xffffffff, directory + 20))],
    ["overlap JPEG", mutate(b => b.writeUInt32LE(directory - 2, directory + 16))],
    ["entry type mismatch", mutate(b => b.writeUInt16LE(0x0c52, directory + 14))],
    ["name length overflow", mutate(b => b.writeUInt32LE(0xffffffff, jpeg.length + 4))],
    ["unknown field", screenshot(jpeg, [[0x0c52, "Samsung_Capture_Info", Buffer.from("Screenshot")]])],
    ["unknown name", screenshot(jpeg, [[0x0c51, "Other_Metadata", Buffer.from("Screenshot")]])],
    ["unknown capture value", screenshot(jpeg, [[0x0c51, "Samsung_Capture_Info", Buffer.from("MotionPhoto")]])],
    ["duplicate field", screenshot(jpeg, [[0x0c51, "Samsung_Capture_Info", Buffer.from("Screenshot")], [0x0c51, "Samsung_Capture_Info", Buffer.from("Screenshot")]])],
    ["missing capture field", screenshot(jpeg, [[0x0da1, "Captured_App_Info", Buffer.from("e30=")]])],
    ["invalid app info", screenshot(jpeg, [[0x0c51, "Samsung_Capture_Info", Buffer.from("Screenshot")], [0x0da1, "Captured_App_Info", Buffer.from("not base64")]])],
    ["non-ASCII app info", mutate(b => b[jpeg.length + 38 + 25] |= 0x80)],
    ["oversized app info", screenshot(jpeg, [[0x0c51, "Samsung_Capture_Info", Buffer.from("Screenshot")], [0x0da1, "Captured_App_Info", Buffer.alloc(9000, 65)]])],
    ["unaccounted gap", screenshot(Buffer.concat([jpeg, Buffer.from("hidden payload")]))],
    ["forged second EOI", screenshot(Buffer.concat([jpeg, Buffer.from("hidden payload"), Buffer.from([0xff, 0xd9])]))],
    ["invalid JPEG", screenshot(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))],
    ["truncated JPEG", screenshot(jpeg.subarray(0, jpeg.length - 2))],
    ["truncated trailer", body.subarray(0, body.length - 1)],
  ];
  for (const [name, bytes] of cases) {
    await assert.rejects(prepareAssetUpload({ body: bytes, name: "Screenshot.jpg", declaredType: "image/jpeg" }),
      error => error.statusCode === 415, name);
  }
  await assert.rejects(prepareAssetUpload({ body, name: "Screenshot.png", declaredType: "image/jpeg" }), /must agree/u);
  await assert.rejects(prepareAssetUpload({ body, name: "Screenshot.jpg", declaredType: "image/png" }), /must agree/u);
  for (let length = 0; length < body.length; length++) {
    assert.doesNotThrow(() => hasSamsungScreenshotTrailer(body.subarray(0, length)));
  }
});

test("plain Samsung app package names are admitted only as bounded ASCII package identifiers", async () => {
  for (const image of [jpeg, await sharp(jpeg).jpeg({ progressive: true }).toBuffer()]) {
    for (const name of ["example.browser", "org.Example_Test.browser2", "com." + "a".repeat(1020)]) {
      for (const declaredType of ["image/jpeg", "application/octet-stream", undefined]) {
        const bytes = screenshotWithAppInfo(image, Buffer.from(name));
        assert.equal(hasSamsungScreenshotTrailer(bytes), true);
        const prepared = await prepareAssetUpload({ body: bytes, name: "Screenshot.jpg", declaredType });
        const plain = await prepareAssetUpload({ body: image, name: "Screenshot.jpg", declaredType });
        assert.equal(prepared.sha256, hash(bytes));
        assert.deepEqual(prepared.preview, plain.preview);
      }
    }
  }
  const invalid = ["", "browser", "com..browser", ".com.browser", "com.browser.",
    "com.1browser", "com.browser\n", "com.browser\r\n", "com.browser\0", "com.browsér",
    "com.browser/Activity", "com.browser;payload", "https://example.browser", "com.browser extra",
    "com." + "a".repeat(1021)];
  // Keep the original encoded-JSON path strict too: malformed data must not
  // become a package name just because this additional representation exists.
  const malformedEncoded = [
    Buffer.from([0xff, 0xfe]).toString("base64"),
    Buffer.from('{"comp":').toString("base64"),
    Buffer.from('{"comp":"example.browser","extra":true}').toString("base64"),
    Buffer.from('{"comp":42}').toString("base64"),
    Buffer.from('{"comp":""}').toString("base64"),
  ];
  for (const value of [...invalid, ...malformedEncoded]) {
    const bytes = screenshotWithAppInfo(jpeg, Buffer.from(value));
    assert.equal(hasSamsungScreenshotTrailer(bytes), false, JSON.stringify(value));
    await assert.rejects(prepareAssetUpload({ body: bytes, name: "Screenshot.jpg", declaredType: "image/jpeg" }),
      error => error.statusCode === 415);
  }
});

test("Samsung originals survive Agent and Chat upload, association, restart, preview and scoped download", async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-samsung-assets-"));
  const assets = new AssetStore(dataDir, { portableFiles: true }), app = Fastify();
  t.after(async () => { await app.close(); assets.close(); await rm(dataDir, { recursive: true, force: true }); });
  const projectId = randomUUID(), agentId = randomUUID(), chatId = randomUUID(), otherChatId = randomUUID();
  const store = { getAgent: id => id === agentId ? { id, projectId } : undefined,
    getConversation: id => [chatId, otherChatId].includes(id) ? { id, projectId } : undefined };
  registerBodyParsers(app);
  registerAttachmentRoutes(app, { store, assets, agentDeliveryLeases: new Map(), conversationDeliveryLeases: new Map(),
    conversationDeletionInProgress: () => false, agentDeletionInProgress: () => false,
    deletingAttachmentKeys: new Set(), reconcilingAssetAgentIds: new Set() });
  for (const body of screenshotBodies) for (const [ownerId, surface] of [[agentId, "agents"], [chatId, "conversations"]]) {
    const upload = await app.inject({ method: "POST", url: `/api/${surface}/${ownerId}/attachments`,
      headers: { "content-type": "application/x-ponderosa-attachment", "x-ponderosa-filename": "Screenshot.jpg", "x-ponderosa-media-type": "image/jpeg" }, payload: body });
    assert.equal(upload.statusCode, 201, upload.body);
    const asset = upload.json(); assert.equal((await assets.read(projectId, ownerId, asset.id)).sha256, hash(body));
    const download = await app.inject({ method: "GET", url: asset.downloadUrl });
    assert.equal(download.statusCode, 200); assert.deepEqual(download.rawPayload, body);
    assert.equal(download.headers["content-type"], "application/octet-stream");
    assert.match(download.headers["content-disposition"], /^attachment;/u);
    const preview = await app.inject({ method: "GET", url: asset.previewUrl });
    assert.equal(preview.statusCode, 200); assert.equal((await sharp(preview.rawPayload).metadata()).format, "png");
    assert.equal((await app.inject({ method: "GET", url: `/api/conversations/${otherChatId}/assets/${asset.id}/download` })).statusCode, 404);
    assert.equal((await assets.associate(projectId, ownerId, [asset.id]))[0].state, "associated");
    assert.equal(assets.authoritativeRuntimeAttachment(projectId, ownerId, asset.id)?.attachment.sha256, hash(body));
    assert.equal(assets.authoritativeRuntimeAttachment(randomUUID(), ownerId, asset.id), undefined);
    const reopened = new AssetStore(dataDir, { portableFiles: true });
    try { assert.deepEqual((await reopened.content(projectId, ownerId, asset.id, false))?.body, body); }
    finally { reopened.close(); }
  }
});

test("durable draft uploads preserve the Samsung original and promote the validated preview", async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-samsung-draft-"));
  const assets = new AssetStore(dataDir, { portableFiles: true }), workspace = new WorkspaceStore(dataDir);
  const drafts = new DraftService(dataDir, { getAgent: () => undefined, getConversation: id => id === "chat-a" ? { id } : undefined }, workspace, assets);
  const app = Fastify();
  t.after(async () => { await app.close(); assets.close(); await rm(dataDir, { recursive: true, force: true }); });
  registerBodyParsers(app); registerDraftRoutes(app, drafts, workspace, 8, () => undefined);
  for (const body of screenshotBodies) {
    const upload = await app.inject({ method: "POST", url: "/api/conversations/chat-a/draft-attachments",
      headers: { "content-type": "application/x-ponderosa-attachment", "x-ponderosa-draft-owner": "browser-one", "x-ponderosa-filename": "Screenshot.jpg", "x-ponderosa-media-type": "image/jpeg" }, payload: body });
    assert.equal(upload.statusCode, 201, upload.body);
    const attachment = upload.json();
    const download = await app.inject({ method: "GET", url: attachment.downloadUrl });
    assert.equal(download.statusCode, 200); assert.deepEqual(download.rawPayload, body);
    assert.equal((await app.inject({ method: "GET", url: attachment.downloadUrl.replace("browser-one", "browser-two") })).statusCode, 404);
    const restored = await drafts.prepared("chat-a", "browser-one", attachment.id);
    assert.ok(restored);
    const staged = await assets.stage({ projectId: "project-a", agentId: "agent-a", body: restored.body, prepared: restored.prepared });
    assert.deepEqual((await assets.content("project-a", "agent-a", staged.id, false)).body, body);
    assert.equal((await sharp((await assets.content("project-a", "agent-a", staged.id, true)).body).metadata()).format, "png");
  }
  const bad = await app.inject({ method: "POST", url: "/api/conversations/chat-a/draft-attachments",
    headers: { "content-type": "application/x-ponderosa-attachment", "x-ponderosa-draft-owner": "browser-one", "x-ponderosa-filename": "Bad.jpg", "x-ponderosa-media-type": "image/jpeg" }, payload: Buffer.concat([jpeg, Buffer.from("hidden payload")]) });
  assert.equal(bad.statusCode, 415);
});
