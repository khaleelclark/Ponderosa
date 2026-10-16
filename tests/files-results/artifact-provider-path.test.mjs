import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DataDirectoryAuthority } from '@ponderosa/native-host';
import { mkdirSync, writeFileSync, readFileSync } from '@ponderosa/native-host/fs';
import { appendReadableArtifactReferences } from '../../apps/server/dist/communication-artifacts.js';

test('authorized artifact references expose complete bytes to native provider readers; denied owners expose no path', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-artifact-provider-'));
  // Retain this fixture even on failure for native-platform diagnosis.
  t.diagnostic(`Retained artifact fixture: ${root}`);
  const authority = new DataDirectoryAuthority(root);
  t.after(() => authority.close());
  const projectId = randomUUID(), agentId = randomUUID(), artifactId = randomUUID();
  const bytes = Buffer.from(`BEGIN ${randomUUID()}\n${'Unicode 😀 artifact\n'.repeat(8000)}END ${randomUUID()}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const contentDir = path.join(authority.rootPath, 'artifacts', 'content');
  mkdirSync(contentDir, { recursive: true, mode: 0o700 });
  const localPath = path.join(contentDir, artifactId);
  writeFileSync(localPath, bytes, { mode: 0o600 });
  const artifact = { id: artifactId, projectId };
  let authorityReads = 0;
  const store = {
    getProjectArtifact: (owner, id) => owner === projectId && id === artifactId ? artifact : undefined,
    agentCanReadProjectArtifact: (owner, id, reader) => owner === projectId && id === artifactId && reader === agentId,
  };
  const assets = { authoritativeManagedProjectArtifact: (owner, expected) => {
    assert.equal(owner, projectId); assert.equal(expected, artifact); authorityReads++;
    const body = readFileSync(localPath);
    assert.equal(createHash('sha256').update(body).digest('hex'), sha256);
    return { localPath, body, contentHash: sha256, byteLength: body.length };
  } };
  const prompt = `Read ponderosa://artifact/${artifactId}`;
  const compile = (owner, reader) => appendReadableArtifactReferences({ prompt, projectId: owner, agentId: reader, store, assets });
  const allowed = compile(projectId, agentId);
  const reference = JSON.parse(allowed.split('\n').find(line => line.startsWith('{')));
  assert.equal(reference.artifactId, artifactId);
  assert.equal(reference.byteLength, bytes.length);
  assert.equal(reference.sha256, sha256);
  assert.deepEqual(await readFile(reference.localPath), bytes);
  assert.ok(!allowed.includes(bytes.toString()), 'The complete answer must come from reading, not prompt substitution');
  assert.equal(authorityReads, 1);
  for (const [owner, reader] of [[projectId, randomUUID()], [randomUUID(), agentId]]) {
    const denied = JSON.parse(compile(owner, reader).split('\n').find(line => line.startsWith('{')));
    assert.deepEqual(denied, { artifactId, available: false });
    assert.equal(authorityReads, 1, 'Denied references must not read or expose artifact content');
  }
});
