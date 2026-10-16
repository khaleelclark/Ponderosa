import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectAttachments, packageFolder } from '../../apps/web/src/components/chat/folderAttachments.ts';
import { composerSubmissionText, shouldExtractLongPaste } from '../../apps/web/src/components/chat/composerUtils.ts';
import { newChatSubmission, uploadFilesForRecipients, fileSelectionFingerprint } from '../../apps/web/src/conversationRouting.ts';
import { buildMarkdownTranscript } from '../../apps/web/src/chatTranscript.ts';

test('check 19: folder ZIP preserves nested UTF-8 filenames and bytes, rejects unsafe/oversized input', async t => {
  const files = [{ path: 'folder/notes.txt', file: new File(['first 😀\n'], 'notes.txt') }, { path: 'folder/sub/café.txt', file: new File(['second\n'], 'café.txt') }];
  const zip = await packageFolder(files, 1024 * 1024), root = await mkdtemp(path.join(tmpdir(), 'ponderosa-folder-regression-'));
  let passed = false;
  t.after(async () => { if (passed) await rm(root, { recursive: true, force: true }); else t.diagnostic(`Failed folder fixture retained: ${root}`); });
  const archive = path.join(root, 'folder.zip'); await writeFile(archive, Buffer.from(await zip.arrayBuffer()));
  // Python's standard ZIP reader independently validates the archive and CRCs.
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const { stdout } = await promisify(execFile)(python, ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n:z.read(n).decode("utf-8") for n in z.namelist()}))', archive]);
  assert.deepEqual(JSON.parse(stdout), { 'folder/notes.txt': 'first 😀\n', 'folder/sub/café.txt': 'second\n' });
  await assert.rejects(packageFolder([{ path: '../escape.txt', file: files[0].file }], 10000), /unsafe/);
  await assert.rejects(packageFolder(files, 1), /exceeds/);
  await assert.rejects(packageFolder([files[0], files[0]], 10000), /duplicate/);
  const picked = new File(['visible'], 'visible.txt'); Object.defineProperty(picked, 'webkitRelativePath', { value: 'folder/visible.txt' });
  const hidden = new File(['excluded fixture secret'], 'credentials.txt'); Object.defineProperty(hidden, 'webkitRelativePath', { value: 'folder/credentials.txt' });
  const collected = await collectAttachments([picked, hidden], 10000); assert.equal(collected.files.length, 1); assert.equal(collected.skipped, 1);
  passed = true;
});

test('check 20: long paste extraction keeps the complete text separate from ordinary submission text', () => {
  const pasted = 'BEGIN\n' + 'Unicode 😀\n'.repeat(5000) + 'END';
  assert.equal(shouldExtractLongPaste(pasted), true);
  const submission = composerSubmissionText('Read this attached paste', pasted);
  assert.ok(submission.endsWith(pasted)); assert.ok(submission.startsWith('Read this attached paste')); assert.equal(submission.split(pasted).length, 2);
});

test('checks 8, 22: partial recipient upload failure cleans exact successful copies before retry', async () => {
  const files = [new File(['A'], 'a.txt'), new File(['B'], 'b.txt')], cleaned = [], uploads = [];
  await assert.rejects(uploadFilesForRecipients(['reader-a', 'reader-b'], files, async (owner, file) => {
    if (owner === 'reader-b' && file.name === 'b.txt') throw new Error('Definite fixture failure');
    const asset = { id: `${owner}/${file.name}` }; uploads.push(asset.id); return asset;
  }, async (owner, asset) => cleaned.push([owner, asset.id]), undefined, undefined, 0), /Definite fixture failure/);
  assert.deepEqual(cleaned.map(x => x[1]).sort(), uploads.sort());
  const result = await uploadFilesForRecipients(['reader-a', 'reader-b'], files, async (owner, file) => ({ id: `${owner}/${file.name}` }), async () => {});
  for (const recipient of result) assert.ok(recipient.attachments.every(x => x.id.startsWith(recipient.agentId + '/')));
  assert.notDeepEqual(fileSelectionFingerprint(files), fileSelectionFingerprint(files.map(x => new File([x], x.name, { lastModified: x.lastModified }))));
});

test('check 5: ordinary new-Chat input selects Agent creation and explicit Broadcast preserves its intended text', () => {
  assert.deepEqual(newChatSubmission('Ordinary request'), { kind: 'agent', text: 'Ordinary request' });
  assert.deepEqual(newChatSubmission('#broadcast Shared fixture fact'), { kind: 'broadcast', text: 'Shared fixture fact' });
  assert.equal(newChatSubmission('Mention #broadcasting as plain text').kind, 'agent');
});

test('check 83: Chat and Team transcripts contain only their selected communication and disclose partial coverage', () => {
  const shared = [{ author: 'User', text: 'Shared request', attachments: [{ name: 'fixture.txt', downloadUrl: '/api/retained-file' }] }];
  const team = [{ author: 'Worker', text: 'Private collaboration outcome' }];
  const chatExport = buildMarkdownTranscript('Chat', shared), teamExport = buildMarkdownTranscript('Team Chat', team, { hasEarlier: true });
  assert.ok(chatExport.includes('Shared request')); assert.ok(!chatExport.includes(team[0].text));
  assert.ok(teamExport.includes(team[0].text)); assert.ok(!teamExport.includes(shared[0].text)); assert.match(teamExport, /Partial transcript/);
  assert.ok(chatExport.includes('/api/retained-file')); assert.ok(!chatExport.includes('Ordinary fixture execution output'));
});
