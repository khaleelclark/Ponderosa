import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentStore } from '@ponderosa/agents';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, symlinkSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { admitDataDirectory, readCurrentStateIdentity } from '../../packages/agents/dist/state-admission.js';
import { createOfflineDataDirectoryBackup, restoreOfflineDataDirectoryBackup, createOfflineWebDeploymentBackup, assertWebOnlyDeploymentCompatibility } from '../../packages/agents/dist/data-directory-backup.js';

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

function webArtifacts(root) {
  const currentRoot = path.join(root, 'installed'), candidateRoot = path.join(root, 'candidate');
  const write = (file, bytes) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); };
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const name of ['server', 'launcher']) {
    const app = path.join(currentRoot, 'app', name);
    write(path.join(app, 'package.json'), '{}');
    const native = path.join(app, 'node_modules', '@ponderosa', 'native-host');
    write(path.join(native, 'package.json'), JSON.stringify({ main: './dist/index.js' }));
    write(path.join(native, 'dist', 'index.js'), 'export {};');
    write(path.join(native, 'build', 'Release', 'ponderosa_native.node'), 'native');
  }
  write(path.join(currentRoot, 'runtime', 'node'), 'node');
  write(path.join(currentRoot, 'package.json'), '{"type":"module"}');
  write(path.join(currentRoot, 'ponderosa'), '#!/bin/sh\nexec runtime/node app/launcher/dist/index.js "$@"\n');
  write(path.join(currentRoot, 'ponderosa.cmd'), '@runtime\\node.exe app\\launcher\\dist\\index.js %*\r\n');
  write(path.join(currentRoot, 'schema', 'current.sql'), 'schema');
  write(path.join(currentRoot, 'app', 'web', 'dist', 'index.html'), 'old UI');
  const manifest = { schemaVersion: 1, product: 'Ponderosa', version: '0.1.1', channel: 'beta', commit: 'a'.repeat(40),
    communicationProtocolVersion: 'communication-v3', databaseSchemaVersion: 'current.sql', databaseSchemaSha256: sha('schema'),
    target: { platform: 'linux', arch: 'x64' }, nodeVersion: 'v24.0.0', nodeExecutableSha256: sha('node'), nodeExecutableBytes: 4,
    nativeAbi: { modules: '137', napi: '10' }, nativeHost: { bytes: 6, sha256: sha('native') } };
  write(path.join(currentRoot, 'build-manifest.json'), JSON.stringify(manifest));
  cpSync(currentRoot, candidateRoot, { recursive: true });
  write(path.join(candidateRoot, 'build-manifest.json'), JSON.stringify({ ...manifest, commit: 'b'.repeat(40) }));
  write(path.join(candidateRoot, 'app', 'web', 'dist', 'index.html'), 'new UI');
  return { currentRoot, candidateRoot };
}

test('web deployment eligibility verifies actual engine/runtime/schema/native bytes, rejects unknown owners and storage changes', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ponderosa-web-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = webArtifacts(root);
  assert.equal(assertWebOnlyDeploymentCompatibility(artifacts.currentRoot, artifacts.candidateRoot).candidateCommit, 'b'.repeat(40));
  const engine = path.join(artifacts.candidateRoot, 'app', 'server', 'package.json');
  writeFileSync(engine, '{"changedStorageOwner":true}');
  assert.throws(() => assertWebOnlyDeploymentCompatibility(artifacts.currentRoot, artifacts.candidateRoot), /storage identity changed/);
  writeFileSync(engine, '{}');
  const schema = path.join(artifacts.candidateRoot, 'schema', 'current.sql');
  writeFileSync(schema, 'tampered schema');
  assert.throws(() => assertWebOnlyDeploymentCompatibility(artifacts.currentRoot, artifacts.candidateRoot), /differs from its build manifest/);
  writeFileSync(schema, 'schema');
  const runtime = path.join(artifacts.candidateRoot, 'runtime', 'node');
  writeFileSync(runtime, 'fake');
  assert.throws(() => assertWebOnlyDeploymentCompatibility(artifacts.currentRoot, artifacts.candidateRoot), /differs from its build manifest/);
  writeFileSync(runtime, 'node');
  const native = path.join(artifacts.candidateRoot, 'app', 'launcher', 'node_modules', '@ponderosa', 'native-host', 'build', 'Release', 'ponderosa_native.node');
  writeFileSync(native, 'broken');
  assert.throws(() => assertWebOnlyDeploymentCompatibility(artifacts.currentRoot, artifacts.candidateRoot), /differs from its build manifest/);
  writeFileSync(native, 'native');
  mkdirSync(path.join(artifacts.candidateRoot, 'app', 'unknown-storage-owner'));
  assert.throws(() => assertWebOnlyDeploymentCompatibility(artifacts.currentRoot, artifacts.candidateRoot), /unknown installed application owner/);
  rmSync(path.join(artifacts.candidateRoot, 'app', 'unknown-storage-owner'), { recursive: true });
  if (process.platform !== 'win32') {
    symlinkSync('../web/dist/index.html', path.join(artifacts.candidateRoot, 'app', 'server', 'unverified-storage.js'));
    assert.throws(() => assertWebOnlyDeploymentCompatibility(artifacts.currentRoot, artifacts.candidateRoot), /escapes verified engine bytes/);
  }
  const privateRoot = path.join(root, 'private'); mkdirSync(privateRoot);
  writeFileSync(path.join(privateRoot, 'PRIVATE_BUILD.json'), '{}');
  assert.throws(() => assertWebOnlyDeploymentCompatibility(privateRoot, artifacts.currentRoot), /private or unknown artifacts require the full backup path/);
});

test('scoped web snapshot retains canonical state and managed artifacts while binding unchanged workspaces in place', t => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ponderosa-web-snapshot-'))), data = path.join(root, 'data'), backup = path.join(root, 'backup');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = webArtifacts(root), store = new AgentStore(data);
  const workspace = path.join(data, 'workspaces', 'owned');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, 'user-result.txt'), 'retained work');
  if (process.platform !== 'win32') symlinkSync('/unavailable-build-output', path.join(workspace, 'absolute-build-link'));
  const project = store.createProject({ label: 'Owned Chat', hostPath: workspace, chatOwned: true, managedWorkspaceName: 'owned' },
    { idempotencyKey: 'web-deployment-fixture', payloadHash: 'a'.repeat(64) });
  const external = path.join(root, 'external'); mkdirSync(external);
  writeFileSync(path.join(external, 'result.txt'), 'external work');
  store.createProject({ label: 'External folder', hostPath: external });
  // Published artifacts and credential material are not working-folder data.
  mkdirSync(path.join(data, 'projects', project.id, 'artifacts'), { recursive: true });
  writeFileSync(path.join(data, 'projects', project.id, 'artifacts', 'published.bin'), 'artifact bytes');
  mkdirSync(path.join(data, 'host-secrets'));
  writeFileSync(path.join(data, 'host-secrets', 'credentials.json'), '{"fixture":"retained"}');
  store.close();
  if (process.platform !== 'win32') {
    const alias = path.join(root, 'data-alias'); symlinkSync(data, alias);
    const output = path.join(alias, 'new-parent', 'backup');
    assert.throws(() => createOfflineWebDeploymentBackup(data, output, artifacts), /outside the Ponderosa data directory/);
    assert.throws(() => createOfflineDataDirectoryBackup(data, output, { externalProjects: 'exclude' }), /outside the Ponderosa data directory/);
    assert.equal(existsSync(path.join(data, 'new-parent')), false);
    const externalAlias = path.join(root, 'external-alias'); symlinkSync(external, externalAlias);
    assert.throws(() => createOfflineWebDeploymentBackup(data, path.join(externalAlias, 'backup'), artifacts), /web-deployment backup refused/);
    assert.throws(() => createOfflineDataDirectoryBackup(data, path.join(externalAlias, 'backup'), { externalProjects: 'copy' }), /backup refused/);
    assert.equal(existsSync(path.join(external, 'backup')), false);
  }
  const manifest = createOfflineWebDeploymentBackup(data, backup, artifacts);
  assert.equal(manifest.scope, 'web-deployment-only-not-disaster-recovery');
  assert.equal(manifest.preservedWorkingFolders.length, 2);
  assert.equal(manifest.preservedWorkingFolders.find(binding => binding.projectId === project.id).path, workspace);
  assert.equal(readFileSync(path.join(external, 'result.txt'), 'utf8'), 'external work');
  assert.equal(existsSync(path.join(backup, 'workspaces')), false);
  assert.equal(existsSync(path.join(backup, 'ponderosa-backup-manifest.json')), false);
  assert.equal(readFileSync(path.join(workspace, 'user-result.txt'), 'utf8'), 'retained work');
  assert.equal(readFileSync(path.join(backup, 'projects', project.id, 'artifacts', 'published.bin'), 'utf8'), 'artifact bytes');
  assert.equal(readFileSync(path.join(backup, 'host-secrets', 'credentials.json'), 'utf8'), '{"fixture":"retained"}');
  assert.deepEqual(readFileSync(path.join(backup, 'ponderosa.db')), readFileSync(path.join(data, 'ponderosa.db')));
  assert.deepEqual(identity(backup), identity(data));
  assert.throws(() => restoreOfflineDataDirectoryBackup(backup, path.join(root, 'restored')), /cannot restore state/);
  const cli = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../../packages/agents/tools/data-directory.mjs', import.meta.url)),
    'backup-web-deployment', '--data-dir', data, '--output', path.join(root, 'cli-backup'),
    '--current-install', artifacts.currentRoot, '--candidate-install', artifacts.candidateRoot], { encoding: 'utf8' }));
  assert.equal(cli.scope, manifest.scope); assert.equal(cli.preservedWorkingFolders, 2);
  if (process.platform !== 'win32') assert.throws(() => createOfflineDataDirectoryBackup(data, path.join(root, 'portable'), { externalProjects: 'exclude' }), /backup refused/);
  const reopened = new AgentStore(data);
  reopened.updateConversation(project.lastConversationId, { title: 'New accepted write' });
  assert.throws(() => createOfflineWebDeploymentBackup(data, path.join(root, 'while-live'), artifacts));
  assert.equal(reopened.getConversation(project.lastConversationId).title, 'New accepted write');
  reopened.close();
  mkdirSync(path.join(data, 'workspaces', 'unowned'));
  assert.throws(() => createOfflineWebDeploymentBackup(data, path.join(root, 'unknown'), artifacts), /web-deployment backup refused/);
  assert.equal(existsSync(path.join(root, 'unknown')), false);
});
