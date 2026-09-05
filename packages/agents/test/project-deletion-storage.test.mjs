import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/index.js";

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-project-deletion-storage-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new AgentStore(dataDir);
  t.after(() => store.close());
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  return { dataDir, store, project };
}

test("startup preserves an unjournaled deletion-shaped Project directory", (t) => {
  const { dataDir, store } = fixture(t);
  store.close();
  const sentinel = join(
    dataDir,
    "projects",
    ".foreign.deleting-user-owned",
    "KEEP.txt",
  );
  mkdirSync(dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, "must survive\n");

  const reopened = new AgentStore(dataDir);
  reopened.close();

  assert.equal(readFileSync(sentinel, "utf8"), "must survive\n");
});

test("Project cleanup preserves a replacement at the exact receipt path", (t) => {
  const { dataDir, store, project } = fixture(t);
  const receipt = store.commitProjectDeletion(project.id);
  assert.ok(receipt?.ownershipToken);
  const tombstone = join(dataDir, "projects", receipt.tombstoneName);
  store.close();
  rmSync(tombstone, { recursive: true, force: true });
  const sentinel = join(tombstone, "KEEP.txt");
  mkdirSync(tombstone, { recursive: true });
  writeFileSync(sentinel, "replacement data\n");
  writeFileSync(join(tombstone, ".ponderosa-project-deletion.json"), JSON.stringify({
    version: 1,
    projectId: project.id,
    tombstoneName: receipt.tombstoneName,
    ownershipToken: "foreign-token",
  }));

  const reopened = new AgentStore(dataDir);
  assert.throws(
    () => reopened.finishProjectDeletionStorageCleanup(receipt),
    /ownership identity does not match/u,
  );
  assert.equal(readFileSync(sentinel, "utf8"), "replacement data\n");
  assert.equal(reopened.getProjectDeletionReceipt(project.id)?.storageCleanupCompleted, false);
  reopened.close();
});

test("Project cleanup keeps a missing receipt tombstone pending", (t) => {
  const { dataDir, store, project } = fixture(t);
  const receipt = store.commitProjectDeletion(project.id);
  assert.ok(receipt?.ownershipToken);
  const tombstone = join(dataDir, "projects", receipt.tombstoneName);
  rmSync(tombstone, { recursive: true, force: true });

  assert.throws(
    () => store.finishProjectDeletionStorageCleanup(receipt),
    /tombstone is missing/u,
  );
  assert.equal(store.getProjectDeletionReceipt(project.id)?.storageCleanupCompleted, false);
  assert.equal(store.getProjectDeletionReceipt(project.id)?.removalStarted, false);
});

test("Project cleanup retry converges after a crash immediately following removal", (t) => {
  const { dataDir, store, project } = fixture(t);
  const receipt = store.commitProjectDeletion(project.id);
  assert.ok(receipt?.ownershipToken);
  const tombstone = join(dataDir, "projects", receipt.tombstoneName);

  assert.throws(
    () => store.finishProjectDeletionStorageCleanup(receipt, () => {
      throw new Error("injected crash after tombstone removal");
    }),
    /injected crash/u,
  );
  assert.equal(existsSync(tombstone), false);
  assert.equal(store.getProjectDeletionReceipt(project.id)?.removalStarted, true);
  assert.equal(store.getProjectDeletionReceipt(project.id)?.storageCleanupCompleted, false);

  store.finishProjectDeletionStorageCleanup(receipt);

  assert.equal(store.getProjectDeletionReceipt(project.id)?.storageCleanupCompleted, true);
});

test("Project cleanup preserves an ABA replacement after removal started", (t) => {
  const { dataDir, store, project } = fixture(t);
  const receipt = store.commitProjectDeletion(project.id);
  assert.ok(receipt?.ownershipToken);
  const tombstone = join(dataDir, "projects", receipt.tombstoneName);
  assert.throws(
    () => store.finishProjectDeletionStorageCleanup(receipt, () => {
      throw new Error("injected crash after tombstone removal");
    }),
    /injected crash/u,
  );
  mkdirSync(tombstone);
  const sentinel = join(tombstone, "KEEP.txt");
  writeFileSync(sentinel, "replacement data\n");
  writeFileSync(join(tombstone, ".ponderosa-project-deletion.json"), JSON.stringify({
    version: 1,
    projectId: project.id,
    tombstoneName: receipt.tombstoneName,
    ownershipToken: "replacement-token",
  }));

  assert.throws(
    () => store.finishProjectDeletionStorageCleanup(receipt),
    /ownership identity does not match/u,
  );
  assert.equal(readFileSync(sentinel, "utf8"), "replacement data\n");
  assert.equal(store.getProjectDeletionReceipt(project.id)?.storageCleanupCompleted, false);
});

test("Project cleanup removes its exact receipt-bound tombstone", (t) => {
  const { dataDir, store, project } = fixture(t);
  const receipt = store.commitProjectDeletion(project.id);
  assert.ok(receipt?.ownershipToken);
  const tombstone = join(dataDir, "projects", receipt.tombstoneName);
  assert.equal(existsSync(tombstone), true);

  store.finishProjectDeletionStorageCleanup(receipt);

  assert.equal(existsSync(tombstone), false);
  assert.equal(store.getProjectDeletionReceipt(project.id)?.removalStarted, true);
  assert.equal(store.getProjectDeletionReceipt(project.id)?.storageCleanupCompleted, true);
});
