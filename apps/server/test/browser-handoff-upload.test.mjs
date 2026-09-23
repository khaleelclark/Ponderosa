import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BrowserSessionManager } from '../dist/browser-session-manager.js';

test('user/agent handoff preserves attached draft files and staging until session teardown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-handoff-upload-'));
  const body = Buffer.from('%PDF-1.7\nResume fixture\n%%EOF');
  const artifact = { id: 'resume', path: 'resume.pdf', size: body.length, mediaType: 'application/pdf', sha256: createHash('sha256').update(body).digest('hex') };
  const scope = { projectId: 'chat', agentId: 'agent', runId: 'run' };
  const info = { url: 'https://application.test/form', title: 'Application', width: 1280, height: 720 };
  let alive = true, stagedPath, attached = false, clears = 0;
  const driver = {
    isAlive: () => alive,
    close: async () => { alive = false; },
    pages: async () => ({ activePageId: 'one', pages: [{ ...info, pageId: 'one', active: true, isNew: false, closable: false }] }),
    upload: async input => { stagedPath = input.stagedPath; attached = true; return { ...info, pageId: 'one', input: { name: input.expectedName, size: input.expectedSize, type: input.expectedMediaType, count: 1 } }; },
    clearUploadedFiles: async () => { clears++; attached = false; },
    cancelPendingFileChooser: async () => {},
  };
  const manager = new BrowserSessionManager(root, async () => driver, () => {}, async () => ({ artifact, content: { readRange: async () => body, close: async () => {} } }));
  try {
    let session = await manager.open(scope, undefined, 'operator');
    await manager.upload(scope, artifact.id, '#resume', 'operator', session.controlEpoch);
    const oldEpoch = session.controlEpoch;
    session = await manager.setControl(scope, 'agent', oldEpoch);
    assert.ok(session.controlEpoch > oldEpoch);
    session = await manager.setControl(scope, 'operator', session.controlEpoch);
    assert.equal(attached, true); assert.equal(clears, 0);
    await access(stagedPath);
    await assert.rejects(manager.setControl(scope, 'agent', oldEpoch), /control changed/);
    await manager.closeAll('test complete');
    assert.equal(alive, false);
    await assert.rejects(access(stagedPath));
  } finally { await manager.closeAll('cleanup'); await rm(root, { recursive: true, force: true }); }
});
