import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitDataDirectory } from '../../packages/agents/dist/state-admission.js';

// Production (Nov 14) could not restart: its counted work (6.67M) was under the
// 16M cap, but the integrity check charged that work three times and refused.
test('startup admits a healthy database whose counted work exceeds a third of the read budget', { timeout: 300_000 }, t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ponderosa-integrity-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'), rows = 1_000_000; // events: primary key + 4 indexes = 6 units per row
  const first = admitDataDirectory(data);
  try {
    first.client.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
      INSERT INTO events(id, agent_id, seq, type, payload_json, created_at)
      SELECT 'budget-' || i, 'budget-agent', i, 'text', '{}', '2026-11-16T00:00:00.000Z' FROM n`);
    const work = first.client.prepare("SELECT count(*) * ((SELECT count(*) FROM pragma_index_list('events')) + 1) n FROM events").get().n;
    assert.ok(work > 16_000_000 / 3 && work < 16_000_000, `fixture work ${work} must sit between the old and real ceilings`);
  } finally { first.close(); }
  const reopened = admitDataDirectory(data);
  try { assert.equal(reopened.client.prepare('SELECT count(*) n FROM events').get().n, rows); } finally { reopened.close(); }
});

// Growth must not lock a healthy installation out on its next restart: the
// admission budget scales with the copied state instead of a fixed 16M.
test('startup admits a healthy database whose admission charge exceeds the fixed read budget', { timeout: 900_000 }, t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ponderosa-scaled-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'), rows = 2_500_000;
  const first = admitDataDirectory(data);
  try {
    first.client.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
      INSERT INTO events(id, agent_id, seq, type, payload_json, created_at)
      SELECT 'budget-' || i, 'budget-agent', i, 'text', '{}', '2026-11-16T00:00:00.000Z' FROM n`);
    const work = first.client.prepare("SELECT count(*) * ((SELECT count(*) FROM pragma_index_list('events')) + 1) n FROM events").get().n;
    assert.ok(work + rows > 16_000_000, `fixture charge ${work + rows} must exceed the fixed budget`);
  } finally { first.close(); }
  const reopened = admitDataDirectory(data);
  try { assert.equal(reopened.client.prepare('SELECT count(*) n FROM events').get().n, rows); } finally { reopened.close(); }
});
