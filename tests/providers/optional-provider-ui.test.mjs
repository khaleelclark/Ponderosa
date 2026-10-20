import test from 'node:test';
import assert from 'node:assert/strict';
import { engineCanDiscover, engineIsAvailable, engineCanTestAccess, engineStatusPresentation, engineAvailabilityPresentation, soleAvailableEngineId } from '../../apps/web/src/conversationEngine.ts';
import { shouldRetryQuery } from '../../apps/web/src/api/queryRetry.ts';
import { ApiRequestError } from '../../apps/web/src/api/types.ts';

const provider = id => ({ id, displayName: id, installed: true, enabled: true, authentication: 'authenticated', intakeReady: true, reachability: 'reachable' });
for (const ids of [[], ['codex'], ['claude'], ['codex', 'claude']]) test('optional-provider UI: ' + (ids.join('+') || 'neither'), () => {
  const engines = ['codex', 'claude'].map(id => ({ ...provider(id), installed: ids.includes(id) }));
  assert.equal(soleAvailableEngineId(engines), ids.length === 1 ? ids[0] : undefined);
  const summary = engineAvailabilityPresentation(engines);
  assert.equal(summary.label, ids.length ? 'Engine ready' : 'Inactive');
  for (const engine of engines) {
    assert.equal(engineCanDiscover(engine), engine.installed);
    assert.equal(engineIsAvailable(engine), engine.installed);
    if (!engine.installed) {
      assert.equal(engineCanTestAccess(engine), false);
      assert.equal(engineStatusPresentation(engine).label, 'Inactive', 'Stale authentication/reachability must not override missing CLI');
    }
  }
});
test('disabled/unauthenticated provider has no automatic catalog request; inactive response is not retried, transient 503 still is', () => {
  assert.equal(engineCanDiscover({ ...provider('claude'), enabled: false }), false);
  assert.equal(engineCanDiscover({ ...provider('claude'), authentication: 'unauthenticated' }), false);
  assert.equal(engineCanDiscover(undefined), false);
  assert.equal(shouldRetryQuery(0, new ApiRequestError(409, 'Inactive', { code: 'PROVIDER_INACTIVE' })), false);
  assert.equal(shouldRetryQuery(0, new ApiRequestError(503, 'Transient provider failure')), true);
  assert.match(engineAvailabilityPresentation([{ ...provider('codex'), enabled: false }]).detail, /Enable a provider/);
});
