import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createOfflineDataDirectoryBackup,
  restoreOfflineDataDirectoryBackup,
} from "../dist/data-directory-backup.js";

test("offline backup restores a checksummed data directory without transient authority", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-backup-"));
  try {
    const data = path.join(root, "data");
    const backup = path.join(root, "backup");
    const restored = path.join(root, "restored");
    mkdirSync(path.join(data, "projects", "project-a"), { recursive: true });
    writeFileSync(path.join(data, ".ponderosa-layout-version"), "1\n");
    writeFileSync(path.join(data, "ponderosa.db"), "sqlite snapshot");
    writeFileSync(path.join(data, "projects", "project-a", "project.json"), JSON.stringify({
      id: "project-a",
      label: "A",
      hostPath: path.join(root, "working-project-a"),
    }));
    symlinkSync("project.json", path.join(data, "projects", "project-a", "current.json"));

    const manifest = createOfflineDataDirectoryBackup(data, backup);
    assert.equal(manifest.externalProjects.policy, "excluded");
    assert.equal(manifest.entries.some(entry => entry.path === ".ponderosa-daemon.lock"), false);
    restoreOfflineDataDirectoryBackup(backup, restored);
    assert.equal(readFileSync(path.join(restored, "ponderosa.db"), "utf8"), "sqlite snapshot");
    assert.equal(
      readFileSync(path.join(restored, "projects", "project-a", "current.json"), "utf8"),
      readFileSync(path.join(restored, "projects", "project-a", "project.json"), "utf8"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline backup can include and restore external Project roots", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-backup-external-"));
  try {
    const data = path.join(root, "data");
    const working = path.join(root, "working-project");
    const backup = path.join(root, "backup");
    const restored = path.join(root, "restored");
    mkdirSync(path.join(data, "projects", "project-a"), { recursive: true });
    mkdirSync(working);
    writeFileSync(path.join(working, "README.md"), "external bytes\n");
    writeFileSync(path.join(data, ".ponderosa-layout-version"), "1\n");
    writeFileSync(path.join(data, "ponderosa.db"), "sqlite snapshot");
    writeFileSync(path.join(data, "projects", "project-a", "project.json"), JSON.stringify({
      id: "project-a",
      label: "A",
      hostPath: working,
    }));
    const manifest = createOfflineDataDirectoryBackup(data, backup, { externalProjects: "copy" });
    assert.equal(manifest.externalProjects.policy, "included");
    assert.equal(manifest.externalProjects.projects.length, 1);
    rmSync(working, { recursive: true, force: true });
    restoreOfflineDataDirectoryBackup(backup, restored, { restoreExternalProjects: true });
    assert.equal(readFileSync(path.join(working, "README.md"), "utf8"), "external bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore rejects a file changed after the manifest was committed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-backup-tamper-"));
  try {
    const data = path.join(root, "data");
    const backup = path.join(root, "backup");
    mkdirSync(data);
    writeFileSync(path.join(data, ".ponderosa-layout-version"), "1\n");
    writeFileSync(path.join(data, "ponderosa.db"), "canonical");
    createOfflineDataDirectoryBackup(data, backup);
    writeFileSync(path.join(backup, "ponderosa.db"), "changed");
    assert.throws(
      () => restoreOfflineDataDirectoryBackup(backup, path.join(root, "restored")),
      /checksum mismatch/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore journal rolls back partially published multi-root restores", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-backup-journal-"));
  try {
    const data = path.join(root, "data");
    const working = path.join(root, "working-project");
    const backup = path.join(root, "backup");
    const restored = path.join(root, "restored");
    mkdirSync(path.join(data, "projects", "project-a"), { recursive: true });
    mkdirSync(working);
    writeFileSync(path.join(working, "README.md"), "authoritative external bytes\n");
    writeFileSync(path.join(data, ".ponderosa-layout-version"), "1\n");
    writeFileSync(path.join(data, "ponderosa.db"), "authoritative database");
    writeFileSync(path.join(data, "projects", "project-a", "project.json"), JSON.stringify({
      id: "project-a",
      label: "A",
      hostPath: working,
    }));
    createOfflineDataDirectoryBackup(data, backup, { externalProjects: "copy" });
    rmSync(working, { recursive: true, force: true });
    mkdirSync(working);
    writeFileSync(path.join(working, "partial"), "partial");
    mkdirSync(restored);
    writeFileSync(path.join(restored, "partial"), "partial");
    writeFileSync(`${restored}.restore-journal.json`, JSON.stringify({
      schemaVersion: 1,
      backup,
      dataDir: restored,
      stage: `${restored}.restore-999`,
      externalStages: [{ originalPath: working, stage: `${working}.restore-999` }],
      publishedExternal: [working],
      primaryPublished: true,
      committed: false,
    }));
    restoreOfflineDataDirectoryBackup(backup, restored, { restoreExternalProjects: true });
    assert.equal(readFileSync(path.join(restored, "ponderosa.db"), "utf8"), "authoritative database");
    assert.equal(readFileSync(path.join(working, "README.md"), "utf8"), "authoritative external bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy journal preserves an external root published before its journal update", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-backup-legacy-gap-"));
  try {
    const data = path.join(root, "data");
    const working = path.join(root, "working-project");
    const backup = path.join(root, "backup");
    const restored = path.join(root, "restored");
    mkdirSync(path.join(data, "projects", "project-a"), { recursive: true });
    mkdirSync(working);
    writeFileSync(path.join(working, "README.md"), "original");
    writeFileSync(path.join(data, ".ponderosa-layout-version"), "1\n");
    writeFileSync(path.join(data, "ponderosa.db"), "database");
    writeFileSync(path.join(data, "projects", "project-a", "project.json"), JSON.stringify({
      id: "project-a", label: "A", hostPath: working,
    }));
    createOfflineDataDirectoryBackup(data, backup, { externalProjects: "copy" });
    const journalPath = `${restored}.restore-journal.json`;
    writeFileSync(journalPath, JSON.stringify({
      schemaVersion: 1,
      backup,
      dataDir: restored,
      stage: `${restored}.restore-999`,
      externalStages: [{ originalPath: working, stage: `${working}.restore-999` }],
      publishedExternal: [],
      primaryPublished: false,
      committed: false,
    }));
    assert.throws(
      () => restoreOfflineDataDirectoryBackup(backup, restored, { restoreExternalProjects: true }),
      /unrecorded external root/u,
    );
    assert.equal(readFileSync(path.join(working, "README.md"), "utf8"), "original");
    assert.equal(existsSync(journalPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const boundary of ["before-external-rename", "after-external-rename", "after-primary-rename"]) {
  test(`restore journal recovers crash ${boundary}`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-backup-crash-"));
    try {
      const data = path.join(root, "data");
      const working = path.join(root, "working-project");
      const backup = path.join(root, "backup");
      const restored = path.join(root, "restored");
      const stage = `${restored}.restore-999`;
      const externalStage = `${working}.restore-999`;
      mkdirSync(path.join(data, "projects", "project-a"), { recursive: true });
      mkdirSync(working);
      writeFileSync(path.join(working, "README.md"), "authoritative external bytes\n");
      writeFileSync(path.join(data, ".ponderosa-layout-version"), "1\n");
      writeFileSync(path.join(data, "ponderosa.db"), "authoritative database");
      writeFileSync(path.join(data, "projects", "project-a", "project.json"), JSON.stringify({
        id: "project-a", label: "A", hostPath: working,
      }));
      createOfflineDataDirectoryBackup(data, backup, { externalProjects: "copy" });
      rmSync(working, { recursive: true, force: true });
      mkdirSync(stage);
      mkdirSync(externalStage);
      writeFileSync(path.join(externalStage, "partial"), "staged");
      const identity = (directory) => {
        const stat = lstatSync(directory, { bigint: true });
        return `${stat.dev}:${stat.ino}`;
      };
      const stageIdentity = identity(stage);
      const externalIdentity = identity(externalStage);
      writeFileSync(`${restored}.restore-journal.json`, JSON.stringify({
        schemaVersion: 2,
        backup,
        dataDir: restored,
        stage,
        stageIdentity,
        externalStages: [{ originalPath: working, stage: externalStage, identity: externalIdentity }],
        publishedExternal: [working],
        primaryPublished: boundary === "after-primary-rename",
        committed: false,
      }));
      if (boundary !== "before-external-rename") renameSync(externalStage, working);
      if (boundary === "after-primary-rename") renameSync(stage, restored);
      if (boundary === "before-external-rename") {
        mkdirSync(working);
        writeFileSync(path.join(working, "foreign"), "must be preserved");
        assert.throws(
          () => restoreOfflineDataDirectoryBackup(backup, restored, { restoreExternalProjects: true }),
          /identity changed/u,
        );
        assert.equal(readFileSync(path.join(working, "foreign"), "utf8"), "must be preserved");
        rmSync(working, { recursive: true, force: true });
      }
      restoreOfflineDataDirectoryBackup(backup, restored, { restoreExternalProjects: true });
      assert.equal(readFileSync(path.join(restored, "ponderosa.db"), "utf8"), "authoritative database");
      assert.equal(readFileSync(path.join(working, "README.md"), "utf8"), "authoritative external bytes\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
