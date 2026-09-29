import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, access, open, writeFile } from 'node:fs/promises';
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

for (const pauseAt of ['artifact resolution', 'artifact read']) {
  test(`closing a browser during ${pauseAt} closes the upload handle without staging`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-upload-close-'));
    const body = Buffer.from('%PDF-1.7\nResume fixture\n%%EOF');
    const file = join(root, 'source.pdf');
    await writeFile(file, body);
    const handle = await open(file, 'r');
    const artifact = { id: 'resume', path: 'resume.pdf', size: body.length,
      mediaType: 'application/pdf', sha256: createHash('sha256').update(body).digest('hex') };
    const scope = { projectId: 'chat', agentId: 'agent', runId: 'run' };
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let closeCalls = 0, uploadCalls = 0;
    const content = {
      readRange: async () => {
        if (pauseAt === 'artifact read') { entered.resolve(); await gate.promise; }
        return handle.readFile();
      },
      close: async () => { closeCalls++; await handle.close(); },
    };
    const driver = {
      isAlive: () => true,
      close: async () => {},
      pages: async () => ({ activePageId: 'one', pages: [{ pageId: 'one', active: true,
        isNew: false, closable: false, url: 'https://application.test/form',
        title: 'Application', width: 1280, height: 720 }] }),
      upload: async () => { uploadCalls++; throw Error('upload must not start after close'); },
      cancelPendingFileChooser: async () => {},
    };
    const manager = new BrowserSessionManager(root, async () => driver, () => {}, async () => {
      if (pauseAt === 'artifact resolution') { entered.resolve(); await gate.promise; }
      return { artifact, content };
    });
    try {
      const session = await manager.open(scope, undefined, 'operator');
      const pending = manager.upload(scope, artifact.id, '#resume', 'operator', session.controlEpoch);
      await entered.promise;
      await manager.close(scope);
      gate.resolve();
      await assert.rejects(pending, error => error.statusCode === 409);
      assert.equal(closeCalls, 1);
      assert.equal(uploadCalls, 0);
      await assert.rejects(handle.stat(), /closed|EBADF/i);
      await assert.rejects(access(join(root, 'browser-sessions', session.id, 'uploads')));
    } finally {
      gate.resolve();
      await manager.closeAll('cleanup');
      await handle.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}
