import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AgentStore, importedAgentHistoryPath } from '@ponderosa/agents';

async function withStores(t, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-agent-lookup-'));
  const stores = new Set();
  const open = name => { const store = new AgentStore(path.join(root, name)); stores.add(store); return store; };
  const seed = store => {
    const project = store.createProject({ label: 'Lookup fixture', hostPath: root, defaultEngine: 'codex' });
    const chat = store.createConversation(project.id, { title: 'Lookup Chat' });
    return store.createAgent(project.id, { title: 'Lookup Agent', engine: 'codex', conversationId: chat.id });
  };
  let passed = false;
  try { await run({ root, open, seed, close(store) { store.close(); stores.delete(store); } }); passed = true; }
  finally {
    for (const store of stores) store.close();
    if (passed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Failed disposable fixture retained: ${root}`);
  }
}

test('repeated Agent lookups prepare one typed statement per database authority', t => withStores(t, async f => {
  const prepares = new Map(), original = Database.prototype.prepare;
  Database.prototype.prepare = function (sql, ...args) {
    if (sql.startsWith('select ') && sql.includes('from "agents"') &&
        sql.includes('"agents"."id" = ?') && sql.includes('"agents"."deleted_at" is null')) {
      prepares.set(this, (prepares.get(this) ?? 0) + 1);
    }
    return original.call(this, sql, ...args);
  };
  try {
    const first = f.open('first'), a = f.seed(first);
    const second = f.open('second'), b = f.seed(second);
    for (let index = 0; index < 50; index++) {
      assert.deepEqual(first.getAgent(a.id), a);
      assert.deepEqual(second.getAgent(b.id), b);
      assert.equal(first.getAgent(b.id), undefined);
      assert.equal(second.getAgent(a.id), undefined);
    }
    assert.equal(prepares.get(first.sqlite), 1);
    assert.equal(prepares.get(second.sqlite), 1);
  } finally { Database.prototype.prepare = original; }
}));

test('prepared lookups hydrate fresh metadata and retain deletion and owner-Chat guards', t => withStores(t, async f => {
  const store = f.open('fresh'), agent = f.seed(store);
  const initial = store.getAgent(agent.id);
  initial.title = 'Caller mutation';
  assert.equal(store.getAgent(agent.id).title, agent.title);
  const updated = store.updateAgent(agent.id, { title: 'Updated Agent' });
  assert.deepEqual(store.getAgent(agent.id), updated);
  store.setImportedHistory(agent.id, 'Private import', [{ role: 'assistant', text: 'Synthetic history' }]);
  assert.equal(store.getAgent(agent.id).importedFrom, 'Private import');
  assert.equal(store.getAgent(agent.id).importedHistoryCount, 1);
  const before = store.getAgent(agent.id);
  // Exercise row visibility and validation without committing malformed canonical state.
  store.sqlite.exec('SAVEPOINT lookup_visibility');
  try {
    store.sqlite.prepare('UPDATE agents SET deleted_at = ? WHERE id = ?').run('2026-01-01T00:00:00Z', agent.id);
    assert.equal(store.getAgent(agent.id), undefined);
    store.sqlite.prepare('UPDATE agents SET deleted_at = NULL, conversation_id = NULL WHERE id = ?').run(agent.id);
    assert.throws(() => store.getAgent(agent.id), /has no owner Chat/u);
  } finally { store.sqlite.exec('ROLLBACK TO lookup_visibility; RELEASE lookup_visibility'); }
  assert.deepEqual(store.getAgent(agent.id), before);
}));

test('lookups use the reopened database and remain isolated from other stores', t => withStores(t, async f => {
  let first = f.open('reopen');
  const agent = f.seed(first);
  first.updateAgent(agent.id, { title: 'Durable update' });
  const expected = first.getAgent(agent.id);
  f.close(first);
  const other = f.open('independent'), otherAgent = f.seed(other);
  first = f.open('reopen');
  assert.deepEqual(first.getAgent(agent.id), expected);
  assert.equal(other.getAgent(agent.id), undefined);
  assert.equal(first.getAgent(otherAgent.id), undefined);
  assert.equal(first.getAgent('missing-agent'), undefined);
  assert.equal(other.getAgent(otherAgent.id).title, otherAgent.title);
}));

for (const surviving of [false, true]) test(`missing owner Chat is quarantined without reassigning private history; survivor=${surviving}`, t => withStores(t, async f => {
  const store = f.open('missing-owner'), agent = f.seed(store);
  if (surviving) store.createConversation(agent.projectId, { title: 'Unrelated Chat' });
  store.setImportedHistory(agent.id, 'Private source', [{ role: 'user', text: 'Private history must keep its original owner' }]);
  const data = path.join(f.root, 'missing-owner');
  const canonical = path.join(data, 'projects', agent.projectId, 'agents', agent.id, 'agent.json');
  const imported = importedAgentHistoryPath(data, agent.projectId, agent.id);
  const before = await readFile(canonical), history = await readFile(imported);
  f.close(store);
  await rename(path.join(data, 'projects', agent.projectId, 'conversations', agent.conversationId), path.join(f.root, 'owner-retained-for-repair'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = f.open('missing-owner'), projected = reopened.getAgent(agent.id);
    assert.ok(!projected || projected.conversationId === agent.conversationId, 'Recovery must never substitute a surviving Chat');
    assert.equal((await readFile(canonical)).equals(before), true, 'Quarantine must not rewrite canonical ownership');
    assert.equal((await readFile(imported)).equals(history), true, 'Private history must remain intact');
    assert.ok(reopened.startupProfile().recoveryIssues.some(issue => issue.projectId === agent.projectId && issue.detail.includes(agent.conversationId)));
    f.close(reopened);
  }
}));

test('ownership proof change rejects older checkpoints while healthy current checkpoints remain reusable', t => withStores(t, async f => {
  let store = f.open('checkpoint'); const agent = f.seed(store);
  f.close(store); store = f.open('checkpoint'); f.close(store);
  const marker = path.join(f.root, 'checkpoint', '.projection-clean-shutdown.json');
  const certificate = JSON.parse(await readFile(marker, 'utf8'));
  certificate.projectionVersion = 2;
  await writeFile(marker, JSON.stringify(certificate));
  store = f.open('checkpoint');
  assert.equal(store.startupProfile().mode, 'recovery');
  assert.equal(store.getAgent(agent.id).conversationId, agent.conversationId);
  f.close(store); store = f.open('checkpoint');
  assert.equal(store.startupProfile().mode, 'clean');
  assert.equal(store.getAgent(agent.id).conversationId, agent.conversationId);
}));
