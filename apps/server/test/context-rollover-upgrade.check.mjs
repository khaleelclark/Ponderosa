// Opt-in cross-build qualification. Use a freshly built, read-only base checkout.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
assert.equal(process.env.PONDEROSA_UPGRADE_CHECK, '1', 'explicit opt-in required');
assert.ok(process.env.PONDEROSA_UPGRADE_BASE, 'freshly built base checkout required');
const base = resolve(process.env.PONDEROSA_UPGRADE_BASE);
const candidate = process.env.PONDEROSA_UPGRADE_CONTROL === '1' ? base : fileURLToPath(new URL('../../..', import.meta.url));
const binary = fileURLToPath(new URL('../../../packages/engines/test/fixtures/claude-context-stream.mjs', import.meta.url));
async function run(input) {
  const env = { ...process.env, PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS: '1', PONDEROSA_UPGRADE_FIXTURE: JSON.stringify({ ...input, binary }) };
  for (const key of ['PONDEROSA_BROWSER_SERVICE_SOCKET', 'PONDEROSA_DATA_DIR', 'PONDEROSA_LAUNCHER_DATA_DIR', 'PONDEROSA_PROXY_SOCKET_PATH', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete env[key];
  const child = fork(fileURLToPath(new URL('./fixtures/context-rollover-upgrade-process.mjs', import.meta.url)), [], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let result;
  child.on('message', value => { result = value; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0); assert.ok(result); return result;
}
for (const scenario of process.env.PONDEROSA_UPGRADE_CONTROL === '1' ? ['missing', 'valid', 'pending-valid', 'unknown', 'changed-policy'] : ['missing', 'high', 'cancelled', 'teardown', 'valid', 'unknown', 'changed-policy', 'direct-valid', 'pending-valid', 'authorized-root-valid']) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ponderosa-upgrade-')));
  try {
    const seed = await run({ root: base, directory, phase: 'seed', scenario, ...(scenario === 'direct-valid' ? { seedKind: 'direct' } : {}) });
    const refreshed = await run({ root: candidate, directory, phase: 'refresh', scenario });
    if (scenario === 'unknown' || scenario === 'changed-policy') {
      assert.equal(refreshed.observations.length, 0, 'unknown contract fails before opening a process');
      assert.deepEqual(refreshed.accepted, refreshed.original);
    } else {
      assert.ok(refreshed.observations.length, JSON.stringify({ scenario, errors: refreshed.errors, rollover: refreshed.rollover }));
      assert.equal(refreshed.observations[0].resumeSessionId, seed.snapshot.sessionId, 'handoff resumes genuine base-version session');
      assert.deepEqual(refreshed.observations[0].acceptedSnapshot, seed.snapshot, 'original accepted context is not cleared');
      assert.equal(refreshed.observations[0].systemPrompt, seed.providerInput.exactSystemPrompt, 'handoff uses exact frozen old policy');
      assert.deepEqual(refreshed.observations[0].dynamicTools, seed.dynamicTools, 'handoff supplies exact frozen tool definitions');
      if (['valid', 'direct-valid', 'pending-valid', 'authorized-root-valid'].includes(scenario)) {
        assert.equal(refreshed.rollover.completionReason, 'replacement_verified');
        assert.equal(refreshed.accepted.sessionId, refreshed.rollover.replacementSessionId);
        if (process.env.PONDEROSA_UPGRADE_CONTROL !== '1') assert.notEqual(refreshed.accepted.toolContractHash, seed.snapshot.toolContractHash);
        assert.match(refreshed.observations[1].systemPrompt, /Use only the current Run's host-provided reply route/);
        const { PONDEROSA_RUNTIME_TOOLS } = await import(pathToFileURL(join(candidate, 'packages/core/dist/index.js')).href);
        assert.deepEqual(refreshed.observations[1].dynamicTools.filter(tool => tool.name !== 'ponderosa_history'), PONDEROSA_RUNTIME_TOOLS,
          'only the fresh verified replacement adopts current tool definitions');
        const { environmentFactsPrompt } = await import(pathToFileURL(join(candidate, 'apps/server/dist/runtime-environment-facts.js')).href);
        assert.ok(refreshed.observations[1].systemPrompt.includes(environmentFactsPrompt(seed.providerInput.sourceManifest.environmentFacts).join('\n')),
          'fresh replacement adopts current environment guidance');
        if (scenario === 'pending-valid') assert.equal(refreshed.rollover.id, seed.pendingRolloverId, 'continue the exact pending handoff');
      } else assert.deepEqual(refreshed.accepted, seed.snapshot, 'failed/cancelled refresh preserves full original snapshot');
      if (scenario === 'teardown') assert.equal(refreshed.observations.length, 1, 'failed teardown prevents replacement');
      else if (process.env.PONDEROSA_UPGRADE_CONTROL !== '1') assert.equal(refreshed.observations[1].resumeSessionId, null);
    }
    assert.equal(refreshed.resetCount, 0, 'rollover never invalidates original context');
    assert.deepEqual(refreshed.originalInput, seed.providerInput, 'original exact provider packet and hashes are immutable');
    console.log(JSON.stringify({ scenario, result: 'passed', original: seed.snapshot.sessionId, state: refreshed.rollover.state }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
