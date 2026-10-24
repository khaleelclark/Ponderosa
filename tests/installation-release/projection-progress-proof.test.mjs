import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { initializeCurrentDatabase } from '../../packages/agents/dist/db.js';
import { ProjectionProgress, consumeProjectionCheckpoint } from '../../packages/agents/dist/projection-checkpoint.js';
const require = createRequire(new URL('../../packages/agents/package.json', import.meta.url));
const Database = require('better-sqlite3');
const eventPath = 'projects/p/agents/a/events.jsonl';

function fixture(t, seed) {
  const root = mkdtempSync(path.join(tmpdir(), 'ponderosa-progress-proof-'));
  mkdirSync(path.join(root, path.dirname(eventPath)), { recursive: true });
  writeFileSync(path.join(root, eventPath), '{"seq":1}\n');
  let db = new Database(path.join(root, 'ponderosa.db'));
  db.pragma('journal_mode = WAL'); initializeCurrentDatabase(db); seed?.(db);
  const mainSchema = () => db.prepare(`SELECT type,name,sql FROM sqlite_master ORDER BY name`).all();
  const schema = mainSchema(), progress = new ProjectionProgress(root, db);
  assert.deepEqual(mainSchema(), schema, 'Proof tracking must not change the admitted main schema');
  progress.initialize();
  t.after(() => { if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, progress, get db() { return db; }, file: path.join(root, eventPath),
    append: text => appendFileSync(path.join(root, eventPath), text),
    reopen() { db.close(); db = new Database(path.join(root, 'ponderosa.db')); return consumeProjectionCheckpoint(root, db); } };
}
const insert = db => db.prepare(`INSERT INTO messages(id,agent_id,seq,role,text,created_at) VALUES(?,?,?,?,?,?)`).run('m','a',1,'agent','retained text','2026-10-24');

test('supported write-active lifetime and V3-only writes produce a consumed clean certificate', t => {
  const f = fixture(t);
  for (let seq = 2; seq <= 4; seq++) f.progress.run([f.file], () => {
    f.append(`{"seq":${seq}}\n`);
    f.db.prepare(`INSERT INTO messages(id,agent_id,seq,role,text,created_at) VALUES(?,?,?,?,?,?)`).run(`m${seq}`,'a',seq,'agent',`text ${seq}`,'2026-10-24');
  });
  f.db.prepare(`INSERT INTO scheduler_agent_fences VALUES('a',2)`).run();
  f.progress.checkpoint();
  assert.deepEqual(f.reopen(), { tails: [] });
  assert.equal(consumeProjectionCheckpoint(f.root, f.db), false, 'A consumed proof cannot survive an interrupted lifetime');
});

test('failed canonical append retains its prior prefix while SQLite projection rolls back', t => {
  const f = fixture(t), prior = readFileSync(f.file);
  assert.throws(() => f.progress.run([eventPath], () => { f.append('{"seq":2}\n'); insert(f.db); throw new Error('projection failed'); }));
  assert.equal(f.db.prepare('SELECT count(*) n FROM messages').get().n, 0);
  f.progress.checkpoint();
  assert.deepEqual(f.reopen(), { tails: [{ path: eventPath, offset: prior.length, sha256: createHash('sha256').update(prior).digest('hex') }] });
});

test('nested source overlap acknowledges each byte once and remains clean', t => {
  const f = fixture(t);
  f.progress.run([eventPath], () => {
    f.progress.run([eventPath], () => { f.append('{"seq":2}\n'); insert(f.db); });
    f.append('{"seq":3}\n');
  });
  f.progress.checkpoint(); assert.deepEqual(f.reopen(), { tails: [] });
});

test('a caught nested projection failure cannot be laundered by its successful parent', t => {
  const f = fixture(t);
  f.progress.run([eventPath], () => {
    assert.throws(() => f.progress.run([eventPath], () => { f.append('{"seq":2}\n'); insert(f.db); throw new Error('failed child'); }));
  });
  assert.throws(() => f.progress.checkpoint(), /uncertain/);
});

test('an unknown projection mutation remains invalid after a later supported owner succeeds', t => {
  const f = fixture(t, insert);
  f.db.prepare('DELETE FROM messages').run();
  f.progress.run([eventPath], () => f.append('{"seq":2}\n'));
  assert.throws(() => f.progress.checkpoint(), /uncertain|unaccounted/);
});

test('failed append followed by another owner cannot skip its unprojected prefix', t => {
  const f = fixture(t);
  assert.throws(() => f.progress.run([eventPath], () => { f.append('{"seq":2}\n'); throw new Error('failed projection'); }));
  f.progress.run([eventPath], () => f.append('{"seq":3}\n'));
  assert.throws(() => f.progress.checkpoint(), /uncertain/);
});

test('replaced files, modified prefixes, and unrelated metadata force recovery', async t => {
  for (const kind of ['replace', 'prefix', 'metadata']) await t.test(kind, sub => {
    const f = fixture(sub);
    assert.throws(() => f.progress.run([eventPath], () => { f.append('{"seq":2}\n'); throw new Error('failed projection'); }));
    if (kind === 'replace') { const copy = f.file + '.replacement'; writeFileSync(copy, readFileSync(f.file)); renameSync(copy, f.file); }
    if (kind === 'prefix') writeFileSync(f.file, '{"seq":9}\n{"seq":2}\n');
    if (kind === 'metadata') writeFileSync(path.join(f.root, 'unknown.json'), '{}');
    assert.throws(() => f.progress.checkpoint(), /canonical change/);
  });
});

test('new append file can preserve an empty prefix after its first failed append', t => {
  const f = fixture(t), relative = 'projects/p/communication-events.jsonl';
  assert.throws(() => f.progress.run([relative], () => { appendFileSync(path.join(f.root, relative), '{"eventId":"new"}\n'); throw new Error('projection failed'); }));
  f.progress.checkpoint();
  assert.deepEqual(f.reopen(), { tails: [{ path: relative, offset: 0, sha256: createHash('sha256').digest('hex') }] });
});

test('FTS coherent deletion and text damage cannot be certified', async t => {
  for (const sql of ['DELETE FROM compaction_history_fts', "UPDATE compaction_history_fts SET text='wrong'"]) await t.test(sql, sub => {
    const f = fixture(sub, db => {
      db.prepare(`INSERT INTO compaction_history_messages(project_id,communication_event_id,canonical_ordinal,created_at,content_sha256,text) VALUES('p','c',1,'2026-10-24','hash','retained text')`).run();
      db.exec(`INSERT INTO compaction_history_fts(rowid,project_id,communication_event_id,text) SELECT rowid,project_id,communication_event_id,text FROM compaction_history_messages`);
    });
    f.db.exec(sql); f.progress.run([eventPath], () => f.append('{"seq":2}\n'));
    assert.throws(() => f.progress.checkpoint(), /projection integrity/);
  });
});

test('database or canonical file changes after certification invalidate it on reopen', async t => {
  for (const kind of ['database', 'source']) await t.test(kind, sub => {
    const f = fixture(sub); f.progress.checkpoint();
    if (kind === 'database') f.db.prepare(`INSERT INTO scheduler_agent_fences VALUES('after-proof',3)`).run();
    else f.append('{"seq":2}\n');
    assert.equal(f.reopen(), false);
  });
});

test('independent SQLite writer and asynchronous owner both force conservative recovery', async t => {
  await t.test('second connection', sub => {
    const f = fixture(sub), external = new Database(path.join(f.root, 'ponderosa.db'));
    external.prepare(`INSERT INTO scheduler_agent_fences VALUES('external',3)`).run(); external.close();
    assert.throws(() => f.progress.checkpoint(), /unaccounted SQLite write/);
  });
  await t.test('async callback', sub => {
    const f = fixture(sub);
    assert.throws(() => f.progress.run([], () => Promise.resolve()), /synchronous/);
    assert.throws(() => f.progress.checkpoint(), /uncertain/);
  });
});

test('unfinished creation and unowned staging directories block certification', async t => {
  await t.test('pending creation', sub => {
    const f = fixture(sub);
    f.db.prepare(`INSERT INTO agent_creation_operations(id,project_id,actor_scope,kind,idempotency_key,payload_hash,status,created_at,updated_at) VALUES('pending','p','human','human','k','h','preparing','now','now')`).run();
    assert.throws(() => f.progress.checkpoint(), /uncertain/);
  });
  await t.test('staging directory', sub => {
    const f = fixture(sub); mkdirSync(path.join(f.root, 'projects', '.unowned.creating'));
    assert.throws(() => f.progress.checkpoint(), /uncertain/);
  });
});

test('certification cannot escape an uncommitted surrounding transaction', t => {
  const f = fixture(t);
  f.db.transaction(() => {
    f.progress.run([eventPath], () => f.append('{"seq":2}\n'));
    assert.throws(() => f.progress.checkpoint(), /outer transaction committed/);
  })();
  f.progress.checkpoint(); assert.deepEqual(f.reopen(), { tails: [] });
});

test('outer rollback and later append cannot jump a missing canonical prefix', t => {
  const f = fixture(t);
  assert.throws(() => f.db.transaction(() => {
    f.progress.run([eventPath], () => { f.append('{"seq":2}\n'); insert(f.db); });
    throw new Error('outer rollback');
  })());
  f.progress.run([eventPath], () => f.append('{"seq":3}\n'));
  assert.throws(() => f.progress.checkpoint(), /uncertain/);
});

test('legacy proof and changed prefix after certification are consumed and refused', async t => {
  for (const kind of ['legacy', 'tail-prefix']) await t.test(kind, sub => {
    const f = fixture(sub);
    assert.throws(() => f.progress.run([eventPath], () => { f.append('{"seq":2}\n'); throw new Error('projection failed'); }));
    f.progress.checkpoint();
    const file = path.join(f.root, '.projection-clean-shutdown.json');
    if (kind === 'legacy') writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file)), projectionVersion: 3 }));
    else writeFileSync(f.file, '{"seq":0}\n{"seq":2}\n');
    assert.equal(f.reopen(), false);
    assert.equal(consumeProjectionCheckpoint(f.root, f.db), false);
  });
});


test('event failure diagnostics do not hide a verified authored-log suffix', t => {
  const f = fixture(t);
  assert.throws(() => f.progress.run([eventPath], () => {
    f.append('{"seq":2}\n');
    writeFileSync(path.join(path.dirname(f.file), 'event-persistence-failures.jsonl'), '{"code":"event_projection_failed"}\n');
    throw new Error('projection failed');
  }));
  f.progress.checkpoint(); assert.equal(f.reopen().tails[0].path, eventPath);
});
