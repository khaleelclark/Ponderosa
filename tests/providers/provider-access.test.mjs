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

import { publicProviderFailure, publicProviderFailureEvent, publicProviderFailureSummary, publicProviderFailureRemediation, outcomeCauseExplanation } from '@ponderosa/core';
import { mapClaudeEvent } from '../../packages/engines/dist/claude-events.js';
import { ClaudeModelCatalogProbe } from '../../packages/engines/dist/claude-models.js';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

for (const input of [
  { detail: 'HTTP 429 Too many requests' },
  { code: 'rate_limit_error', detail: 'temporary throttle' },
  { category: 'rate_limit', detail: 'No allowance information' },
  { code: 'quota_exhausted', detail: 'Quota exhausted' },
  { detail: 'usage limit was reached' },
]) test('Q05 rate/quota evidence stays request-limited without asserting an account reset: ' + JSON.stringify(input), () => {
  const result = publicProviderFailure(input);
  assert.equal(result.category, 'rate_limit');
  assert.equal(result.summary, 'Provider limited the request.');
  assert.equal(result.remediation, 'Wait before retrying; check provider usage information for any reset time.');
  assert.equal(publicProviderFailureSummary(result.summary), result.summary);
  assert.equal(publicProviderFailureRemediation(result.summary), result.remediation);
});
test('Q05 structured capacity wins over incidental 429 text; unknown and secrets remain bounded', () => {
  const capacity = publicProviderFailure({ code: 'capacity', detail: 'HTTP 429 secret-fixture-token' });
  assert.equal(capacity.category, 'capacity'); assert.equal(capacity.summary, 'Provider is temporarily at capacity.');
  for (const detail of ['arbitrary secret-fixture-token', '{"error":"HTTP 429 secret-fixture-token"}', 'x'.repeat(3000), 'HTTP 429 \u200b secret-fixture-token']) {
    const failure = publicProviderFailure({ detail }); assert.equal(failure.category, 'unknown'); assert.doesNotMatch(JSON.stringify(failure), /secret-fixture-token/u);
  }
});
test('Q05 Claude mapped errors and public events retain throttle/capacity/unknown distinctions without leaking provider detail', () => {
  for (const [code, category] of [['rate_limit', 'rate_limit'], ['quota_exhausted', 'rate_limit'], ['overloaded_error', 'capacity'], ['unrecognized_failure', 'unknown']]) {
    const mapped = mapClaudeEvent({ type: 'assistant', error: code, message: { content: [{ type: 'text', text: 'secret-fixture-token' }] } })[0];
    assert.equal(mapped.type, 'error');
    const visible = publicProviderFailureEvent(mapped); assert.equal(visible.category, category); assert.doesNotMatch(JSON.stringify(visible), /secret-fixture-token/u);
    if (category === 'rate_limit') { assert.match(mapped.message, /^Claude limited the request/u); assert.equal(visible.message, 'Provider limited the request.'); }
  }
});
test('Q05 interrupted outcomes do not claim an account quota or completed work and preserve duplicate-work guidance', () => {
  for (const promptSubmissionState of ['not_injected', 'injecting', 'injected']) {
    const explanation = outcomeCauseExplanation({ code: 'provider_outcome_unknown', providerFailureCategory: 'rate_limit', promptSubmissionState });
    assert.match(explanation, /provider limited the request/u); assert.doesNotMatch(explanation, /reached a usage limit|account.*exhaust/u);
    assert.match(explanation, /retry could repeat work/u);
  }
});
test('Q05 real Claude validation boundary uses only a local fake executable and honest limited-request wording', { timeout: 30000, skip: process.platform === 'win32' || /\s/u.test(process.execPath) ? 'Fixture requires a POSIX shebang with a whitespace-free Node executable; normalization checks remain portable' : false }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-q05-validation-')); let passed = false;
  t.after(async () => { if (passed) await rm(root, { recursive: true, force: true }); else t.diagnostic('Retained owned fixture: ' + root); });
  const bin = path.join(root, 'fake-claude');
  await writeFile(bin, '#!' + process.execPath + '\n' + `const model=process.argv.at(-1); const error=model==='capacity'?'overloaded_error':'rate_limit'; console.log(JSON.stringify({type:'assistant',error})); console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:model==='quota'?'quota exhausted':'HTTP 429',errors:[]}));\n`);
  await chmod(bin, 0o700);
  const probe = new ClaudeModelCatalogProbe({ bin, killGraceMs: 100 });
  const handles = []; const context = { signal: new AbortController().signal, onRuntimeSpawned: handle => handles.push(handle) };
  try {
    for (const model of ['throttle', 'quota', 'capacity']) {
      const result = await probe.validate(root, model, context); assert.equal(result.valid, false); assert.equal(handles.at(-1).isAlive(), false, 'Validation returned before owned process exit');
      assert.equal(result.errorCode, model === 'capacity' ? 'capacity' : 'rate_limit');
      if (model === 'capacity') assert.match(result.error, /temporarily at capacity/u);
      else { assert.match(result.error, /limited the request/u); assert.doesNotMatch(result.error, /usage limit was reached|Wait for the limit to reset/u); }
    }
    assert.equal(handles.length, 3);
  } finally { await Promise.all(handles.map(handle => handle.close())); }
  assert.ok(handles.every(handle => !handle.isAlive()), 'Owned validation process remains alive');
  passed = true;
});
