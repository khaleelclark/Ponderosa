import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const Database=createRequire(new URL('../../apps/server/package.json',import.meta.url))('better-sqlite3');
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginSourceCapture, assertSourceCapture, releaseSourceCapture,
  beginSourceMutation, withSourceMutation, touchSourceMutation, commitSourceCapture,
  SourceCaptureChangedError } from '../../packages/agents/dist/source-capture-boundary.js';

import {readRepairableJsonl} from '../../packages/agents/dist/append-jsonl.js';
test('source cut refuses any SQL/file overlap and validates only retained stable reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-cut-'));
  const db = new Database(join(dir, 'source.sqlite'));
  const other = new Database(join(dir, 'source.sqlite'));
  try {
    db.exec('CREATE TABLE history(id INTEGER PRIMARY KEY, text TEXT)');
    let cut = beginSourceCapture(db);
    assertSourceCapture(cut);
    releaseSourceCapture(cut);
    assert.throws(() => assertSourceCapture(cut), SourceCaptureChangedError);
    for (const mutate of [
      () => db.exec("INSERT INTO history VALUES(1,'new')"),
      () => { try { db.transaction(() => { db.exec("UPDATE history SET text='rolled back'"); throw Error('rollback'); })(); } catch {} },
      () => other.exec("UPDATE history SET text='other connection'"),
      () => db.exec('CREATE TABLE extra(id INTEGER)'),
      () => touchSourceMutation(),
    ]) {
      cut = beginSourceCapture(db);
      mutate();
      assert.throws(() => assertSourceCapture(cut), SourceCaptureChangedError);
      releaseSourceCapture(cut);
    }
    cut = beginSourceCapture(db);
    const finish = beginSourceMutation();
    assert.throws(() => beginSourceCapture(db), SourceCaptureChangedError);
    assert.throws(() => assertSourceCapture(cut), SourceCaptureChangedError);
    finish(); finish();
    assert.throws(() => assertSourceCapture(cut), SourceCaptureChangedError);
    cut = beginSourceCapture(db);
    await assert.rejects(withSourceMutation(async () => { throw Error('settled rejection'); }), /settled rejection/);
    assert.throws(() => assertSourceCapture(cut), SourceCaptureChangedError);
    cut = beginSourceCapture(db);
    assertSourceCapture(cut);
    db.transaction(() => assert.throws(() => beginSourceCapture(db), SourceCaptureChangedError))();
    cut = beginSourceCapture(db);
    commitSourceCapture(cut, () => db.exec("INSERT INTO history VALUES(2,'retention receipt')"));
    assert.throws(() => assertSourceCapture(cut), SourceCaptureChangedError);
    cut = beginSourceCapture(db);
    assert.throws(() => commitSourceCapture(cut, () => { db.exec("INSERT INTO history VALUES(3,'rollback receipt')"); throw Error('receipt failed'); }), /receipt failed/);
    assert.equal(db.prepare('SELECT count(*) n FROM history WHERE id=3').get().n, 0);
    const log=join(dir,'repairable.jsonl');
    for(const bytes of [undefined,'','{"valid":true}\n']){
      if(bytes!==undefined)writeFileSync(log,bytes);
      cut=beginSourceCapture(db);
      assert.deepEqual(readRepairableJsonl(log,'capture read',true),bytes?.trim()?[{valid:true}]:[]);
      assertSourceCapture(cut);releaseSourceCapture(cut);
    }
    for(const bytes of ['{"valid":true}','{"valid":true}\n{"torn":']){
      writeFileSync(log,bytes);cut=beginSourceCapture(db);
      assert.deepEqual(readRepairableJsonl(log,'repair',true),[{valid:true}]);
      assert.throws(()=>assertSourceCapture(cut),SourceCaptureChangedError);releaseSourceCapture(cut);
      assert.equal(readFileSync(log,'utf8'),'{"valid":true}\n');
    }
    const unknown = beginSourceMutation();
    unknown('remote memory write outcome unknown');
    assert.throws(() => beginSourceCapture(db), SourceCaptureChangedError);
  } finally { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// All journal callers share this reader; exercise repairs without replacing history.
import hostFs from '../../packages/native-host/dist/fs.js';
import { openSync, closeSync, writeSync, statSync } from 'node:fs';
function journalFixture(t, bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'journal-reader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, bytes);
  return file;
}

test('journal reader preserves split UTF-8, large records, CRLF, blanks and order', t => {
  const first = { text: 'x'.repeat(1024 * 1024 - 11) + '🌲', id: 1 };
  const second = { text: 'y'.repeat(2 * 1024 * 1024), id: 2 };
  const bytes = JSON.stringify(first) + '\r\n \t\n' + JSON.stringify(second) + '\nnull\n';
  const file = journalFixture(t, bytes);
  assert.deepEqual(readRepairableJsonl(file, 'journal', true), [first, second, null]);
  assert.equal(readFileSync(file, 'utf8'), bytes);
});

test('journal repair uses raw byte boundaries and only repairs unterminated tails', t => {
  const prefix = JSON.stringify({ text: '🌲é' }) + '\r\n\n  \n';
  for (const repair of [false, true]) {
    for (const tail of ['{"torn":', '{"ok":true}', ' \t']) {
      const file = journalFixture(t, prefix + tail);
      const valid = tail === '{"ok":true}';
      assert.deepEqual(readRepairableJsonl(file, 'journal', repair), [{ text: '🌲é' }, ...(valid ? [{ ok: true }] : [])]);
      const expected = !repair || tail === ' \t' ? prefix + tail : valid ? prefix + tail + '\n' : prefix;
      assert.equal(readFileSync(file, 'utf8'), expected);
    }
    for (const suffix of ['{broken}\n', '{broken}\n{"ok":true}']) {
      const file = journalFixture(t, prefix + suffix);
      assert.throws(() => readRepairableJsonl(file, 'journal', repair), /non-tail corruption/);
      assert.equal(readFileSync(file, 'utf8'), prefix + suffix);
    }
  }
});

test('read, decode and parse resource failures never truncate or append history', t => {
  const bytes = JSON.stringify({ text: 'x'.repeat(1024 * 1024 + 100) });
  const file = journalFixture(t, bytes);
  const originalRead = hostFs.readSync;
  let reads = 0;
  hostFs.readSync = (...args) => { if (++reads === 2) throw new Error('injected read failure'); return originalRead(...args); };
  try { assert.throws(() => readRepairableJsonl(file, 'journal', true), /injected read failure/); }
  finally { hostFs.readSync = originalRead; }
  assert.equal(readFileSync(file, 'utf8'), bytes);
  const originalDecode = Buffer.prototype.toString;
  Buffer.prototype.toString = function (...args) { if (this.length === Buffer.byteLength(bytes)) throw new RangeError('injected decode failure'); return originalDecode.apply(this, args); };
  try { assert.throws(() => readRepairableJsonl(file, 'journal', true), /injected decode failure/); }
  finally { Buffer.prototype.toString = originalDecode; }
  assert.equal(readFileSync(file, 'utf8'), bytes);
  const originalParse = JSON.parse;
  JSON.parse = (...args) => { if (args[0] === bytes) throw new RangeError('injected parse resource failure'); return originalParse(...args); };
  try { assert.throws(() => readRepairableJsonl(file, 'journal', true), /injected parse resource failure/); }
  finally { JSON.parse = originalParse; }
  assert.equal(readFileSync(file, 'utf8'), bytes);
});

test('journal exceeding Node whole-string limit reads in bounded chunks without changing bytes', t => {
  const file = journalFixture(t, '{"first":true}\n');
  const fd = openSync(file, 'a');
  const blank = Buffer.alloc(1024 * 1024, 32);
  blank[blank.length - 1] = 10;
  try {
    for (let i = 0; i < 520; i++) assert.equal(writeSync(fd, blank), blank.length);
    writeSync(fd, '{"last":true}\n');
  } finally { closeSync(fd); }
  const before = statSync(file);
  assert.ok(before.size > 0x1fffffe8);
  const originalRead = hostFs.readSync;
  let reads = 0;
  hostFs.readSync = (fd, buffer, offset, length, position) => {
    assert.ok(length <= 1024 * 1024, 'bounded physical read');
    reads++;
    return originalRead(fd, buffer, offset, length, position);
  };
  try { assert.deepEqual(readRepairableJsonl(file, 'large journal', true), [{ first: true }, { last: true }]); }
  finally { hostFs.readSync = originalRead; }
  assert.ok(reads > 520);
  const after = statSync(file);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});
