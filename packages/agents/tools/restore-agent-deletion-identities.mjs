import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { admitDataDirectory } from "../dist/index.js";
import {
  validateAgentDeletionDirectory,
} from "../dist/agent-deletion-identity.js";
import { agentDir } from "../dist/paths.js";

function requireText(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.length > 0 && value.length <= 500, `${label} is invalid`);
  return value;
}

function requireId(value, label) {
  const id = requireText(value, label);
  assert.match(id, /^[a-zA-Z0-9_-]+$/, `${label} must be a safe record ID`);
  return id;
}

export function restoreAgentDeletionIdentities(dataDir, manifest, apply = false) {
  assert.deepEqual(Object.keys(manifest).sort(), ["entries", "generationId", "stateEpoch", "version"]);
  assert.equal(manifest.version, 2);
  assert.equal(manifest.stateEpoch, 2);
  assert.match(manifest.generationId, /^[0-9a-f-]{36}$/u);
  assert.ok(Array.isArray(manifest.entries) && manifest.entries.length > 0);
  const admission = admitDataDirectory(realpathSync(resolve(dataDir)), "ponderosa.db", undefined, { generationId: manifest.generationId });
  const root = admission.dataDir;
  const db = admission.client;
  try {
    const validated = [];
    const seen = new Set();
    for (const raw of manifest.entries) {
      assert.deepEqual(Object.keys(raw).sort(), [
        "agentId", "conversationId", "createdAt", "ownershipToken", "projectId", "tombstoneName",
      ]);
      const identity = {
        agentId: requireId(raw.agentId, "agentId"),
        projectId: requireId(raw.projectId, "projectId"),
        conversationId: requireId(raw.conversationId, "conversationId"),
        tombstoneName: requireText(raw.tombstoneName, "tombstoneName"),
        ownershipToken: requireText(raw.ownershipToken, "ownershipToken"),
        createdAt: requireText(raw.createdAt, "createdAt"),
      };
      assert.ok(Number.isFinite(Date.parse(identity.createdAt)), "createdAt is invalid");
      assert.ok(!seen.has(identity.agentId), "manifest contains duplicate Agent identities");
      seen.add(identity.agentId);
      const receipts = db.prepare(`SELECT project_id, deleted_agent_ids_json, storage_cleanup_completed,
        created_at
        FROM agent_deletion_receipts WHERE project_id=?`).all(identity.projectId);
      assert.ok(receipts.some((receipt) =>
        receipt.storage_cleanup_completed === 1
        && receipt.created_at === identity.createdAt
        && JSON.parse(receipt.deleted_agent_ids_json).includes(identity.agentId)),
      `completed Agent deletion receipt is missing for ${identity.agentId}`);
      assert.ok(db.prepare(`SELECT 1 FROM conversation_deletion_receipts
        WHERE conversation_id=? AND project_id=? AND canonical_deletion_completed=1`)
        .get(identity.conversationId, identity.projectId),
      `completed Chat deletion receipt is missing for ${identity.conversationId}`);
      const metadata = JSON.parse(readFileSync(
        resolve(root, "projects", identity.projectId, "agents", identity.agentId, "agent.json"),
        "utf8",
      ));
      assert.equal(metadata.id, identity.agentId);
      assert.equal(metadata.projectId, identity.projectId);
      assert.equal(metadata.deletedAt, identity.createdAt);
      assert.equal(metadata.conversationId, undefined);
      const directory = agentDir(root, identity.projectId, identity.agentId);
      validateAgentDeletionDirectory(directory, identity);
      const existing = db.prepare(`SELECT project_id, conversation_id, tombstone_name,
        ownership_token, created_at FROM agent_deletion_tombstones WHERE agent_id=?`)
        .get(identity.agentId);
      if (existing) {
        assert.deepEqual(existing, {
          project_id: identity.projectId,
          conversation_id: identity.conversationId,
          tombstone_name: identity.tombstoneName,
          ownership_token: identity.ownershipToken,
          created_at: identity.createdAt,
        });
      }
      validated.push({ identity, existing: Boolean(existing) });
    }
    if (apply) db.transaction(() => {
      const insert = db.prepare(`INSERT INTO agent_deletion_tombstones(
        agent_id, project_id, conversation_id, tombstone_name, ownership_token, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const { identity, existing } of validated) if (!existing) {
        validateAgentDeletionDirectory(
          agentDir(root, identity.projectId, identity.agentId),
          identity,
        );
        insert.run(
          identity.agentId,
          identity.projectId,
          identity.conversationId,
          identity.tombstoneName,
          identity.ownershipToken,
          identity.createdAt,
        );
      }
    })();
    return {
      status: apply ? "applied" : "validated",
      count: validated.length,
      alreadyPresent: validated.filter((entry) => entry.existing).length,
    };
  } finally {
    admission.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dataDir, manifestPath, option] = process.argv.slice(2);
  assert.ok(dataDir && manifestPath, "usage: restore-agent-deletion-identities DATA_DIR MANIFEST [--apply]");
  assert.ok(option === undefined || option === "--apply", "unknown option");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  console.log(JSON.stringify(
    restoreAgentDeletionIdentities(dataDir, manifest, option === "--apply"),
    null,
    2,
  ));
}
