import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ASSET_LIMITS,
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
