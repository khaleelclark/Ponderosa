import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  managedArtifactStorageFilename, managedArtifactContentPath,
  publishManagedArtifactContent, publishManagedArtifactContentAsync, publishManagedArtifactContentsAsync,
  readManagedArtifactContent, readManagedArtifactContentsAsync, openManagedArtifactContent,
  removeManagedArtifactContent, repairManagedArtifactContent,
} from '@ponderosa/agents';

const hash = body => createHash('sha256').update(body).digest('hex');
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ponderosa-artifact-storage-'));
  const project = 'fixture-project', directory = path.join(root, 'projects', project, 'artifacts', 'content');
  mkdirSync(directory, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, directory };
}

// No provider account or platform emulation: native publication/read/removal
// run on the host OS, with fresh disposable bytes and the actual worker modules.
test('logical identities map deterministically to distinct portable storage leaves', () => {
  const ids = ['agent:a:12:0', 'agent:a:12:1', 'Case', 'case', 'CON', 'résultat 😀', 'artifact-' + 'a'.repeat(64), '\ud800', '\ud801'];
  const names = ids.map(managedArtifactStorageFilename);
  assert.equal(new Set(names).size, ids.length);
  for (const [index, name] of names.entries()) {
    assert.match(name, /^artifact-[a-f0-9]{64}$/);
    assert.equal(name, managedArtifactStorageFilename(ids[index]));
    assert.equal(path.win32.basename(name), name);
  }
  for (const id of ['', '.', '..', '../escape', '/absolute', 'a/b', 'a\\b', 'nul\0byte', 'x'.repeat(256)]) {
    assert.throws(() => managedArtifactStorageFilename(id), /bounded leaf/);
  }
});

test('native publication and fresh read workers preserve colon IDs, exact bytes and immutable identity', async t => {
  const f = fixture(t), id = 'agent:a:12:0', body = Buffer.from('Complete diff/result 😀\n' + 'line\n'.repeat(1000));
  const published = await publishManagedArtifactContentAsync(f.root, f.project, id, body);
  assert.equal(path.basename(published.path), managedArtifactStorageFilename(id));
  assert.equal(published.sha256, hash(body)); assert.equal(published.size, body.length);
  assert.deepEqual(readdirSync(f.directory), [managedArtifactStorageFilename(id)]);
  assert.deepEqual(readManagedArtifactContent(f.root, f.project, id, body.length, hash(body)).body, body);
  assert.deepEqual(await readManagedArtifactContentsAsync(f.root, f.project, [{ artifactId: id, expectedSize: body.length, expectedSha256: hash(body) }]), [body]);
  const reopened = await openManagedArtifactContent(f.root, f.project, id, body.length, hash(body));
  assert.ok(reopened); assert.deepEqual(await reopened.readRange(body.length), body); await reopened.close();
  assert.equal(publishManagedArtifactContent(f.root, f.project, id, body).path, published.path);
  assert.throws(() => publishManagedArtifactContent(f.root, f.project, id, 'different bytes'), /collision/);
  assert.deepEqual(readFileSync(published.path), body);
});

test('safe import filenames and legacy POSIX colon leaves remain readable and are never rewritten on replay', async t => {
  const f = fixture(t), ids = ['safe-import-copy', ...(process.platform === 'win32' ? [] : ['agent:legacy:12:0'])];
  for (const id of ids) {
    const body = Buffer.from('Legacy immutable ' + id), old = path.join(f.directory, id); writeFileSync(old, body);
    assert.equal(managedArtifactContentPath(f.root, f.project, id), old);
    assert.deepEqual(readManagedArtifactContent(f.root, f.project, id, body.length, hash(body)).body, body);
    assert.deepEqual(await readManagedArtifactContentsAsync(f.root, f.project, [{ artifactId: id, expectedSize: body.length, expectedSha256: hash(body) }]), [body]);
    assert.equal(publishManagedArtifactContent(f.root, f.project, id, body).path, old);
    assert.throws(() => publishManagedArtifactContent(f.root, f.project, id, 'conflict'), /collision/);
    assert.equal(existsSync(path.join(f.directory, managedArtifactStorageFilename(id))), false);
    assert.deepEqual(readFileSync(old), body);
  }
});

test('corrupt portable content cannot downgrade to valid legacy bytes', async t => {
  const f = fixture(t), id = 'safe-existing', body = Buffer.from('canonical bytes');
  writeFileSync(path.join(f.directory, id), body);
  writeFileSync(path.join(f.directory, managedArtifactStorageFilename(id)), 'corrupt');
  assert.equal(readManagedArtifactContent(f.root, f.project, id, body.length, hash(body)), undefined);
  assert.deepEqual(await readManagedArtifactContentsAsync(f.root, f.project, [{ artifactId: id, expectedSize: body.length, expectedSha256: hash(body) }]), [undefined]);
  assert.equal(await openManagedArtifactContent(f.root, f.project, id, body.length, hash(body)), undefined);
  assert.throws(() => publishManagedArtifactContent(f.root, f.project, id, body), /collision/);
  assert.deepEqual(readFileSync(path.join(f.directory, id)), body);
});

test('pruning protects logical references and active mapped/legacy publication leaves', async t => {
  const f = fixture(t), id = 'agent:busy:1:0', leaf = managedArtifactStorageFilename(id), body = Buffer.from('live publication');
  const temporary = '.' + leaf + '.fixture.tmp'; writeFileSync(path.join(f.directory, temporary), 'retained while active');
  const publication = publishManagedArtifactContentAsync(f.root, f.project, id, body);
  assert.deepEqual(repairManagedArtifactContent(f.root, f.project, new Set(), Date.now() + 1000), []);
  await publication;
  const legacy = 'legacy-reference'; writeFileSync(path.join(f.directory, legacy), body);
  const orphan = 'agent:orphan:2:0'; await publishManagedArtifactContentsAsync(f.root, f.project, [{ artifactId: orphan, input: body }]);
  const removed = repairManagedArtifactContent(f.root, f.project, new Set([id, legacy]), Date.now() + 1000);
  assert.deepEqual(new Set(removed), new Set([temporary, managedArtifactStorageFilename(orphan)]));
  assert.ok(existsSync(path.join(f.directory, leaf))); assert.ok(existsSync(path.join(f.directory, legacy)));
});

test('identity-bound removal handles both layouts and refuses wrong bytes and hard links', t => {
  const f = fixture(t), id = 'safe-dual-layout', body = Buffer.from('retained bytes'), digest = hash(body);
  const file = publishManagedArtifactContent(f.root, f.project, id, body).path;
  writeFileSync(path.join(f.directory, id), body);
  assert.equal(removeManagedArtifactContent(f.root, f.project, id, body.length, hash('wrong')), false);
  assert.equal(removeManagedArtifactContent(f.root, f.project, id, 0, digest), false);
  assert.equal(removeManagedArtifactContent(f.root, f.project, id, body.length, digest), true);
  assert.equal(existsSync(file), false); assert.equal(existsSync(path.join(f.directory, id)), false);
  const linkedId = 'agent:linked:3:0', linked = publishManagedArtifactContent(f.root, f.project, linkedId, body).path;
  const outside = path.join(f.root, 'outside-content'); linkSync(linked, outside);
  assert.equal(readManagedArtifactContent(f.root, f.project, linkedId, body.length, digest), undefined);
  assert.equal(removeManagedArtifactContent(f.root, f.project, linkedId, body.length, digest), false);
  repairManagedArtifactContent(f.root, f.project, new Set(), Date.now() + 1000);
  assert.deepEqual(readFileSync(outside), body); assert.ok(existsSync(linked));
  assert.throws(() => publishManagedArtifactContent(f.root, '../escape', 'safe', body), /Project/);
});

test('a restarted Node process reads the same logical artifact identity and bytes', t => {
  const f = fixture(t), id = 'agent:restart:12:0', body = Buffer.from('Restart-retained Unicode 😀 bytes');
  const published = publishManagedArtifactContent(f.root, f.project, id, body);
  const source = `import { readManagedArtifactContent } from '@ponderosa/agents';
    const [root, project, id, size, sha] = process.argv.slice(1);
    const file = readManagedArtifactContent(root, project, id, Number(size), sha);
    if (!file) throw new Error('Restarted artifact read unavailable');
    process.stdout.write(JSON.stringify({ id, bytes: file.body.toString('base64'), sha256: file.sha256, size: file.size, path: file.path }));`;
  const restored = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', source,
    f.root, f.project, id, String(body.length), hash(body)], {
    cwd: fileURLToPath(new URL('../../apps/server/', import.meta.url)), encoding: 'utf8', timeout: 10000,
  }));
  assert.equal(restored.id, id); assert.equal(restored.path, published.path);
  assert.equal(restored.sha256, hash(body)); assert.equal(restored.size, body.length);
  assert.deepEqual(Buffer.from(restored.bytes, 'base64'), body);
});
