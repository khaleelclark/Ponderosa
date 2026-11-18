import assert from 'node:assert/strict';
import test from 'node:test';
import '../shared/web-typescript-loader.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider, QueryObserver, InfiniteQueryObserver } from '@tanstack/react-query';

const { HomeView } = await import('../../apps/web/src/components/HomeView.tsx');
const { queryKeys } = await import('../../apps/web/src/queryKeys.ts');
const { useWorkspaceDirectory } = await import('../../apps/web/src/hooks/useWorkspaceDirectory.ts');
const { api } = await import('../../apps/web/src/api/index.ts');
const key = outcomes => queryKeys.workspaceDirectory.list('agent', '', undefined, undefined, undefined, undefined, !outcomes, outcomes || undefined, undefined);
const outcome = title => ({ kind: 'agent', agent: { id: 'reader', title }, project: { id: 'chat-owner' }, ownerConversation: { title: 'Unchanged Chat' }, health: { assignedWorkOutcome: { status: 'completed' } } });
const props = { projects: [], projectsLoaded: true, engines: [], enginesLoaded: true, notifications: [], notificationCounts: { openActionCount: 0 }, onNavigate() {}, onCreateProject() {}, onOpenInbox() {} };

test('Home retains cached cards, discloses affected refresh failures, and clears feedback after recovery', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, refetchOnMount: false, gcTime: Infinity } } });
  const set = (outcomes, items) => client.setQueryData(key(outcomes), { pages: [{ items, history: {}, activeCount: 0 }], pageParams: [undefined] });
  const render = () => renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(HomeView, props)));
  const fail = (outcomes, extra = {}) => client.getQueryCache().find({ queryKey: key(outcomes) }).setState({ status: 'error', error: new Error('HTTP 503'), fetchStatus: 'idle', ...extra });
  set(false, []); set(true, [outcome('Cached outcome')]);
  assert.match(render(), /Home summary loaded/);
  fail(true);
  const failed = render();
  assert.match(failed, /Cached outcome/);
  assert.match(failed, /Recent Outcomes Unavailable/); assert.match(failed, /HTTP 503/);
  assert.match(failed, /aria-label="Retry Recent Outcomes"/);
  assert.match(failed, /Home refresh failed/);
  assert.doesNotMatch(failed, /Home summary loaded|Active Agents Unavailable/);
  assert.match(failed, /Nothing currently needs your attention/);
  fail(true, { fetchStatus: 'fetching' });
  const busyButton = render().match(/<button[^>]*aria-label="Retry Recent Outcomes"[^>]*>/)?.[0];
  assert.ok(busyButton); assert.match(busyButton, /aria-busy="true"/);
  assert.doesNotMatch(busyButton, /disabled=/, 'Retry must remain usable during automatic refresh retries');
  set(true, [outcome('Recovered outcome')]);
  client.getQueryCache().find({ queryKey: key(true) }).setState({ fetchStatus: 'idle' });
  const recovered = render();
  assert.match(recovered, /Recovered outcome/); assert.match(recovered, /Home summary loaded/);
  assert.doesNotMatch(recovered, /Cached outcome|Recent Outcomes: HTTP 503|Retry Recent Outcomes/);
  fail(false);
  const activeFailed = render();
  assert.match(activeFailed, /Active Agents Unavailable/); assert.match(activeFailed, /Retry Active Agents/);
  assert.match(activeFailed, /Recovered outcome/);
  assert.doesNotMatch(activeFailed, /No Agents are active right now/);
  client.clear();
});

test('Home distinguishes initial failure and valid empty results from cached refresh failure', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, refetchOnMount: false, gcTime: Infinity } } });
  const render = () => renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(HomeView, props)));
  for (const outcomes of [false, true]) client.getQueryCache().build(client, { queryKey: key(outcomes) }).setState({ status: 'error', error: new Error('HTTP 503') });
  const failed = render();
  assert.match(failed, /Active Agents Could Not Be Loaded/); assert.equal((failed.match(/Could Not Be Loaded/g)??[]).length,1,'One contained unavailable state');
  assert.doesNotMatch(failed, /Home summary loaded|Could not refresh|No Agents are active right now/);
  for (const outcomes of [false, true]) client.setQueryData(key(outcomes), { pages: [{ items: [], history: {}, activeCount: 0 }], pageParams: [undefined] });
  const empty = render();
  assert.match(empty, /No Agents are active right now/); assert.match(empty, /Completed Agent work will appear here/);
  assert.doesNotMatch(empty, /Could not load|Could not refresh|Retry refresh/);
  client.clear();
});

test('directory Retry joins in-flight refresh work and keeps pagination failures separate', async t => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false, gcTime: Infinity } } });
  const original = api.getWorkspaceDirectory;
  t.after(() => { api.getWorkspaceDirectory = original; client.clear(); });
  const page = { items: [], history: {}, activeCount: 0 };
  client.setQueryData(key(true), { pages: [page], pageParams: [undefined] });
  let calls = 0, release, request;
  const pending = new Promise(resolve => { release = resolve; });
  api.getWorkspaceDirectory = async () => { calls++; await pending; return page; };
  function Probe() { request = useWorkspaceDirectory('agent', { recentOutcomes: true }).requestState; return null; }
  const render = () => renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  render();
  const first = request.retry(), second = request.retry();
  assert.equal(calls, 1, 'Repeated Retry must join the same in-flight request');
  release(); await Promise.all([first, second]);
  client.getQueryCache().find({ queryKey: key(true) }).setState({ status: 'error', error: new Error('Next page failed'), fetchMeta: { fetchMore: { direction: 'forward' } } });
  render();
  assert.equal(request.isPaginationError, true); assert.equal(request.isRefreshError, false);
});


test('physical phase reads abort on query cancellation and recovery starts distinct canonical HTTP', async t => {
  const { useAgentHealth } = await import('../../apps/web/src/hooks/queries.ts');
  const { capturePhaseQueryBoundaries, reconcilePhaseQueriesAfterBoundary } = await import('../../apps/web/src/phaseEvidenceReconciliation.ts');
  for (const kind of ['health', 'directory']) await t.test(kind, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    const originalFetch = globalThis.fetch, requests = [];
    globalThis.fetch = (_url, init) => new Promise((resolve, reject) => {
      const request = { signal: init?.signal, resolve: value => resolve(new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })) };
      requests.push(request);
      request.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    const queryKey = kind === 'health' ? queryKeys.agents.health('physical-synthetic') : queryKeys.workspaceDirectory.list('agent', '', 'physical-synthetic');
    function Probe() { if (kind === 'health') useAgentHealth('physical-synthetic'); else useWorkspaceDirectory('agent', { projectId: 'physical-synthetic' }); return null; }
    renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    const canonical = client.getQueryCache().find({ queryKey, exact: true }); assert.ok(canonical, 'real query hook owns the tested scope');
    const marker = () => kind === 'health' ? canonical.state.data.marker : canonical.state.data.pages[0].marker;
    const retained = { marker: 'retained', agents: [], items: [], starredItems: [], history: {} };
    client.setQueryData(queryKey, kind === 'health' ? retained : { pages: [retained], pageParams: [undefined] });
    const Observer = kind === 'health' ? QueryObserver : InfiniteQueryObserver;
    const observer = new Observer(client, { ...canonical.options, staleTime: Infinity, refetchOnMount: false });
    const unsubscribe = observer.subscribe(() => {});
    const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    try {
      const old = client.refetchQueries({ queryKey, exact: true }); await settle();
      assert.equal(requests.length, 1);
      const query = client.getQueryCache().find({ queryKey, exact: true }), boundary = capturePhaseQueryBoundaries([query]);
      await client.cancelQueries({ queryKey, exact: true }); await old;
      assert.equal(requests[0].signal?.aborted, true, 'TanStack cancellation must reach the physical fetch, including the background-read cache boundary');
      const verified = reconcilePhaseQueriesAfterBoundary(client, [query], boundary, () => true); await settle();
      assert.equal(requests.length, 2, 'post-boundary recovery must issue distinct physical HTTP rather than wrap a coalesced old read');
      requests[0].resolve({ marker: 'old' }); await settle();
      assert.equal(marker(), 'retained', 'a late old HTTP completion cannot update canonical query data');
      requests[1].resolve({ marker: 'new', agents: [], items: [], starredItems: [], history: {} });
      assert.equal(await verified, true); assert.equal(marker(), 'new');
    } finally {
      unsubscribe(); client.clear(); requests.forEach(request => request.resolve({ marker: 'cleanup', agents: [], items: [], history: {} })); globalThis.fetch = originalFetch;
    }
  });
});
