import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import '../shared/web-typescript-loader.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The browser bundler accepts JSON imports without Node import attributes.
const webSource = new URL('../../apps/web/src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  if (url.startsWith(webSource) && url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')};` };
  return next(url, context);
} });

const { ConversationView } = await import('../../apps/web/src/components/ConversationView.tsx');
const { MutationNotificationProvider } = await import('../../apps/web/src/components/MutationNotifications.tsx');
const { AgentsTab } = await import('../../apps/web/src/components/AgentsTab.tsx');
const { queryKeys } = await import('../../apps/web/src/queryKeys.ts');
const { api } = await import('../../apps/web/src/api/index.ts');
const chat = { id: 'chat', projectId: 'project', title: 'Search fixture', defaultEngine: 'codex' };
const agent = { id: 'reader', projectId: 'project', conversationId: chat.id, title: 'Unfiltered reader', handle: 'reader', activeEngine: 'codex', role: 'worker', createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z' };
const props = { conversationId: chat.id, initialView: 'agents', engines: [], engineCapabilities: [], projectAgents: [agent], statusByAgentId: new Map(), healthByAgentId: new Map(), preferences: {}, onRefreshCapabilities() {}, onOpenProject() {}, onOpenProjectBrowser() {}, onOpenAgent() {}, onAgentsDeleted() {}, onOpenAgentWork() {}, onOpenBrowser() {}, onNewAgent() {}, onPreferences() {}, onDeleted() {} };
const page = items => ({ items, total: items.length, hasMore: false });
const data = items => ({ pages: [page(items)], pageParams: [undefined] });
const findRoster = node => {
  if (!React.isValidElement(node)) return;
  if (node.type === AgentsTab) return node;
  for (const child of React.Children.toArray(node.props.children)) {
    const found = findRoster(child); if (found) return found;
  }
};
function setup(t) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, refetchOnMount: false, gcTime: Infinity } } });
  t.after(() => client.clear());
  client.setQueryData(queryKeys.conversations.detail(chat.id, 100), { conversation: chat, agents: [agent], messages: [], members: { total: 1 } });
  let roster;
  const render = (search = '') => {
    // Execute the real owner and its hooks; render only its roster subtree to
    // keep unrelated Chat panels out of this focused request-state regression.
    function Probe() {
      roster = findRoster(ConversationView(props));
      assert.ok(roster, 'Chat must render its Agents tab');
      if (roster.props.searchValue !== search) roster.props.onSearchValueChange(search);
      return roster;
    }
    const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(MutationNotificationProvider, null, React.createElement(Probe))));
    return { html, roster: roster.props };
  };
  const fail = (search, extra = {}) => client.getQueryCache().build(client, { queryKey: queryKeys.conversations.members(chat.id, search) }).setState({ status: 'error', error: new Error('HTTP 503'), fetchStatus: 'idle', ...extra });
  return { client, render, fail };
}

test('Chat filtered request failure shows Retry, excludes unfiltered fallback, and clears after recovery', async t => {
  const { client, render } = setup(t);
  const search = 'needle';
  await assert.rejects(client.fetchInfiniteQuery({
    queryKey: queryKeys.conversations.members(chat.id, search),
    initialPageParam: undefined,
    queryFn: async () => { throw new Error('HTTP 503'); },
  }), /HTTP 503/);
  const failed = render(search);
  assert.match(failed.html, /Could not load Agents/);
  assert.match(failed.html, />Retry</);
  assert.doesNotMatch(failed.html, /No Agents Yet|No Agents match|Unfiltered reader/);
  assert.equal(failed.roster.collectionRequest.isInitialError, true);
  assert.equal(failed.roster.collection.detail, undefined);
  assert.equal(failed.roster.collection.totalCount, undefined);
  client.setQueryData(queryKeys.conversations.members(chat.id, search), data([{ ...agent, title: 'Recovered needle' }]));
  const recovered = render(search);
  assert.deepEqual(recovered.roster.agents.map(item => item.title), ['Recovered needle']);
  assert.match(recovered.html, /Recovered needle/);
  assert.doesNotMatch(recovered.html, /Could not load Agents|No Agents Yet/);
});

test('Chat distinguishes pending search, successful no match, and unfiltered roster', t => {
  const { client, render } = setup(t);
  const pending = render('needle').html;
  assert.doesNotMatch(pending, /No Agents Yet|No Agents match|Unfiltered reader/);
  client.setQueryData(queryKeys.conversations.members(chat.id, 'needle'), data([]));
  const empty = render('needle').html;
  assert.match(empty, /No Agents match these filters/);
  assert.doesNotMatch(empty, /No Agents Yet|Could not load Agents|Unfiltered reader/);
  client.setQueryData(queryKeys.conversations.members(chat.id, ''), data([agent]));
  const unfiltered = render().html;
  assert.match(unfiltered, /Unfiltered reader/);
  assert.doesNotMatch(unfiltered, /Could not load Agents|No Agents match/);
  client.setQueryData(queryKeys.conversations.detail(chat.id, 100), { conversation: chat, agents: [], messages: [], members: { total: 0 } });
  client.setQueryData(queryKeys.conversations.members(chat.id, ''), data([]));
  assert.match(render().html, /No Agents Yet/);
});

test('Chat discloses refresh and pagination errors while retaining matching cached results', t => {
  const { client, render, fail } = setup(t);
  const search = 'reader';
  client.setQueryData(queryKeys.conversations.members(chat.id, search), data([agent]));
  fail(search);
  const refresh = render(search).html;
  assert.match(refresh, /Unfiltered reader/);
  assert.match(refresh, /Could not refresh Agents/);
  assert.match(refresh, />Retry</);
  client.setQueryData(queryKeys.conversations.members(chat.id, search), data([]));
  fail(search);
  assert.doesNotMatch(render(search).html, /No Agents Yet|No Agents match/);
  client.setQueryData(queryKeys.conversations.members(chat.id, search), data([agent]));
  fail(search, { fetchMeta: { fetchMore: { direction: 'forward' } } });
  const pagination = render(search).html;
  assert.match(pagination, /Could not load more Agents/);
  assert.match(pagination, /Unfiltered reader/);
  assert.doesNotMatch(pagination, /Could not refresh Agents/);
});

// SSR cannot commit the observer's changed-search effects. Exercise the actual
// Retry callback on an initially mounted query, separately from filter rendering.
test('Chat Retry refetches the failed members request and clears its error', async t => {
  const { render, fail } = setup(t);
  fail('');
  const failed = render();
  assert.match(failed.html, /Could not load Agents/);
  const original = api.listConversationMembersPage;
  t.after(() => { api.listConversationMembersPage = original; });
  const calls = [];
  api.listConversationMembersPage = async (id, options) => { calls.push({ id, search: options.search }); return page([agent]); };
  await failed.roster.collectionRequest.retry();
  assert.deepEqual(calls, [{ id: chat.id, search: undefined }]);
  const recovered = render().html;
  assert.match(recovered, /Unfiltered reader/);
  assert.doesNotMatch(recovered, /Could not load Agents/);
});
