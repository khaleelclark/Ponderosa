import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ASSET_LIMITS,
  DRAFT_ASSET_LIMITS,
  removeStagedAssetFiles,
} from "../dist/assets.js";
import { AssetAuthority } from "../dist/asset-authority.js";

test("partial asset deletion keeps its receipt and quota until restart completes every file", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-asset-cleanup-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const projectId = randomUUID();
  const agentId = randomUUID();
  const assetId = randomUUID();
  const directory = path.join(dataDir, "asset-files");
  await mkdir(directory);
  await writeFile(path.join(directory, `${assetId}.bin`), "body");
  await writeFile(path.join(directory, `${assetId}.json`), "{}");
  await mkdir(path.join(directory, `${assetId}.preview.png`));

  let authority = new AssetAuthority(dataDir);
  const reservation = authority.reserve(
    projectId,
    agentId,
    assetId,
    ASSET_LIMITS.maxAgentBytes,
  );
  authority.settle(reservation);
  const receipt = authority.beginDelete(assetId, projectId, agentId);
  await assert.rejects(
    removeStagedAssetFiles(directory, assetId, async () => {}),
    error => error?.code !== "ENOENT",
  );
  assert.equal(existsSync(path.join(directory, `${assetId}.bin`)), false);
  assert.equal(existsSync(path.join(directory, `${assetId}.json`)), true);
  authority.close();

  authority = new AssetAuthority(dataDir);
  t.after(() => authority.close());
  assert.deepEqual(authority.pendingDeletions(projectId, agentId), [{
    assetId,
    projectId,
    agentId,
    auditEventId: receipt.auditEventId,
    requestedAt: receipt.requestedAt,
  }]);
  assert.throws(
    () => authority.reserve(projectId, agentId, randomUUID(), 1),
    /agent asset quota exceeded/u,
  );

  await rm(path.join(directory, `${assetId}.preview.png`), { recursive: true });
  let synced = 0;
  await removeStagedAssetFiles(directory, assetId, async () => { synced += 1; });
  assert.equal(synced, 1);
  const audit = path.join(directory, "audit.jsonl");
  const record = {
    action: "deleted",
    id: assetId,
    agentId,
    projectId,
    at: new Date(receipt.requestedAt).toISOString(),
  };
  authority.recordAudit(audit, projectId, agentId, record, receipt.auditEventId);
  authority.recordAudit(audit, projectId, agentId, record, receipt.auditEventId);
  authority.finishDelete(assetId);
  assert.equal(authority.pendingDeletions(projectId, agentId).length, 0);
  assert.equal(readFileSync(audit, "utf8").trim().split("\n").length, 1);
  assert.doesNotThrow(() =>
    authority.reserve(projectId, agentId, randomUUID(), ASSET_LIMITS.maxAgentBytes));
});

test("draft quota is stable across owner rotation, failed writes, and restart cleanup", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-draft-quota-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let authority = new AssetAuthority(dataDir);
  const draftId = "chat-a";

  const active = Array.from(
    { length: DRAFT_ASSET_LIMITS.maxConcurrentUploadsPerSurface },
    (_, index) => authority.reserveDraftAttachment(
      draftId,
      `rotated-owner-${index}`,
      randomUUID(),
      1,
    ),
  );
  assert.throws(
    () => authority.reserveDraftAttachment(draftId, "another-owner", randomUUID(), 1),
    /too many concurrent draft uploads/u,
  );
  authority.releaseDraftAttachment(active.pop());
  assert.doesNotThrow(() => active.push(
    authority.reserveDraftAttachment(draftId, "another-owner", randomUUID(), 1),
  ));
  for (const reservation of active) authority.releaseDraftAttachment(reservation);

  let firstAsset;
  for (let index = 0; index < 64; index += 1) {
    const assetId = randomUUID();
    firstAsset ??= assetId;
    if (index === 0) {
      authority.syncDraftAttachment(
        draftId,
        `rotated-owner-${index}`,
        assetId,
        ASSET_LIMITS.maxFileBytes,
      );
    } else {
      const reservation = authority.reserveDraftAttachment(
        draftId,
        `rotated-owner-${index}`,
        assetId,
        ASSET_LIMITS.maxFileBytes,
      );
      authority.settleDraftAttachment(reservation);
    }
  }
  assert.throws(
    () => authority.reserveDraftAttachment(draftId, "fresh-owner", randomUUID(), 1),
    /draft asset quota exceeded/u,
  );
  authority.enqueueDraftAttachmentCleanup(draftId, "rotated-owner-0", firstAsset, 0);
  authority.close();

  authority = new AssetAuthority(dataDir);
  t.after(() => authority.close());
  assert.throws(
    () => authority.reserveDraftAttachment(draftId, "fresh-owner", randomUUID(), 1),
    /draft asset quota exceeded/u,
  );
  authority.finishDraftAttachmentCleanup(draftId, "rotated-owner-0", firstAsset);
  assert.doesNotThrow(() =>
    authority.reserveDraftAttachment(draftId, "fresh-owner", randomUUID(), 1));
});

test("draft upload rate is keyed to its stable surface instead of caller owner IDs", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-draft-rate-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const authority = new AssetAuthority(dataDir);
  t.after(() => authority.close());
  for (let index = 0; index < DRAFT_ASSET_LIMITS.maxUploadsPerMinutePerSurface; index += 1) {
    const reservation = authority.reserveDraftAttachment(
      "chat-a",
      `rotated-owner-${index}`,
      randomUUID(),
      1,
    );
    authority.releaseDraftAttachment(reservation);
  }
  assert.throws(
    () => authority.reserveDraftAttachment("chat-a", "new-owner", randomUUID(), 1),
    /draft upload rate limit exceeded/u,
  );
});

test("draft surface cleanup atomically settles reservations, committed quota, cleanup, and rate", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-draft-surface-cleanup-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let authority = new AssetAuthority(dataDir);
  const draftId = "chat-delete";
  let committedId;
  for (let index = 0; index < 63; index += 1) {
    const assetId = randomUUID();
    committedId ??= assetId;
    const committed = authority.reserveDraftAttachment(
      draftId,
      `owner-${index}`,
      assetId,
      ASSET_LIMITS.maxFileBytes,
    );
    authority.settleDraftAttachment(committed);
  }
  authority.reserveDraftAttachment(draftId, "owner-b", randomUUID(), 1);
  authority.enqueueDraftAttachmentCleanup(draftId, "owner-a", committedId, 0);

  authority.finishDraftSurfaceCleanup(draftId);
  authority.close();
  authority = new AssetAuthority(dataDir);
  t.after(() => authority.close());
  assert.deepEqual(authority.pendingDraftAttachmentCleanups(), []);
  assert.doesNotThrow(() => authority.reserveDraftAttachment(
    draftId,
    "owner-c",
    randomUUID(),
    ASSET_LIMITS.maxFileBytes,
  ));
});

test("draft quota enforces the workspace aggregate across independent surfaces", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-draft-workspace-quota-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const authority = new AssetAuthority(dataDir);
  t.after(() => authority.close());
  const surfaceCount = DRAFT_ASSET_LIMITS.maxWorkspaceBytes /
    DRAFT_ASSET_LIMITS.maxSurfaceBytes;
  for (let surface = 0; surface < surfaceCount; surface += 1) {
    for (let file = 0; file < 64; file += 1) {
      const reservation = authority.reserveDraftAttachment(
        `chat-${surface}`,
        `owner-${file}`,
        randomUUID(),
        ASSET_LIMITS.maxFileBytes,
      );
      authority.settleDraftAttachment(reservation);
    }
  }
  assert.throws(
    () => authority.reserveDraftAttachment("chat-next", "owner-next", randomUUID(), 1),
    /draft asset quota exceeded/u,
  );
});
