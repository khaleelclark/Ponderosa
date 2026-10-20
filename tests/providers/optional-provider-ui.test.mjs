import test from 'node:test';
import assert from 'node:assert/strict';
import { engineCanDiscover, engineIsAvailable, engineCanTestAccess, engineStatusPresentation, engineAvailabilityPresentation, soleAvailableEngineId, enginesWithModelCatalog } from '../../apps/web/src/conversationEngine.ts';
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


test('Project inventory default replaces a host default even when both models remain advertised', () => {
  const models = [{ id: 'project-default', isDefault: true, label: 'Project', defaultEffort: 'high', efforts: [{ id: 'high', label: 'High' }] }, { id: 'host-default', label: 'Host' }];
  const [engine] = enginesWithModelCatalog([{ ...provider('codex'), models: models.toReversed(), efforts: [], defaultModel: 'host-default' }], { engineId: 'codex', models, cliVersion: '0.143.0', fetchedAt: '2026-10-19T00:00:00Z' });
  assert.equal(engine.defaultModel, 'project-default'); assert.equal(engine.defaultEffort, 'high');
});

test('a catalog without an explicit default retains a compatible Claude default', () => {
  const models = ['opus', 'sonnet'].map(id => ({ id, label: id }));
  const [engine] = enginesWithModelCatalog([{ ...provider('claude'), models, efforts: [], defaultModel: 'sonnet' }], { engineId: 'claude', models, cliVersion: 'fixture', fetchedAt: '2026-10-19T00:00:00Z' });
  assert.equal(engine.defaultModel, 'sonnet');
});

test('a previous CLI catalog cannot replace newly observed executing-client inventory', () => {
  const engine = { ...provider('codex'), cliVersion: '0.159.2', models: [{ id: 'new', label: 'New' }], efforts: [] };
  const [current] = enginesWithModelCatalog([engine], { engineId: 'codex', cliVersion: '0.143.0', models: [{ id: 'old', label: 'Old' }] });
  assert.equal(current, engine);
});

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const ts = require('typescript');

test('model hook refreshes late old-client data once, scopes queries, and ignores unrelated status samples after a failed refresh', async () => {
  const invalidations = [], requests = [], cache = new Map();
  const key = (project, engine) => ['engine-models', project, engine];
  const client = { getQueryData: queryKey => cache.get(JSON.stringify(queryKey)), invalidateQueries: input => { invalidations.push(input.queryKey); return Promise.resolve(); } };
  let dependencies, query, priorData, result, effect;
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/hooks/useEngineModelCatalogs.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: name => ({
    react: { useEffect(fn, next) { if (!dependencies || next.some((value, i) => !Object.is(value, dependencies[i]))) { dependencies = next; effect = fn; } } },
    '@tanstack/react-query': { useQueryClient: () => client, useQueries(options) {
      query = options.queries[0]; const data = client.getQueryData(query.queryKey);
      if (!result || data !== priorData) { priorData = data; result = options.combine([{ data, isLoading: false }]); }
      return result;
    } },
    '../api': { api: { getEngineModels: async (...args) => { requests.push(args); return {}; } } },
    '../conversationEngine': { engineCanDiscover }, '../queryKeys': { queryKeys: { engines: { models: key } } },
  })[name] });
  const current = { ...provider('codex'), modelDiscovery: true, cliVersion: 'new', modelCatalogFetchedAt: '2026-10-19T01:00:00Z' };
  const render = (project = 'project', engine = current) => { effect = undefined; exports.useEngineModelCatalogs(project, [engine]); effect?.(); };
  render(); assert.equal(invalidations.length, 0); // Initial inventory is still in flight.
  cache.set(JSON.stringify(key('project', 'codex')), { cliVersion: 'old', fetchedAt: '2026-10-19T00:00:00Z' });
  render(); assert.equal(invalidations.length, 1, 'Late old-client response must trigger a new read');
  await query.queryFn(); assert.deepEqual(requests[0], ['project', 'codex', true]);
  render('project', { ...current, authDetail: 'Unrelated new status sample' });
  assert.equal(invalidations.length, 1, 'Retained data after failure must not cause a force-refresh loop');
  render('other-project'); assert.equal(query.queryKey[1], 'other-project');
  render('project', { ...current, installed: false }); assert.equal(query.enabled, false);
  assert.equal(invalidations.length, 1, 'Absent providers must not be refreshed');
});
