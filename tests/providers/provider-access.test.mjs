import test from 'node:test';
import assert from 'node:assert/strict';
import { withFixture } from '../shared/fixture.mjs';

test('check 31: provider status reads do not test access; explicit recheck probes only its selected provider', {
  timeout: 30000
}, t => withFixture(t, async f => {
  for (let i = 0; i < 2; i++) {
    const engines = f.ok(await f.api('GET', '/api/engines'));
    assert.ok(engines.some(x => x.id === 'codex'));
  }
  assert.deepEqual(f.providerProbes, [], 'Merely displaying status made a diagnostic provider request');
  assert.equal((await f.api('POST', '/api/engines/unknown-fixture-provider/recheck')).status, 404);
  assert.deepEqual(f.providerProbes, [], 'An unknown provider triggered another provider\'s probe');
  const checked = f.ok(await f.api('POST', '/api/engines/codex/recheck'));
  assert.equal(checked.id, 'codex');
  assert.deepEqual(f.providerProbes, [{ engineId: 'codex' }]);
  assert.equal(f.turns.length, 0, 'A provider diagnostic created Agent task work');
}));
