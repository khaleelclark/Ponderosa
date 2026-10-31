import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import '../shared/web-typescript-loader.mjs';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const ts = require('typescript');
const { QueryClient, MutationObserver } = require('@tanstack/react-query');
const { realApi: api } = await import('../../apps/web/src/api/real.ts');
const { ApiRequestError } = await import('../../apps/web/src/api/types.ts');
const { queryKeys } = await import('../../apps/web/src/queryKeys.ts');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const pending = { id: 'decision-one', projectId: 'project-one', agentId: 'agent-one', conversationId: 'chat-one', mode: 'text', status: 'pending', question: 'Choose a route', options: [], allowOther: true };
const answered = { ...pending, status: 'resolved', updatedAt: '2026-10-23T16:00:00Z', response: { text: 'canonical answer', respondedAt: '2026-10-23T16:00:00Z' } };
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(t, fetch) {
  t.mock.method(globalThis, 'fetch', fetch);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: Infinity }, queries: { retry: false, gcTime: Infinity } } });
  let observer, completed = 0;
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/hooks/useDecisionResponse.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Error, AbortSignal, console, performance, require: name => {
    if (name === '@tanstack/react-query') return { useQueryClient: () => client, useMutation(options) { observer = new MutationObserver(client, options); return observer; } };
    if (name === '../api') return { api };
    if (name === '../api/types') return { ApiRequestError };
    if (name === '../queryKeys') return { queryKeys };
    throw Error('Unexpected hook dependency: '+name);
  } });
  exports.useDecisionResponse(() => completed++);
  const unsubscribe = observer.subscribe(() => {});
  t.after(() => { unsubscribe(); client.clear(); });
  return { client, observer, completed: () => completed, respond: (decision = pending, response = { text: 'typed answer' }) => observer.mutate({ decisionId: decision.id, decision, response }) };
}

test('confirmed save finishes before held refreshes, updating only the exact cached decision', async t => {
  const f = setup(t, async () => Response.json(answered));
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.mock.method(f.client, 'invalidateQueries', () => held);
  f.client.setQueryData(queryKeys.decisions.project(pending.projectId), [pending, { ...pending, id: 'unrelated' }]);
  const result = f.respond();
  try {
    await tick(); await tick();
    assert.equal(f.observer.getCurrentResult().isSuccess, true, 'background refresh must not hold Sending');
    assert.equal(f.completed(), 1);
    assert.equal(f.client.getQueryData(queryKeys.decisions.project(pending.projectId))[0].status, 'resolved');
    assert.equal(f.client.getQueryData(queryKeys.decisions.project(pending.projectId))[1].status, 'pending');
  } finally { release(); await result; }
});

test('failed background refresh cannot reverse a confirmed response', async t => {
  const f = setup(t, async () => Response.json(answered));
  t.mock.method(f.client, 'invalidateQueries', async () => { throw Error('refresh unavailable'); });
  assert.equal((await f.respond()).status, 'resolved'); await tick();
  assert.equal(f.completed(), 1); assert.equal(f.observer.getCurrentResult().isSuccess, true);
});

test('lost POST response reads the exact scoped canonical decision including resolved outcomes', async t => {
  const calls = [];
  const f = setup(t, async (path, init) => {
    calls.push({ path, init });
    if (init?.method === 'POST') throw TypeError('Load failed');
    return Response.json([{ ...answered, id: 'unrelated' }, answered]);
  });
  assert.equal((await f.respond()).response.text, 'canonical answer');
  assert.equal(f.completed(), 1); assert.equal(calls.length, 2);
  const url = new URL(calls[1].path, 'http://fixture');
  assert.equal(url.searchParams.get('projectId'), pending.projectId);
  assert.equal(url.searchParams.get('agentId'), pending.agentId);
  assert.equal(url.searchParams.has('status'), false);
  assert.equal(calls[1].init.cache, 'no-store'); assert.ok(calls[1].init.signal);
});

for (const kind of ['empty', 'no-content', 'wrong-decision']) test(`an invalid ${kind} POST success must reconcile before confirming`, async t => {
  let reads = 0;
  const f = setup(t, async (path, init) => {
    if (init?.method === 'POST') return kind === 'empty' ? new Response('') : kind === 'no-content' ? new Response(null, { status: 204 }) : Response.json({ ...answered, id: 'unrelated' });
    reads++; return Response.json([answered]);
  });
  assert.equal((await f.respond()).id, pending.id);
  assert.equal(reads, 1); assert.equal(f.completed(), 1);
});

test('failure before save remains retryable; repeated exact submission returns one canonical result', async t => {
  let posts = 0;
  const f = setup(t, async (path, init) => {
    if (init?.method === 'POST') {
      if (++posts === 1) throw TypeError('Load failed');
      return Response.json(answered);
    }
    return Response.json([pending]);
  });
  await assert.rejects(f.respond(), /still pending.*try again/i);
  assert.equal(f.completed(), 0);
  assert.equal(f.observer.getCurrentResult().variables.response.text, 'typed answer');
  assert.equal((await f.respond()).status, 'resolved'); assert.equal(f.completed(), 1);
});

test('failed reconciliation gives uncertainty rather than a raw transport error or false success', async t => {
  const f = setup(t, async () => { throw TypeError('Load failed'); });
  await assert.rejects(f.respond(), /connection.*lost.*saving.*could not be confirmed/i);
  assert.equal(f.completed(), 0); assert.equal(f.observer.getCurrentResult().variables.response.text, 'typed answer');
});

test('answered elsewhere reconciles the canonical response instead of overwriting it', async t => {
  const f = setup(t, async (path, init) => init?.method === 'POST'
    ? Response.json({ error: 'This question has already been answered' }, { status: 409 })
    : Response.json([answered]));
  assert.equal((await f.respond(pending, { skip: true })).response.text, 'canonical answer');
  assert.equal(f.completed(), 1);
});

for (const extra of [{ mode: 'approval' }, { approvalScope: { kind: 'saved_browser' } }, { runtimeAction: { kind: 'mcp_elicitation', mode: 'form' } }]) {
  test(`a recorded ${Object.keys(extra)[0]} is not proof that its side effect completed`, async t => {
    const f = setup(t, async (path, init) => {
      if (init?.method === 'POST') throw TypeError('Load failed');
      return Response.json([{ ...answered, ...extra }]);
    });
    await assert.rejects(f.respond({ ...pending, ...extra }), /recorded.*completion.*not.*confirmed.*retry/i);
    assert.equal(f.completed(), 0);
    assert.equal(f.observer.getCurrentResult().isError, true);
  });
}

test('explicit approval errors and validation failures keep their existing server explanation', async t => {
  const message = 'The Decision was recorded, but saved-browser access is not ready. Retry this Decision response.';
  const f = setup(t, async (path, init) => init?.method === 'POST'
    ? Response.json({ error: message }, { status: 503 }) : Response.json([{ ...answered, mode: 'approval' }]));
  await assert.rejects(f.respond({ ...pending, mode: 'approval' }), error => error.message === message);
  assert.equal(f.completed(), 0);
});

test('confirmation updates exact timeline/notice records without changing unrelated decisions or counts twice', async t => {
  const f = setup(t, async () => Response.json(answered));
  const other = { ...pending, id: 'other' }, events = [{ id: 'event-one', decision: pending }, { id: 'event-other', decision: other }];
  const agentKey = [...queryKeys.agents.detailAll, pending.agentId], chatKey = [...queryKeys.conversations.detailAll, pending.conversationId], allKey = [...queryKeys.inboxAll, 'page'];
  for (const key of [agentKey, chatKey]) f.client.setQueryData(key, { marker: 'retain', decisionEvents: events });
  f.client.setQueryData(allKey, { decisions: events, items: ['unchanged'] });
  f.client.setQueryData(queryKeys.notifications.all, { items: [{ id: 'notice-one', kind: 'decision', status: 'open', decision: pending }, { id: 'notice-other', kind: 'decision', status: 'open', decision: other }], openActionCount: 2, unacknowledgedActionCount: 2, unreadUpdateCount: 4 });
  const projectionKey = queryKeys.notifications.projection(['project-one'], []);
  f.client.setQueryData(projectionKey, { totalCount: 17 });
  for (let i = 0; i < 2; i++) {
    await f.respond();
    for (const key of [agentKey, chatKey]) {
      const cache = f.client.getQueryData(key);
      assert.equal(cache.marker, 'retain'); assert.equal(cache.decisionEvents[0].decision.status, 'resolved'); assert.equal(cache.decisionEvents[1].decision.status, 'pending');
    }
    assert.equal(f.client.getQueryData(allKey).decisions[0].decision.status, 'resolved');
    const notices = f.client.getQueryData(queryKeys.notifications.all);
    assert.equal(notices.items[0].status, 'resolved'); assert.equal(notices.items[1].status, 'open');
    assert.equal(notices.openActionCount, 1); assert.equal(notices.unacknowledgedActionCount, 1); assert.equal(notices.unreadUpdateCount, 4);
    assert.equal(f.client.getQueryData(projectionKey).totalCount, 17);
  }
});

test('an older in-flight read cannot overwrite the confirmed decision', async t => {
  const f = setup(t, async () => Response.json(answered)), key = queryKeys.decisions.project(pending.projectId);
  f.client.setQueryData(key, [pending]);
  let release;
  const read = f.client.fetchQuery({ queryKey: key, queryFn: () => new Promise(resolve => { release = resolve; }) }).catch(() => {});
  await tick(); await f.respond(); release([pending]); await read; await tick();
  assert.equal(f.client.getQueryData(key)[0].status, 'resolved');
});

test('cancelled and unrelated missing decisions do not fabricate a saved answer', async t => {
  let data = [{ ...pending, status: 'cancelled' }];
  const f = setup(t, async (path, init) => { if (init?.method === 'POST') throw TypeError('Load failed'); return Response.json(data); });
  const outcome = await f.respond(); assert.equal(outcome.status, 'cancelled'); assert.equal(outcome.response, undefined);
  data = [{ ...answered, id: 'unrelated' }];
  await assert.rejects(f.respond(), /could not be confirmed/);
});

test('Decision actions finish from canonical POST data and retain retries for unconfirmed approvals', () => {
  let mutation, tree;
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/decisions/DecisionActions.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Error, require: name => {
    if (['react', 'react/jsx-runtime'].includes(name)) return require(name);
    if (name === '../../hooks/useDecisionResponse') return { useDecisionResponse: () => mutation };
    if (name === '../../decisions') return { decisionAcceptsText: () => true, decisionTextActionLabel: () => 'Answer' };
    if (name === './decisionResponse') return { settleDecisionResponse() {} };
    return new Proxy({}, { get: () => () => null });
  } });
  function Probe({ decision }) { tree = exports.DecisionActions({ decision }); return null; }
  const render = decision => renderToStaticMarkup(React.createElement(Probe, { decision }));
  mutation = { isSuccess: true, data: answered, variables: { decision: pending } }; render(pending); assert.equal(tree, null);
  mutation = { isError: true, error: Error('Completion not confirmed'), variables: { decision: { ...pending, mode: 'approval' } } }; render({ ...answered, mode: 'approval' }); assert.ok(tree);
  mutation = { isError: true, variables: { decision: { ...pending, id: 'other', mode: 'approval' } } }; render({ ...answered, mode: 'approval' }); assert.equal(tree, null);
});

test('UI019 a notification detail collection and ordinary lists update together without failing an accepted save',async t=>{
 const f=setup(t,async()=>Response.json(answered));const detail=[...queryKeys.decisions.all,'detail',pending.id];
 f.client.setQueryData(detail,[pending]);f.client.setQueryData(queryKeys.decisions.project(pending.projectId),[pending,{...pending,id:'other'}]);
 await f.respond();assert.equal(f.completed(),1);assert.equal(f.observer.getCurrentResult().isSuccess,true);assert.equal(f.client.getQueryData(detail)[0].status,'resolved');assert.equal(f.client.getQueryData(queryKeys.decisions.project(pending.projectId))[1].status,'pending');
});
