import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
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
  const reopened = new AssetStore(dataDir, { portableFiles: true });
  try {
    assert.equal((await reopened.content(projectId, agentId, staged.id, false))?.body.equals(image), true,
      "a successful portable upload remains readable after reopening storage");
  } finally { reopened.close(); }
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

test("a root replacement between byte and metadata writes cannot acknowledge an unreadable upload", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-portable-swap-"));
  const displaced = `${dataDir}-displaced`;
  const projectId = randomUUID();
  const agentId = randomUUID();
  const store = new AssetStore(dataDir, { portableFiles: true });
  let closed = false;
  t.after(async () => {
    if (!closed) store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(displaced, { recursive: true, force: true });
  });
  const originalWrite = store.secureWrite.bind(store);
  let swapped = false;
  store.secureWrite = (relative, leaf, body) => {
    originalWrite(relative, leaf, body);
    if (!swapped && leaf.endsWith(".bin")) {
      renameSync(dataDir, displaced);
      mkdirSync(dataDir);
      swapped = true;
    }
  };
  await assert.rejects(store.stage({ projectId, agentId, body: Buffer.from("unreadable"), name: "draft.txt" }),
    /asset storage changed during upload/u);
  assert.equal(swapped, true);
  assert.equal(existsSync(path.join(dataDir, "projects")), false, "replacement root cannot receive acknowledged metadata");
  store.close();
  closed = true;
  await rm(dataDir, { recursive: true, force: true });
  renameSync(displaced, dataDir);
  const reopened = new AssetStore(dataDir, { portableFiles: true });
  try {
    const directory = path.join(dataDir, "projects", projectId, "agents", agentId, "attachments");
    const bin = (await readdir(directory)).find(name => name.endsWith(".bin"));
    assert.ok(bin, "interrupted bytes remain quarantined in the displaced root");
    const id = bin.slice(0, -4);
    assert.equal(await reopened.read(projectId, agentId, id), undefined);
    assert.equal(await reopened.content(projectId, agentId, id, false), undefined);
    await reopened.reconcile(projectId, agentId, new Set(), Date.now());
    assert.equal(existsSync(path.join(directory, bin)), false, "recovery reclaims unacknowledged bytes");
  } finally { reopened.close(); }
});
