import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentStore } from '@ponderosa/agents';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitDataDirectory, readCurrentStateIdentity } from '../../packages/agents/dist/state-admission.js';
import { createOfflineDataDirectoryBackup, restoreOfflineDataDirectoryBackup } from '../../packages/agents/dist/data-directory-backup.js';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ponderosa-external-restore-'));
  const data = path.join(root, 'data'), external = path.join(root, 'external');
  const backup = path.join(root, 'backup'), restored = path.join(root, 'restored');
  admitDataDirectory(data).close();
  mkdirSync(path.join(data, 'projects', 'project-one'), { recursive: true });
  mkdirSync(path.join(external, 'nested'), { recursive: true });
  const bytes = Buffer.from('Saved external result 😀\r\ncomplete bytes\n');
  writeFileSync(path.join(external, 'nested', 'result.txt'), bytes);
  writeFileSync(path.join(data, 'projects', 'project-one', 'project.json'), JSON.stringify({ id: 'project-one', hostPath: external }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, data, external, backup, restored, bytes };
}

function identity(data) {
  const admission = admitDataDirectory(data);
  try { return readCurrentStateIdentity(admission.dataDir); } finally { admission.close(); }
}

test('external-folder backup uses portable manifest paths and native restore preserves complete bytes and generation', t => {
  const f = fixture(t), originalIdentity = identity(f.data);
  const manifest = createOfflineDataDirectoryBackup(f.data, f.backup, { externalProjects: 'copy' });
  assert.equal(manifest.externalProjects.projects[0].snapshotPath, '_external-projects/0-project-one');
  const externalRootParent = path.join(f.root, 'restored-external');
  restoreOfflineDataDirectoryBackup(f.backup, f.restored, { restoreExternalProjects: true, externalRootParent });
  assert.deepEqual(identity(f.restored), originalIdentity);
  assert.deepEqual(readFileSync(path.join(externalRootParent, 'project-one', 'nested', 'result.txt')), f.bytes);
  assert.deepEqual(readFileSync(path.join(f.external, 'nested', 'result.txt')), f.bytes);
  assert.deepEqual(readFileSync(path.join(f.restored, 'projects', 'project-one', 'project.json')),
    readFileSync(path.join(f.data, 'projects', 'project-one', 'project.json')));
  const reopened = admitDataDirectory(f.restored);
  try { assert.equal(reopened.generationId, originalIdentity.generationId); } finally { reopened.close(); }
  assert.throws(() => restoreOfflineDataDirectoryBackup(f.backup, f.restored), /destination already exists/);
});

test('external-folder restore retains strict binding validation before publishing destinations', t => {
  const f = fixture(t), manifest = createOfflineDataDirectoryBackup(f.data, f.backup, { externalProjects: 'copy' });
  const file = path.join(f.backup, 'ponderosa-backup-manifest.json');
  for (const snapshotPath of ['../external', '_external-projects/../external', '/absolute', '_external-projects\\0-project-one']) {
    const invalid = structuredClone(manifest);
    invalid.externalProjects.projects[0].snapshotPath = snapshotPath;
    writeFileSync(file, JSON.stringify(invalid));
    assert.throws(() => restoreOfflineDataDirectoryBackup(f.backup, f.restored, { restoreExternalProjects: true }), /invalid or duplicate external Project backup binding/);
    assert.equal(existsSync(f.restored), false);
  }
  const duplicate = structuredClone(manifest);
  duplicate.externalProjects.projects.push(structuredClone(duplicate.externalProjects.projects[0]));
  writeFileSync(file, JSON.stringify(duplicate));
  assert.throws(() => restoreOfflineDataDirectoryBackup(f.backup, f.restored), /invalid or duplicate external Project backup binding/);
  assert.equal(existsSync(f.restored), false);
  assert.deepEqual(readFileSync(path.join(f.external, 'nested', 'result.txt')), f.bytes);
});

test('data-only restore validates included snapshots without publishing an external working folder', t => {
  const f = fixture(t);
  createOfflineDataDirectoryBackup(f.data, f.backup, { externalProjects: 'copy' });
  restoreOfflineDataDirectoryBackup(f.backup, f.restored);
  assert.deepEqual(identity(f.restored), identity(f.data));
  assert.deepEqual(readFileSync(path.join(f.external, 'nested', 'result.txt')), f.bytes);
});


test('busy native SQLite close retains the AgentStore reference and permits exact retry after the query ends', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ponderosa-close-retry-')), data = path.join(root, 'data');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new AgentStore(data), reference = admitDataDirectory(data), sqlite = reference.client;
  reference.close(); // Leave the Store as the final database/lease owner.
  const query = sqlite.prepare('SELECT 1 AS value UNION ALL SELECT 2').iterate();
  try {
    assert.equal(query.next().value.value, 1);
    assert.throws(() => store.close(), /busy|query/u);
    assert.equal(sqlite.open, true);
    const retained = admitDataDirectory(data);
    assert.equal(retained.client, sqlite); retained.close();
    query.return(); store.close();
    assert.equal(sqlite.open, false);
    store.close(); // Completed disposal is idempotent.
    const reopened = new AgentStore(data); reopened.close();
  } finally { query.return(); store.close(); }
});
