// Deferred source fixtures. No service/provider/browser is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activationInputAttachmentSource,
  currentArtifactInputFiles,
  requireCurrentRuntimeInputAccess,
  runtimeInputFilesContext,
} from '../dist/runtime-input-files.js';

const material = { localPath: '/managed/original', mediaType: 'image/png', byteLength: 1, sha256: 'a'.repeat(64) };
const file = { id: 'private-image', kind: 'artifact', source: { kind: 'communication', id: 'current' }, original: material };

test('artifact IDs in current prose cannot expand private access or cause private bytes to be read', () => {
  let reads = 0;
  const files = currentArtifactInputFiles({ projectId: 'project', agentId: 'recipient',
    communications: [{ projectId: 'project', eventId: 'current', text: 'ponderosa://artifact/private-image' }],
    store: { getProjectArtifact: () => ({ id: 'private-image' }), agentCanReadProjectArtifact: () => false },
    assets: { authoritativeManagedProjectArtifact: () => { reads++; throw new Error('private read'); } },
  });
  assert.deepEqual(files, []);
  assert.equal(reads, 0);
});

test('current permission revocation refuses recorded media before reading bytes', () => {
  assert.throws(() => requireCurrentRuntimeInputAccess({ files: [file], projectId: 'project', agentId: 'recipient',
    store: { getAgent: () => ({ id: 'recipient', projectId: 'project', conversationId: 'chat' }),
      getProjectArtifact: () => { throw new Error('must not read'); }, agentCanReadProjectArtifact: () => false },
    assets: { authoritativeManagedProjectArtifact: () => { throw new Error('must not read'); } },
  }), /Current access/);
});

test('attachment provenance comes from exact recipient dispatch, never arbitrary payload text', () => {
  const payload = { text: 'private-image', dispatch: { recipients: [
    { agentId: 'other', attachments: [{ id: 'private-image' }] },
    { agentId: 'recipient', attachments: [] },
  ] } };
  assert.equal(activationInputAttachmentSource([{ id: 'activation', payload }], 'recipient', 'private-image'), undefined);
  payload.dispatch.recipients[1].attachments.push({ id: 'private-image' });
  assert.deepEqual(activationInputAttachmentSource([{ id: 'activation', payload }], 'recipient', 'private-image'),
    { kind: 'activation', id: 'activation' });
});

test('descriptor context retains source and original digest without embedded media data', () => {
  const context = runtimeInputFilesContext([file]);
  assert.ok(context.includes(JSON.stringify([file])));
  assert.ok(context.includes('not evidence of native media understanding'));
  assert.equal(context.includes('base64'), false);
});
