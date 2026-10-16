import assert from 'node:assert/strict';
import test from 'node:test';
import '../shared/web-typescript-loader.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
  assert.match(failed, /Could not refresh recent outcomes/);
  assert.match(failed, /aria-label="Retry refresh of recent outcomes"/);
  assert.match(failed, /Home refresh failed/);
  assert.doesNotMatch(failed, /Home summary loaded|Could not refresh active Agents/);
  assert.match(failed, /Nothing currently needs your attention/);
  fail(true, { fetchStatus: 'fetching' });
  const busyButton = render().match(/<button[^>]*aria-label="Retry refresh of recent outcomes"[^>]*>/)?.[0];
  assert.ok(busyButton); assert.match(busyButton, /aria-busy="true"/);
  assert.doesNotMatch(busyButton, /disabled=/, 'Retry must remain usable during automatic refresh retries');
  set(true, [outcome('Recovered outcome')]);
  client.getQueryCache().find({ queryKey: key(true) }).setState({ fetchStatus: 'idle' });
  const recovered = render();
  assert.match(recovered, /Recovered outcome/); assert.match(recovered, /Home summary loaded/);
  assert.doesNotMatch(recovered, /Cached outcome|Could not refresh recent outcomes|Retry refresh of recent outcomes/);
  fail(false);
  const activeFailed = render();
  assert.match(activeFailed, /Could not refresh active Agents/); assert.match(activeFailed, /Retry refresh of active Agents/);
  assert.match(activeFailed, /Recovered outcome/);
  assert.doesNotMatch(activeFailed, /No Agents are active right now/);
  client.clear();
});

test('Home distinguishes initial failure and valid empty results from cached refresh failure', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, refetchOnMount: false, gcTime: Infinity } } });
  const render = () => renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(HomeView, props)));
  for (const outcomes of [false, true]) client.getQueryCache().build(client, { queryKey: key(outcomes) }).setState({ status: 'error', error: new Error('HTTP 503') });
  const failed = render();
  assert.match(failed, /Could not load active Agents/); assert.match(failed, /Could not load recent outcomes/);
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
