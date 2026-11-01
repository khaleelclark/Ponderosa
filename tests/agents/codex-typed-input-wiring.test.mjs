// Deferred source only. Requires the frozen G6 typed-input/core commits and coordinated build.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CodexAppServerSession } from '../../packages/engines/dist/codex-app-server.js';

async function fixture(action) {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-input-wiring-'));
  const localPath = path.join(dir, 'image.png');
  const body = Buffer.from('admitted image bytes');
  writeFileSync(localPath, body, { mode: 0o600 });
  const file = { id: 'image', kind: 'attachment', attachmentOwnerId: 'chat',
    source: { kind: 'communication', id: 'human' }, original: { localPath, mediaType: 'image/png',
      byteLength: body.length, sha256: createHash('sha256').update(body).digest('hex') } };
  const calls = [];
  const rpc = { processIdentity: undefined, request: async (method, params) => {
    calls.push({ method, params });
    return method === 'thread/settings/update' ? {} : method === 'turn/steer' ? { turnId: 'turn' } : { turn: { id: 'turn' } };
  } };
  // TypeScript private constructor is intentionally exercised in emitted JS without opening a process.
  const session = new CodexAppServerSession('thread', rpc, dir, false, [], 'model', [], undefined, 'fixture');
  try { await action({ session, file, calls }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('start and steer retain exact text and current typed image', async () => fixture(async ({ session, file, calls }) => {
  const input = { prompt: 'Exact descriptor-bound prompt', kind: 'user_message', inputFiles: [file], clientMessageId: 'human' };
  await session.startTurn(input);
  await session.steer(input);
  assert.deepEqual(calls.map(c => c.method), ['turn/start', 'turn/steer']);
  for (const call of calls) {
    assert.deepEqual(call.params.input, [{ type: 'text', text: input.prompt, text_elements: [] }, { type: 'localImage', path: file.original.localPath }]);
    assert.equal(call.params.clientUserMessageId, 'human');
  }
  assert.equal(calls[1].params.expectedTurnId, 'turn');
}));

test('changed bytes reject before plan-settings mutation or native turn submission', async () => fixture(async ({ session, file, calls }) => {
  writeFileSync(file.original.localPath, 'changed');
  await assert.rejects(session.startTurn({ prompt: 'Inspect', kind: 'user_message', inputFiles: [file],
    nativeAction: { kind: 'plan', mode: 'plan', prompt: 'Inspect' } }));
  assert.deepEqual(calls, []);
}));

test('native review refuses attachments rather than dropping admitted media', async () => fixture(async ({ session, file, calls }) => {
  await assert.rejects(session.startTurn({ prompt: 'Review', kind: 'user_message', inputFiles: [file],
    nativeAction: { kind: 'review', target: { type: 'uncommittedChanges' } } }), /does not accept typed attachments/);
  assert.deepEqual(calls, []);
}));

test('current Run fence rejects typed start before provider dispatch', async () => fixture(async ({ session, file, calls }) => {
  await assert.rejects(session.startTurn({ prompt: 'Inspect', kind: 'user_message', inputFiles: [file],
    assertCurrent: () => { throw new Error('revoked fence'); } }), /revoked fence/);
  assert.deepEqual(calls, []);
}));
