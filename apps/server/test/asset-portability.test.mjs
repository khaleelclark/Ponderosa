import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { AssetStore } from "../dist/assets.js";

test("portable attachment authority uploads, associates, previews, downloads and deletes", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-portable-assets-"));
  const store = new AssetStore(dataDir, { portableFiles: true });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const projectId = randomUUID();
  const agentId = randomUUID();

  const text = await store.stage({ projectId, agentId, body: Buffer.from("draft attachment"), name: "draft.txt" });
  assert.equal((await store.content(projectId, agentId, text.id, false))?.body.toString(), "draft attachment");
  assert.equal(await store.remove(projectId, agentId, text.id), true);
  assert.equal(await store.read(projectId, agentId, text.id), undefined);

  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
  const staged = await store.stage({ projectId, agentId, body: image, name: "photo.png", declaredType: "image/png" });
  assert.equal(staged.state, "staged");
  assert.equal((await store.content(projectId, agentId, staged.id, false))?.body.equals(image), true);
  assert.equal((await store.content(projectId, agentId, staged.id, true))?.asset.mediaType, "image/png");
  const sent = await store.associate(projectId, agentId, [staged.id]);
  assert.equal(sent[0]?.state, "associated");
  assert.equal((await store.read(projectId, agentId, staged.id))?.state, "associated");
  assert.equal(store.authoritativeRuntimeAttachment(projectId, agentId, staged.id)?.byteLength, image.length);
  assert.equal(await store.remove(projectId, agentId, staged.id), false);
  assert.equal((await store.content(projectId, agentId, staged.id, false))?.body.equals(image), true);
  const auditFiles = await readdir(path.join(dataDir, "projects", projectId, "agents", agentId, "attachments"));
  assert.ok(auditFiles.some((name) => /^audit-[a-f0-9-]{36}\.json$/u.test(name)));
});

test("portable attachment authority rejects a replaced Project ancestor", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-portable-assets-"));
  const outside = await mkdtemp(path.join(tmpdir(), "ponderosa-outside-assets-"));
  const store = new AssetStore(dataDir, { portableFiles: true });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const projectId = randomUUID();
  const agentId = randomUUID();
  await mkdir(path.join(dataDir, "projects"));
  await writeFile(path.join(outside, "sentinel"), "unchanged");
  await symlink(outside, path.join(dataDir, "projects", projectId), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.stage({ projectId, agentId, body: Buffer.from("unsafe"), name: "unsafe.txt" }), /secure directory/u);
  assert.equal(readFileSync(path.join(outside, "sentinel"), "utf8"), "unchanged");
});
