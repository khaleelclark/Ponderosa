import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const server = process.env.PONDEROSA_TEST_INSTALL_ROOT
  ? path.join(process.env.PONDEROSA_TEST_INSTALL_ROOT, 'app/server') : path.join(repository, 'apps/server');
const require = createRequire(path.join(server, 'package.json'));
const Database = require('better-sqlite3');
const agents = path.dirname(require.resolve('@ponderosa/agents'));
const { stateSchemaSignature } = await import(pathToFileURL(path.join(agents, 'state-schema-signature.js')));
const { initializeCurrentDatabase } = await import(pathToFileURL(path.join(agents, 'db.js')));
const { admitDataDirectory } = await import(pathToFileURL(path.join(agents, 'state-admission.js')));

function signature(sql) {
  const db = new Database(':memory:');
  try { db.exec(sql); return stateSchemaSignature(db); } finally { db.close(); }
}

test('schema inspection still refuses oversized declarations and excess objects before unbounded materialization',()=>{
  assert.throws(()=>signature(`CREATE TABLE oversized (value TEXT DEFAULT '${'a'.repeat(1_100_000)}')`),
    /bounded state read refused|unsupported bounded state schema metadata/);
  assert.throws(()=>signature(Array.from({length:513},(_,i)=>`CREATE TABLE t${i} (value TEXT);`).join('\n')),
    /unsupported bounded state schema metadata/);
});

const declarations = [
  'CREATE TABLE items (',
  ' /* Comment with unmatched \' " ` [ and --',
  '    still a comment */',
  ' id INTEGER PRIMARY KEY,',
  ' value TEXT DEFAULT \'can\'\'t -- /* quoted */\',',
  ' [bracket\'"--/*] TEXT,',
  ' `back``tick` TEXT,',
  ' "double""quote" TEXT',
  ');',
  'CREATE TABLE audit (message TEXT);',
  'CREATE INDEX value_index ON items (',
  ' value COLLATE NOCASE -- unmatched \' " ` [ /*',
  ');',
  'CREATE TRIGGER item_audit AFTER INSERT ON items BEGIN',
  ' INSERT INTO audit VALUES (NEW.value || \'雪 \'\' -- /* literal\');',
  'END;',
].join('\n');

test('real SQLite schema signatures equate only LF/CRLF outside literals, including comment and quote boundaries', () => {
  const lf = signature(declarations);
  assert.ok(JSON.parse(lf).objects.find(row => row.name === 'items').sql.includes('/* Comment with unmatched'),
    'the quote-bearing block comment is retained in a real declaration');
  assert.equal(lf, signature(declarations.replaceAll('\n', '\r\n')));
  assert.notEqual(signature('CREATE TABLE t (x TEXT);'), signature('CREATE TABLE t ( x TEXT);'),
    'other SQL whitespace remains exact');
  assert.notEqual(signature('CREATE TABLE t (\rx TEXT);'),
    signature('CREATE TABLE t (\nx TEXT);'), 'bare CR remains exact');
});

test('schema comparison preserves literal line breaks in defaults, index expressions, triggers and quoted identifiers', () => {
  for (const [label, ddl] of [
    ['default', "CREATE TABLE t (x TEXT DEFAULT 'first\nsecond');"],
    ['escaped quote', "CREATE TABLE t (x TEXT DEFAULT 'first''\n-- /* second');"],
    ['index expression', "CREATE TABLE t (x TEXT); CREATE INDEX i ON t(x || 'first\nsecond');"],
    ['trigger', "CREATE TABLE t (x TEXT); CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET x='first\nsecond'; END;"],
    ['double identifier', 'CREATE TABLE "first\nsecond" (x TEXT);'],
    ['backtick identifier', 'CREATE TABLE `first\nsecond` (x TEXT);'],
    ['bracket identifier', 'CREATE TABLE [first\nsecond] (x TEXT);'],
  ]) assert.notEqual(signature(ddl), signature(ddl.replaceAll('\n', '\r\n')), label);
  assert.notEqual(signature('CREATE TABLE t (x TEXT); CREATE INDEX i ON t(x) WHERE x > 0;'),
    signature('CREATE TABLE t (x TEXT); CREATE INDEX i ON t(x) WHERE x > 1;'));
});

function currentFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ponderosa-schema-eol-'));
  const data = path.join(root, 'data'); mkdirSync(data);
  const generationId = randomUUID();
  const db = new Database(path.join(data, 'ponderosa.db'));
  const exec = db.exec.bind(db);
  db.exec = sql => exec(sql.replace(/\r?\n/g, '\r\n'));
  try {
    initializeCurrentDatabase(db);
    db.exec(`CREATE TABLE _state_generation (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  state_epoch INTEGER NOT NULL CHECK(state_epoch=2),
  generation_id TEXT NOT NULL,
  schema_contract TEXT NOT NULL
)`);
    db.prepare('INSERT INTO _state_generation VALUES (1,2,?,?)').run(generationId, 'ponderosa.state.current-single-db');
  } finally { db.close(); }
  writeFileSync(path.join(data, '.ponderosa-layout-version'), JSON.stringify({ layoutVersion: 2, stateEpoch: 2, generationId }) + '\n');
  return { root, data, generationId };
}

test('current-state admission accepts a CRLF-created real database without rewriting its declarations or generation', () => {
  const fixture = currentFixture(); let admission, passed = false;
  const read = () => {
    const db = new Database(path.join(fixture.data, 'ponderosa.db'), { readonly: true });
    try { return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(); }
    finally { db.close(); }
  };
  try {
    const before = read();
    assert.ok(before.some(row => row.sql?.includes('\r\n')), 'fixture stores real CRLF declarations');
    assert.ok(before.every(row => !row.sql?.includes('\r\r\n')), 'fixture does not double existing CRLF');
    admission = admitDataDirectory(fixture.data);
    assert.equal(admission.generationId, fixture.generationId);
    assert.equal(admission.client.pragma('integrity_check', { simple: true }), 'ok');
    admission.close(); admission = undefined;
    assert.deepEqual(read(), before, 'admission must not rewrite stored SQL');
    passed = true;
  } finally { admission?.close(); if (passed) rmSync(fixture.root, { recursive: true, force: true }); }
});

test('CRLF current-state admission still refuses a changed real index contract', () => {
  const fixture = currentFixture(); let passed = false;
  try {
    const db = new Database(path.join(fixture.data, 'ponderosa.db'));
    try {
      const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_projects_directory'").get();
      db.exec('DROP INDEX idx_projects_directory');
      db.exec(sql.replace('CREATE INDEX', 'CREATE UNIQUE INDEX'));
    } finally { db.close(); }
    assert.throws(() => admitDataDirectory(fixture.data), /unsupported or incomplete current state/);
    passed = true;
  } finally { if (passed) rmSync(fixture.root, { recursive: true, force: true }); }
});
