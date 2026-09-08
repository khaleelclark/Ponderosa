import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  ASSET_LIMITS,
  AssetStore,
  DRAFT_ASSET_LIMITS,
  removeStagedAssetFiles,
} from "../dist/assets.js";
import { AssetAuthority } from "../dist/asset-authority.js";
import { DraftService } from "../dist/routes/drafts.js";
import { AgentStore } from "@ponderosa/agents";
import { finishProjectAssetAuthorityCleanup } from "../dist/project-deletion-coordinator.js";

function seedAuthorityRows(sqlite, projectId, agentId, draftId) {
  const reservationId = randomUUID();
  const reservedAssetId = randomUUID();
  const committedAssetId = randomUUID();
  const deletionAssetId = randomUUID();
  const draftReservationId = randomUUID();
  const draftReservedAssetId = randomUUID();
  const draftCommittedAssetId = randomUUID();
  const runtimeArtifactId = `text-${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const generatedArtifactId = randomUUID();
  sqlite.prepare("INSERT INTO asset_reservations VALUES (?,?,?,?,?,?)")
    .run(reservationId, reservedAssetId, projectId, agentId, 1, Date.now());
  sqlite.prepare("INSERT INTO asset_committed VALUES (?,?,?,?)")
    .run(committedAssetId, projectId, agentId, 1);
  sqlite.prepare("INSERT INTO asset_settlements VALUES (?,?,?,?)")
    .run(randomUUID(), committedAssetId, projectId, agentId);
  sqlite.prepare(`INSERT INTO asset_deletions(
    asset_id,project_id,agent_id,requested_at,audit_event_id
  ) VALUES (?,?,?,?,?)`).run(deletionAssetId, projectId, agentId, Date.now(), randomUUID());
  sqlite.prepare("INSERT INTO asset_rate_events VALUES (?,?,?,?)")
    .run(randomUUID(), projectId, agentId, Date.now());
  sqlite.prepare(`INSERT INTO asset_audit(event_id,project_id,agent_id,record_json)
    VALUES (?,?,?,?)`).run(randomUUID(), projectId, agentId, "{}");
  sqlite.prepare(`INSERT INTO runtime_attachment_associations(
    communication_id,asset_id,project_id,agent_id,content_hash,byte_length,reservation_attempt_id,created_at
  ) VALUES (?,?,?,?,?,?,?,?)`).run(
    randomUUID(), committedAssetId, projectId, agentId, "a".repeat(64), 1, randomUUID(), Date.now(),
  );
  sqlite.prepare(`INSERT INTO runtime_artifact_authority(
    id,project_id,role,title,media_type,blob_path,blob_hash,byte_length,origin_agent_id,execution_id,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    runtimeArtifactId, projectId, "document", "Runtime", "text/markdown", runtimeArtifactId,
    "b".repeat(64), 1, agentId, randomUUID(), new Date().toISOString(),
  );
  sqlite.prepare(`INSERT INTO generated_artifact_authority(
    id,project_id,agent_id,origin_agent_id,execution_id,kind,artifact_path,source_path,
    summary,created_at,media_type,byte_length,blob_hash
  ) VALUES (?,?,?,?,?,'generated_file',?,?,?,?,?,?,?)`).run(
    generatedArtifactId, projectId, agentId, agentId, randomUUID(), "result.txt", null,
    "Generated", new Date().toISOString(), "text/plain", 1, "c".repeat(64),
  );
  sqlite.prepare(`INSERT INTO generated_artifact_import_receipts(
    project_id,run_id,tool_call_id,request_hash,artifact_id,projected,created_at
  ) VALUES (?,?,?,?,?,0,?)`).run(
    projectId, randomUUID(), randomUUID(), "d".repeat(64), generatedArtifactId, new Date().toISOString(),
  );
  sqlite.prepare("INSERT INTO draft_asset_reservations VALUES (?,?,?,?,?,?)")
    .run(draftReservationId, draftReservedAssetId, draftId, "owner", 1, Date.now());
  sqlite.prepare("INSERT INTO draft_asset_committed VALUES (?,?,?,?)")
    .run(draftCommittedAssetId, draftId, "owner", 1);
  sqlite.prepare("INSERT INTO draft_asset_settlements VALUES (?,?,?,?)")
    .run(randomUUID(), draftCommittedAssetId, draftId, "owner");
  sqlite.prepare("INSERT INTO draft_asset_rate_events VALUES (?,?,?)")
    .run(randomUUID(), draftId, Date.now());
  sqlite.prepare("INSERT INTO draft_attachment_cleanups VALUES (?,?,?,?)")
    .run(draftId, "owner", draftCommittedAssetId, Date.now());
}

const agentAuthorityTables = [
  "asset_reservations", "asset_committed", "asset_settlements", "asset_deletions",
  "asset_rate_events", "asset_audit", "runtime_attachment_associations",
];
const projectAuthorityTables = [
  ...agentAuthorityTables, "runtime_artifact_authority", "generated_artifact_import_receipts",
  "generated_artifact_authority",
];
const draftAuthorityTables = [
  "draft_asset_reservations", "draft_asset_committed", "draft_asset_settlements",
  "draft_asset_rate_events", "draft_attachment_cleanups",
];

test("Agent authority purge is exact, idempotent, and preserves Project artifacts", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-agent-authority-purge-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const authority = new AssetAuthority(dataDir);
  t.after(() => authority.close());
  const projectId = randomUUID();
  const removedAgentId = randomUUID();
  const keptAgentId = randomUUID();
  const sqlite = new Database(path.join(dataDir, "asset-authority.sqlite"));
  t.after(() => sqlite.close());
  seedAuthorityRows(sqlite, projectId, removedAgentId, `agent:${removedAgentId}`);
  seedAuthorityRows(sqlite, projectId, keptAgentId, `agent:${keptAgentId}`);

  authority.purgeAgents([removedAgentId, removedAgentId]);
  authority.purgeAgents([removedAgentId]);

  for (const table of agentAuthorityTables) {
    assert.equal(sqlite.prepare(`SELECT count(*) count FROM ${table} WHERE agent_id=?`).get(removedAgentId).count, 0, table);
    assert.equal(sqlite.prepare(`SELECT count(*) count FROM ${table} WHERE agent_id=?`).get(keptAgentId).count, 1, table);
  }
  for (const table of draftAuthorityTables) {
    assert.equal(sqlite.prepare(`SELECT count(*) count FROM ${table} WHERE draft_id=?`).get(`agent:${removedAgentId}`).count, 0, table);
    assert.equal(sqlite.prepare(`SELECT count(*) count FROM ${table} WHERE draft_id=?`).get(`agent:${keptAgentId}`).count, 1, table);
  }
  assert.equal(sqlite.prepare("SELECT count(*) count FROM runtime_artifact_authority WHERE project_id=?").get(projectId).count, 2);
  assert.equal(sqlite.prepare("SELECT count(*) count FROM generated_artifact_authority WHERE project_id=?").get(projectId).count, 2);
});

test("Project authority purge removes every owned row and preserves another Project", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-project-authority-purge-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const authority = new AssetAuthority(dataDir);
  t.after(() => authority.close());
  const removedProjectId = randomUUID();
  const keptProjectId = randomUUID();
  const removedDraftId = randomUUID();
  const keptDraftId = randomUUID();
  const sqlite = new Database(path.join(dataDir, "asset-authority.sqlite"));
  t.after(() => sqlite.close());
  seedAuthorityRows(sqlite, removedProjectId, randomUUID(), removedDraftId);
  seedAuthorityRows(sqlite, keptProjectId, randomUUID(), keptDraftId);

  authority.purgeProject(removedProjectId, [removedDraftId, removedDraftId]);
  authority.purgeProject(removedProjectId, [removedDraftId]);

  for (const table of projectAuthorityTables) {
    assert.equal(sqlite.prepare(`SELECT count(*) count FROM ${table} WHERE project_id=?`).get(removedProjectId).count, 0, table);
    assert.equal(sqlite.prepare(`SELECT count(*) count FROM ${table} WHERE project_id=?`).get(keptProjectId).count, 1, table);
  }
  for (const table of draftAuthorityTables) {
    assert.equal(sqlite.prepare(`SELECT count(*) count FROM ${table} WHERE draft_id=?`).get(removedDraftId).count, 0, table);
    assert.equal(sqlite.prepare(`SELECT count(*) count FROM ${table} WHERE draft_id=?`).get(keptDraftId).count, 1, table);
  }
});

test("Project receipt retries an authority-purge crash gap after restart", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-project-authority-retry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let store = new AgentStore(dataDir);
  let assets = new AssetStore(dataDir);
  const project = store.createProject({ label: "Project", hostPath: "/tmp/project", defaultEngine: "codex" });
  const receipt = store.commitProjectDeletion(project.id);
  store.finishProjectDeletionStorageCleanup(receipt);
  store.markProjectDeletionDraftCleanupComplete(project.id);

  assert.throws(() => finishProjectAssetAuthorityCleanup(store, {
    purgeProject: () => { throw new Error("injected asset authority failure"); },
  }, project.id), /injected asset authority failure/u);
  assert.equal(store.getProjectDeletionReceipt(project.id).assetAuthorityCleanupCompleted, false);
  assets.purgeProject(project.id, receipt.draftSurfaceIds);
  assets.close();
  store.close();

  store = new AgentStore(dataDir);
  assets = new AssetStore(dataDir);
  t.after(() => { assets.close(); store.close(); });
  finishProjectAssetAuthorityCleanup(store, assets, project.id);
  assert.equal(store.getProjectDeletionReceipt(project.id).assetAuthorityCleanupCompleted, true);
  assert.equal(store.listPendingProjectDeletionReceipts().length, 0);
});

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

for (const deletedSurface of ["chat-delete", "collaboration:chat-delete", "agent:agent-delete"]) {
  test(`${deletedSurface} canonical deletion removes files and immediately releases workspace quota`, async (t) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-entity-draft-cleanup-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    let authority = new AssetAuthority(dataDir);
    t.after(() => authority.close());
    let drafts = new DraftService(dataDir, {}, {}, authority);
    const surfaces = [deletedSurface, "filler-a", "filler-b", "filler-c"];
    for (const draftId of surfaces) {
      for (let index = 0; index < 64; index += 1) {
        const assetId = randomUUID();
        const reservation = authority.reserveDraftAttachment(
          draftId,
          `owner-${index}`,
          assetId,
          ASSET_LIMITS.maxFileBytes,
        );
        if (index === 63) continue;
        authority.settleDraftAttachment(reservation);
        if (index === 0) {
          authority.enqueueDraftAttachmentCleanup(draftId, `owner-${index}`, assetId, 0);
        }
      }
    }
    const surfaceDirectory = drafts.surfaceDir(deletedSurface);
    await mkdir(path.join(surfaceDirectory, "current"), { recursive: true });
    for (const name of ["file.bin", "paste.bin", "conflict-file.bin", "conflict-paste.bin"]) {
      await writeFile(path.join(surfaceDirectory, "current", name), name);
    }
    assert.throws(
      () => authority.reserveDraftAttachment("blocked", "owner", randomUUID(), 1),
      /draft asset quota exceeded/u,
    );

    await drafts.deleteSurface(deletedSurface);
    assert.equal(existsSync(surfaceDirectory), false);
    assert.doesNotThrow(() => authority.reserveDraftAttachment(
      "available-immediately",
      "owner",
      randomUUID(),
      ASSET_LIMITS.maxFileBytes,
    ));
    const sqlite = new Database(path.join(dataDir, "asset-authority.sqlite"), { readonly: true });
    for (const table of [
      "draft_asset_settlements",
      "draft_asset_reservations",
      "draft_asset_committed",
      "draft_attachment_cleanups",
      "draft_asset_rate_events",
    ]) {
      assert.equal(sqlite.prepare(`SELECT COUNT(*) count FROM ${table} WHERE draft_id=?`)
        .get(deletedSurface).count, 0, table);
    }
    sqlite.close();

    authority.close();
    authority = new AssetAuthority(dataDir);
    drafts = new DraftService(dataDir, {}, {}, authority);
    await drafts.deleteSurface(deletedSurface);
    assert.doesNotThrow(() => authority.reserveDraftAttachment(
      "available-after-restart",
      "owner",
      randomUUID(),
      ASSET_LIMITS.maxFileBytes,
    ));
  });
}

test("entity draft cleanup retries after files were removed but ledger settlement failed", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-entity-draft-cleanup-retry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let authority = new AssetAuthority(dataDir);
  t.after(() => authority.close());
  const draftId = "agent:retry";
  const assetId = randomUUID();
  const reservation = authority.reserveDraftAttachment(draftId, "owner", assetId, 1);
  authority.settleDraftAttachment(reservation);
  const originalFinish = authority.finishDraftSurfaceCleanup.bind(authority);
  authority.finishDraftSurfaceCleanup = () => { throw new Error("injected ledger cleanup failure"); };
  let drafts = new DraftService(dataDir, {}, {}, authority);
  await mkdir(drafts.surfaceDir(draftId), { recursive: true });
  await writeFile(path.join(drafts.surfaceDir(draftId), "file.bin"), "draft");

  await assert.rejects(() => drafts.deleteSurface(draftId), /injected ledger cleanup failure/u);
  assert.equal(existsSync(drafts.surfaceDir(draftId)), false);
  authority.finishDraftSurfaceCleanup = originalFinish;
  authority.close();
  authority = new AssetAuthority(dataDir);
  drafts = new DraftService(dataDir, {}, {}, authority);
  await drafts.deleteSurface(draftId);
  assert.doesNotThrow(() => authority.reserveDraftAttachment(draftId, "owner", randomUUID(), 1));
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
