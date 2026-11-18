import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectAttachments, packageFolder } from '../../apps/web/src/components/chat/folderAttachments.ts';
import { composerSubmissionText, shouldExtractLongPaste } from '../../apps/web/src/components/chat/composerUtils.ts';
import { managerBroadcastText, uploadFilesForRecipients, fileSelectionFingerprint } from '../../apps/web/src/conversationRouting.ts';
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
  await assert.rejects(packageFolder([{ path: '../escape.txt', file: files[0].file }], 10000), /unsafe/i);
  await assert.rejects(packageFolder(files, 1), /exceeds/);
  await assert.rejects(packageFolder([files[0], files[0]], 10000), /Duplicate path/);
  const picked = new File(['visible'], 'visible.txt'); Object.defineProperty(picked, 'webkitRelativePath', { value: 'folder/visible.txt' });
  const hidden = new File(['excluded fixture secret'], 'credentials.txt'); Object.defineProperty(hidden, 'webkitRelativePath', { value: 'folder/credentials.txt' });
  const collected = await collectAttachments([picked, hidden], 10000); assert.equal(collected.files.length, 1); assert.equal(collected.folders[0].excluded.length, 1);
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
  assert.equal(managerBroadcastText('Ordinary request'), undefined);
  assert.equal(managerBroadcastText('#broadcast Shared fixture fact'), 'Shared fixture fact');
  assert.equal(managerBroadcastText('Mention #broadcasting as plain text'), undefined);
});

test('check 83: Chat and Team transcripts contain only their selected communication and disclose partial coverage', () => {
  const shared = [{ author: 'User', text: 'Shared request', attachments: [{ name: 'fixture.txt', downloadUrl: '/api/retained-file' }] }];
  const team = [{ author: 'Worker', text: 'Private collaboration outcome' }];
  const chatExport = buildMarkdownTranscript('Chat', shared), teamExport = buildMarkdownTranscript('Team Chat', team, { hasEarlier: true });
  assert.ok(chatExport.includes('Shared request')); assert.ok(!chatExport.includes(team[0].text));
  assert.ok(teamExport.includes(team[0].text)); assert.ok(!teamExport.includes(shared[0].text)); assert.match(teamExport, /Partial transcript/);
  assert.ok(chatExport.includes('/api/retained-file')); assert.ok(!chatExport.includes('Ordinary fixture execution output'));
});

const pickedFile = (path, bytes = path) => {
  const file = new File([bytes], path.split('/').at(-1));
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
};
const fileEntry = (name, bytes = name, onRead = () => {}) => ({ name, isFile: true, isDirectory: false,
  file(yes) { onRead(); yes(new File([bytes], name)); } });
const folderEntry = (name, children) => ({ name, isFile: false, isDirectory: true,
  createReader() { let index = 0; return { readEntries(yes) { yes(index < children.length ? [children[index++]] : []); } }; } });
const inspectZip = async (zip, t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-project-import-'));
  const archive = path.join(root, 'project.zip');
  await writeFile(archive, Buffer.from(await zip.arrayBuffer()));
  let passed = false;
  t.after(async () => { if (passed) await rm(root, { recursive: true, force: true }); else t.diagnostic(`ZIP fixture retained: ${root}`); });
  const { stdout } = await promisify(execFile)(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c',
    'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n:list(z.read(n)) for n in z.namelist()}))', archive]);
  passed = true;
  return JSON.parse(stdout);
};

test('project folder imports retain dotfiles, templates, extensionless files, Unicode and exact zero/binary bytes', async t => {
  const paths = ['.gitignore', '.gitattributes', '.editorconfig', '.github/workflows/build.yml', '.vscode/settings.json', '.env.example', '.env.local.template', 'Dockerfile', 'Makefile', 'pnpm-lock.yaml', 'src/café.ts', 'empty'];
  const files = paths.map(path => pickedFile(`project/${path}`, path === 'empty' ? new Uint8Array() : new Uint8Array([0, 255, 42])));
  const result = await collectAttachments(files, 100000);
  assert.equal(result.folders[0].excluded.length, 0);
  assert.equal(result.folders[0].fileCount, paths.length);
  const contents = await inspectZip(result.files[0], t);
  assert.deepEqual(contents, Object.fromEntries(paths.map(path => [`project/${path}`, path === 'empty' ? [] : [0, 255, 42]])));
});

test('drop and folder picker share exact component exclusions and reviewable ambiguous names', async t => {
  let protectedReads = 0;
  const dropped = folderEntry('project', [fileEntry('.gitignore'), folderEntry('.github', [fileEntry('build.yml')]),
    folderEntry('.git', [fileEntry('config', 'private', () => protectedReads++)]),
    folderEntry('node_modules', [fileEntry('index.js', 'dependency', () => protectedReads++)]),
    fileEntry('.DS_Store'), fileEntry('.env', 'private', () => protectedReads++),
    fileEntry('credentials.md', 'documentation', () => protectedReads++), fileEntry('design.key', 'presentation', () => protectedReads++)]);
  const drop = await collectAttachments([dropped], 100000);
  assert.equal(protectedReads, 0, 'excluded directories and credential candidates are not read');
  const picked = await collectAttachments(['.gitignore', '.github/build.yml', '.git/config', 'node_modules/index.js', '.DS_Store', '.env', 'credentials.md', 'design.key'].map(path => pickedFile(`project/${path}`)), 100000);
  assert.deepEqual(drop.folders[0].excluded, picked.folders[0].excluded);
  assert.equal(drop.folders[0].excluded.filter(item => item.kind === 'folder').length, 2);
  assert.equal(drop.folders[0].excluded.filter(item => item.kind === 'file').length, 4);
  assert.equal(drop.folders[0].excluded.find(item => item.path.endsWith('design.key')).canInclude, true);
  assert.match(drop.folders[0].excluded.find(item => item.path.endsWith('/.git')).reason, /internals/);
  const rebuilt = await collectAttachments([dropped], 100000, () => {}, new Set(['project/design.key', 'project/credentials.md']));
  assert.equal(protectedReads, 2);
  assert.deepEqual(Object.keys(await inspectZip(rebuilt.files[0], t)), ['project/.gitignore', 'project/.github/build.yml', 'project/credentials.md', 'project/design.key']);
  assert.ok(rebuilt.folders[0].excluded.some(item => item.path === 'project/.git'), 'Git internals remain automatic exclusions');
});

test('all-excluded, empty, multiple same-named roots and individual opaque files are distinct results', async () => {
  const all = await collectAttachments([folderEntry('project', [fileEntry('.env')])], 100000);
  assert.equal(all.files.length, 0); assert.equal(all.folders[0].excluded.length, 1);
  const empty = await collectAttachments([folderEntry('empty', [])], 100000);
  assert.equal(empty.files.length, 0); assert.equal(empty.folders[0].excluded.length, 0);
  const both = await collectAttachments([folderEntry('project', [fileEntry('a')]), folderEntry('project', [fileEntry('b')])], 100000);
  assert.equal(both.files.length, 2); assert.notEqual(both.files[0], both.files[1]);
  const opaque = new File(['opaque existing ZIP'], 'private.zip');
  const credential = new File(['deliberately selected'], '.env');
  assert.deepEqual((await collectAttachments([opaque, credential], 100000)).files, [opaque, credential]);
});

test('hard failures retain exact paths and do not return partial folder attachments', async () => {
  const readable = folderEntry('good', [fileEntry('first.txt')]);
  const unreadable = folderEntry('bad', [{ name: 'locked.txt', isFile: true, file(_yes, no) { no(new Error('Permission denied')); } }]);
  await assert.rejects(collectAttachments([readable, unreadable], 100000), /bad\/locked.txt: Permission denied.*nothing was attached/);
  await assert.rejects(collectAttachments([pickedFile('project/../escape')], 100000), /project\/\.\.\/escape.*Unsafe path/);
  await assert.rejects(collectAttachments([pickedFile('root/' + 'deep/'.repeat(16) + 'file')], 100000), /depth over 16/);
  await assert.rejects(collectAttachments([pickedFile('root/' + 'a'.repeat(1025))], 100000), /1,024 bytes/);
  await assert.rejects(collectAttachments(Array.from({ length: 2049 }, (_, i) => pickedFile(`root/${i}`)), 100000), /2,048/);
  await assert.rejects(collectAttachments([pickedFile('root/large', 'x'.repeat(100))], 30), /root\/large.*size limit/);
  let active = true, finish;
  const held = folderEntry('held', [{ name: 'slow', isFile: true, file(yes) { finish = () => yes(new File(['late'], 'slow')); } }]);
  const pending = collectAttachments([held], 100000, () => { if (!active) throw new Error('Owner changed'); });
  await new Promise(resolve => setImmediate(resolve)); active = false; finish();
  await assert.rejects(pending, /Owner changed/);
});

test('unreadable folder timeout names the affected path and does not attach a partial archive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = { name: 'locked-folder', isDirectory: true, createReader() { return { readEntries() {} }; } };
  const pending = collectAttachments([held], 100000);
  t.mock.timers.tick(10001);
  await assert.rejects(pending, /locked-folder: Reading the folder timed out.*Check access/);
});

test('review inclusion must find the exact selected path rather than claiming a missing file was included', async () => {
  const initial = folderEntry('project', [fileEntry('safe'), fileEntry('design.key')]);
  const first = await collectAttachments([initial], 100000);
  assert.equal(first.folders[0].excluded.length, 1);
  const changed = folderEntry('project', [fileEntry('safe')]);
  await assert.rejects(collectAttachments([changed], 100000, () => {}, new Set(['project/design.key'])), /project\/design.key:.*no longer available.*attachment was not changed/);
});


test('ZIP overhead and duplicate path failures identify the affected root/member and a next action', async () => {
  await assert.rejects(collectAttachments([pickedFile('overhead/file', 'x')], 50), /overhead:.*archive overhead.*Choose fewer files/);
  await assert.rejects(collectAttachments([pickedFile('duplicate/member', 'a'), pickedFile('duplicate/member', 'b')], 100000), /duplicate\/member: Duplicate path.*rename/);
});


test('reviewed inclusion cannot broaden a file into a directory or silently change a directory into a file', async () => {
  for (const [before, after] of [['file', 'folder'], ['folder', 'file']]) {
    const entry = after === 'folder' ? folderEntry('design.key', [fileEntry('unreviewed-child')]) : fileEntry('design.key');
    await assert.rejects(collectAttachments([folderEntry('project', [fileEntry('safe'), entry])], 100000, () => {}, new Set(['project/design.key']), new Map([['project/design.key', before]])), new RegExp(`project/design.key: The item changed from ${before} to ${after}.*review it`));
  }
});
