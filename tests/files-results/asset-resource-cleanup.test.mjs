import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { AssetStore } from '../../apps/server/dist/assets.js';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url)), ts = require('typescript');
const source = ts.createSourceFile('assets.ts', readFileSync(new URL('../../apps/server/src/assets.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AssetStore');
const method = name => owner.members.find(node => node.name?.getText(source) === name).getText(source);
const id = 'a'.repeat(8) + '-aaaa-4aaa-8aaa-' + 'a'.repeat(12);

// Run unchanged method bodies, controlling only their filesystem and quota boundaries.
function probe(fault, close = async () => {}) {
  const calls = { open: 0, close: 0, reserve: 0, release: 0, stat: 0, audit: 0 }, failure = Error('Owned fault: ' + fault);
  const hit = phase => { if (fault === phase) throw failure; };
  const handle = { fd: 123, async close() { calls.close++; await close(); }, async sync() { hit('sync'); } };
  const info = { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, dev: 1, ino: 2, size: 4, mtimeMs: 0 };
  const context = { Buffer, Date, path: path.posix, createHash, Error, Set, Map, AssetError: class extends Error { constructor(status, message) { super(message); this.statusCode = status; } },
    fsConstants: { O_RDONLY: 0, O_DIRECTORY: 0, O_NOFOLLOW: 0 }, randomUUID: () => id, STAGED_TTL_MS: 1000, ID: /^[a-f0-9-]{36}$/u,
    lstat: async () => info, mkdir: async () => {},
    realpath: async name => { if (name.startsWith('/proc/')) { hit('realpath'); return fault === 'mismatch' ? '/replaced' : '/owned/projects/project/agents/agent/attachments'; } return name; },
    open: async () => { calls.open++; return handle; },
    readdir: async () => { hit('readdir'); return fault === 'reconcile-rm' ? [id + '.tmp'] : fault === 'reconcile-read' ? [id + '.json'] : fault.startsWith('stat') ? [id + '.bin'] : []; },
    stat: async () => { calls.stat++; hit('stat' + calls.stat); return fault === 'stat-mismatch' && calls.stat === 2 ? { ...info, ino: 3 } : info; },
    prepareAssetUpload: async () => ({ name: 'owned.txt', mediaType: 'text/plain' }),
    canonicalFiles: () => ({ originalFile: id + '.bin' }), assetUrls: () => ({}), publicDto: asset => asset,
    writeAtomic: async () => { hit('write'); }, unlink: async () => {}, rm: async () => { hit('reconcile-rm'); },
  };
  vm.runInNewContext(ts.transpileModule('class Probe {' + ['safeDirectory', 'syncDirectory', 'stage', 'reconcile'].map(method).join('\n') + '} exports.Probe=Probe;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { ...context, exports: context });
  const value = new context.Probe(); value.dataDir = '/owned'; value.dir = () => '/owned/projects/project/agents/agent/attachments'; value.portableFiles = false;
  value.authority = {
    syncAgent() { hit('quota-sync'); }, reserve() { calls.reserve++; hit('reserve'); return 'owned-reservation'; },
    release() { calls.release++; hit('release'); }, settle() { hit('settle'); },
    recordAudit() { calls.audit++; hit(calls.audit === 1 ? 'audit' : 'staged-audit'); },
    runtimeAssociatedAssetIds() { hit('runtime-ids'); return new Set(); },
    pendingDeletions() { hit('pending'); return fault === 'delete' ? [{ assetId: id }] : []; },
  };
  value.read = async () => { hit('reconcile-read'); return undefined; };
  value.completeDeletion = async () => { hit('delete'); };
  return { value, calls, failure, handle, stage: () => value.stage({ projectId: 'project', agentId: 'agent', body: Buffer.from('owned') }) };
}
for (const fault of ['realpath', 'mismatch']) test('Q07 opened directory is closed when descriptor verification fails: ' + fault, async () => {
  const p = probe(fault); await assert.rejects(p.value.safeDirectory('project', 'agent'), fault === 'mismatch' ? /unavailable/u : /Owned fault/u);
  assert.equal(p.calls.open, 1); assert.equal(p.calls.close, 1);
});
test('Q07 verified directory transfers ownership to its caller without an early close', async () => {
  const p = probe('none'), opened = await p.value.safeDirectory('project', 'agent');
  assert.equal(opened.handle, p.handle); assert.equal(p.calls.close, 0); await opened.handle.close(); assert.equal(p.calls.close, 1);
});
for (const fault of ['readdir', 'stat1', 'stat2', 'stat-mismatch', 'quota-sync', 'reserve', 'audit', 'write', 'sync', 'settle', 'staged-audit', 'release']) test('Q07 staging releases its directory and only acquired quota on ' + fault, async () => {
  const p = probe(fault); await assert.rejects(p.stage(), /Owned fault|filesystem changed/u);
  assert.equal(p.calls.open, 1); assert.equal(p.calls.close, 1);
  assert.equal(p.calls.release, ['readdir', 'stat1', 'stat2', 'stat-mismatch', 'quota-sync', 'reserve'].includes(fault) ? 0 : 1);
});
test('Q07 quota rejection waits for directory close before rejecting the upload', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }), p = probe('reserve', () => gate); let settled = false;
  const result = p.stage().catch(error => { settled = true; return error; }); await new Promise(setImmediate);
  assert.equal(p.calls.close, 1); assert.equal(settled, false); release(); assert.equal(await result, p.failure); assert.equal(settled, true);
});
for (const fault of ['runtime-ids', 'pending', 'delete', 'reconcile-read', 'reconcile-rm']) test('Q07 reconciliation closes its directory on ' + fault, async () => {
  const p = probe(fault); await assert.rejects(p.value.reconcile('project', 'agent', new Set(), 10000), /Owned fault/u);
  assert.equal(p.calls.open, 1); assert.equal(p.calls.close, 1);
});
test('Q07 tolerated reconciliation read failure still closes its directory', async () => {
  const p = probe('readdir'); assert.equal(await p.value.reconcile('project', 'agent', new Set()), 0); assert.equal(p.calls.close, 1);
});
test('Q07 repeated real Linux staging read faults retain no directory descriptors and preserve existing bytes', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-q07-fd-')), store = new AssetStore(root), handles = []; let passed = false;
  t.after(async () => { await Promise.all(handles.map(handle => handle.close())); store.close(); if (passed) await rm(root, { recursive: true, force: true }); else t.diagnostic('Retained owned resource fixture: ' + root); });
  const project = randomUUID(), agent = randomUUID(), body = Buffer.from('Exact Q07 retained bytes');
  const saved = await store.stage({ projectId: project, agentId: agent, body, name: 'retained.txt' }); await store.associate(project, agent, [saved.id]);
  const original = store.safeDirectory.bind(store), before = (await readdir('/proc/self/fd')).length;
  store.safeDirectory = async (...args) => { const opened = await original(...args); handles.push(opened.handle); return { ...opened, path: path.join(opened.path, 'missing-owned-leaf') }; };
  for (let i = 0; i < 8; i++) await assert.rejects(store.stage({ projectId: project, agentId: agent, body, name: 'fault.txt' }), /ENOENT|not a directory/u);
  const after = (await readdir('/proc/self/fd')).length; t.diagnostic(`Owned Linux descriptor count before=${before} after=${after} retained=${handles.filter(handle => handle.fd !== -1).length}`);
  assert.ok(handles.every(handle => handle.fd === -1)); assert.equal(after, before);
  store.safeDirectory = original; assert.deepEqual((await store.content(project, agent, saved.id, false)).body, body);
  const next = await store.stage({ projectId: project, agentId: agent, body, name: 'after-fault.txt' }); assert.deepEqual((await store.content(project, agent, next.id, false)).body, body);
  passed = true;
});

const browserSource = ts.createSourceFile('browser-session-residue.ts', readFileSync(new URL('../../apps/server/src/browser-session-residue.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function hosted(fault, close = async () => {}) {
  const calls = { open: 0, close: 0, remove: 0, order: [] }, failure = Error('Owned hosted fault: ' + fault);
  const functions = ['hostedDisplayPaths', 'acquireCleanupClaim', 'reserveHostedDisplay'].map(name => browserSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(browserSource));
  const hit = phase => { if (fault === phase) throw failure; };
  const globals = { path, Date, Error, process: { pid: 123 }, HOSTED_DISPLAY_STALE_MS: 30000, processBirthMarker: () => { hit('birth'); return fault === 'missing-birth' ? undefined : 'owned-birth'; },
    fs: { lstat: async () => { if (fault === 'existing') return {}; throw Error('Absent'); },
      open: async () => { calls.open++; return { async writeFile() { hit('hosted-write'); }, async sync() { hit('hosted-sync'); }, async close() { calls.close++; calls.order.push('close'); await close(); } }; },
      rm: async () => { calls.remove++; calls.order.push('remove'); },
    },
  };
  vm.runInNewContext(ts.transpileModule(functions.join('\n') + '\nexports.claim=acquireCleanupClaim; exports.reserve=reserveHostedDisplay;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { ...globals, exports: globals });
  return { ...globals, calls, failure };
}
for (const [operation, faults] of [['claim', ['hosted-write']], ['reserve', ['birth', 'hosted-write', 'hosted-sync']]]) for (const fault of faults) test('Q07 hosted ' + operation + ' closes its exclusive handle on ' + fault, async () => {
  const p = hosted(fault); await assert.rejects(p[operation](operation === 'claim' ? '/owned-claim' : 123), /Owned hosted fault/u);
  assert.equal(p.calls.open, 1); assert.equal(p.calls.close, 1); assert.equal(p.calls.remove, 0, 'Failure must not broaden partial-claim retirement policy');
});
test('Q07 hosted missing process identity closes before retiring its fresh reservation', async () => {
  const p = hosted('missing-birth'); await assert.rejects(p.reserve(123), /identity is unavailable/u);
  assert.deepEqual(p.calls.order, ['close', 'remove']);
});
test('Q07 hosted existing cleanup ownership prevents another reservation without opening a handle', async () => {
  const p = hosted('existing'); assert.equal(await p.reserve(123), undefined); assert.equal(p.calls.open, 0); assert.equal(p.calls.remove, 0);
});
for (const operation of ['claim', 'reserve']) test('Q07 hosted ' + operation + ' awaits successful close before returning', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }), p = hosted('none', () => gate); let settled = false;
  const result = p[operation](operation === 'claim' ? '/owned-claim' : 123).then(value => { settled = true; return value; }); await new Promise(setImmediate);
  assert.equal(p.calls.close, 1); assert.equal(settled, false); release(); assert.ok(await result); assert.equal(settled, true);
});

test('Q07 staging cannot acknowledge success when closing its owned directory fails', async () => {
  const failure = Error('Owned close refusal'), p = probe('none', async () => { throw failure; });
  await assert.rejects(p.stage(), error => error === failure); assert.equal(p.calls.close, 1); assert.equal(p.calls.release, 1);
});
for (const operation of ['claim', 'reserve']) test('Q07 hosted ' + operation + ' cannot acknowledge success when close fails', async () => {
  const failure = Error('Owned close refusal'), p = hosted('none', async () => { throw failure; });
  await assert.rejects(p[operation](operation === 'claim' ? '/owned-claim' : 123), error => error === failure); assert.equal(p.calls.close, 1);
});
