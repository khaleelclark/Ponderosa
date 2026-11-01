import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginSourceCapture, assertSourceCapture, releaseSourceCapture,
  beginSourceMutation, withSourceMutation, touchSourceMutation, commitSourceCapture,
  SourceCaptureChangedError } from '../../packages/agents/dist/source-capture-boundary.js';

// Deferred source regression: no execution under the implementation-only direction.
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
    const unknown = beginSourceMutation();
    unknown('remote memory write outcome unknown');
    assert.throws(() => beginSourceCapture(db), SourceCaptureChangedError);
  } finally { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
