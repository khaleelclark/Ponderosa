import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const { sidebarChatItems, changedWorkspaceDirectoryKinds, sortChatFolderMembers } = await import('../../apps/web/src/resourcePreferences.ts');
const { workspaceDirectoryItems } = await import('../../apps/web/src/hooks/useWorkspaceDirectory.ts');
const { ChatFolders } = await import('../../apps/web/src/components/ChatFolders.tsx');
const rows = Array.from({ length: 60 }, (_, i) => ({ kind: 'conversation',
  project: { id: 'project', label: 'Project', hostPath: '/unused' },
  conversation: { id: 'chat-' + i, projectId: 'project', title: 'Chat ' + String(i).padStart(2, '0'), updatedAt: new Date(Date.UTC(2026, 9, 19, 0, i)).toISOString() } }));
const folder = { id: 'folder', name: 'Complete', expanded: true, starred: true, conversationIds: rows.slice(30).map(item => item.conversation.id) };
const preferences = { projectSort: 'last_used', projectOrder: [], starredProjectIds: [], chatSort: 'alphabetical', chatOrder: [], chatFolders: [folder] };
const ids = items => items.map(item => item.conversation.id);
const render = items => renderToStaticMarkup(React.createElement(ChatFolders, {
  items, folders: [folder], sort: 'alphabetical', starredIds: new Set(), filtering: false,
  renderRow: item => React.createElement('a', { href: '/projects/' + item.project.id + '/chats/' + item.conversation.id }, item.conversation.title),
  onChange() {}, onRename() {}, onDelete() {}, onReorder() {},
}, ({ starredRows, allRows }) => React.createElement('div', null, starredRows, allRows)));

test('initial25+supplement renders all30 folder members in both folder sections without general pagination', () => {
  const page = { kind: 'conversation', starredItems: [], items: rows.slice(0, 25), folderItems: rows.slice(30), total: 60, history: { limit: 25, hasMore: true, cursor: 'next' } };
  const general = workspaceDirectoryItems([page], preferences);
  assert.equal(general.items.length, 25, 'Manage Chats must keep its bounded page');
  const complete = sidebarChatItems(general.items, page.folderItems, [folder]);
  assert.equal(complete.length, 55);
  const html = render(complete);
  assert.equal([...html.matchAll(/data-chat-folder="folder"/g)].length, 2);
  assert.equal([...html.matchAll(/data-chat-folder-row="chat-59"/g)].length, 2, 'Offpage member appears in both All and Starred folders');
  assert.ok(!html.includes('More chats in this folder'));
});

test('page rows retain freshness and sorted star order when supplement overlaps', () => {
  const fresh = { ...rows[31], conversation: { ...rows[31].conversation, title: 'Fresh name' } };
  const complete = sidebarChatItems([fresh, rows[30], ...rows.slice(0, 25)], rows.slice(30), [folder]);
  assert.deepEqual(ids(complete).slice(0, 2), ['chat-31', 'chat-30']);
  assert.equal(complete.find(item => item.conversation.id === fresh.conversation.id), fresh);
  const next = sidebarChatItems([...rows.slice(0, 25), ...rows.slice(25)], rows.slice(30), [folder]);
  assert.equal(new Set(ids(next)).size, 60);
  assert.equal(next.length, 60);
});

test('complete folder candidates honor custom, alphabetical and recent order', () => {
  const complete = sidebarChatItems(rows.slice(0, 25), rows.slice(30), [folder]);
  assert.deepEqual(ids(sortChatFolderMembers({ ...folder, conversationIds: [...folder.conversationIds].reverse() }, complete, 'custom')), [...folder.conversationIds].reverse());
  assert.deepEqual(ids(sortChatFolderMembers(folder, complete, 'alphabetical')), folder.conversationIds);
  assert.deepEqual(ids(sortChatFolderMembers(folder, complete, 'last_used')), [...folder.conversationIds].reverse());
});

test('membership changes invalidate locally and via SSE; presentation-only changes do not', () => {
  const changed = folders => changedWorkspaceDirectoryKinds(preferences, { ...preferences, chatFolders: folders });
  assert.deepEqual(changed([{ ...folder, name: 'Rename', expanded: false, starred: false, conversationIds: [...folder.conversationIds].reverse() }]), []);
  const moved = [{ ...folder, conversationIds: folder.conversationIds.slice(1) }, { ...folder, id: 'other', conversationIds: [folder.conversationIds[0]] }];
  assert.deepEqual(changed(moved), []);
  assert.deepEqual(changed([{ ...folder, conversationIds: folder.conversationIds.slice(1) }]), ['conversation']);
  assert.deepEqual(changed([{ ...folder, conversationIds: [...folder.conversationIds, rows[29].conversation.id] }]), ['conversation']);
});

test('ungrouped supplemental-only rows return to general pagination immediately', () => {
  const changed = [{ ...folder, conversationIds: folder.conversationIds.slice(1) }];
  const complete = sidebarChatItems(rows.slice(0, 25), rows.slice(30), changed);
  assert.ok(!ids(complete).includes('chat-30'));
  assert.ok(ids(sidebarChatItems([rows[30]], rows.slice(30), changed)).includes('chat-30'), 'A loaded general row remains visible');
});

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useWorkspaceActivity } = await import('../../apps/web/src/hooks/useWorkspaceActivity.ts');
const { useNotificationProjection } = await import('../../apps/web/src/hooks/queries.ts');
const { useWorkspaceDirectory } = await import('../../apps/web/src/hooks/useWorkspaceDirectory.ts');
const { sameWorkspaceDirectoryScope } = await import('../../apps/web/src/workspaceDirectoryScope.ts');
const { api } = await import('../../apps/web/src/api/index.ts');

test('10000 folder members use one activity and one unread request, retaining offpage row badges', async t => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const previousFetch = globalThis.fetch, previousProjection = api.getNotificationProjection;
  t.after(() => { client.clear(); globalThis.fetch = previousFetch; api.getNotificationProjection = previousProjection; });
  const members = Array.from({ length: 10000 }, (_, i) => 'member-' + i);
  const folders = [{ ...folder, expanded: false, conversationIds: members }], calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ kind: 'activity', body });
    return new Response(JSON.stringify({ conversations: { 'member-9999': { status: 'working' } }, chatFolders: {} }));
  };
  api.getNotificationProjection = async body => { calls.push({ kind: 'unread', body }); return { workspace: {}, allMessages: {}, projects: {}, conversations: { 'member-9999': { totalCount: 3 } }, chatFolders: {} }; };
  let activity, unread;
  function Probe() { activity = useWorkspaceActivity([...members, 'ungrouped'], folders, true); unread = useNotificationProjection([], [...members, 'ungrouped'], folders); return null; }
  renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  const [a, n] = await Promise.all([activity.refetch(), unread.refetch()]);
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.deepEqual(call.body.conversationIds, ['ungrouped']); assert.equal(call.body.chatFolders[0].conversationIds.length, 10000); }
  assert.equal(a.data.conversations['member-9999'].status, 'working');
  assert.equal(n.data.conversations['member-9999'].totalCount, 3);
});

test('folder-mode directory cache is isolated while preserving bounded picker/project key positions', () => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  function Probe() { useWorkspaceDirectory('conversation', { enabled: false }); useWorkspaceDirectory('conversation', { enabled: false, folders: true }); useWorkspaceDirectory('conversation', { enabled: false, maxPages: 1 }); return null; }
  renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  const keys = client.getQueryCache().getAll().map(query => query.queryKey);
  assert.equal(keys.length, 3);
  const normal = keys.find(key => key.length === 10), folderKey = keys.find(key => key[11] === 'folders'), picker = keys.find(key => key[10] === 1);
  assert.ok(normal && folderKey && picker);
  assert.equal(folderKey[10], undefined);
  assert.equal(sameWorkspaceDirectoryScope(normal, folderKey), false);
  assert.equal(sameWorkspaceDirectoryScope(picker, folderKey), false);
  assert.equal(sameWorkspaceDirectoryScope(folderKey, [...folderKey]), true);
  client.clear();
});

test('actual directory client retains folder mode on transparent stale-cursor restart', async t => {
  const previous = globalThis.fetch, calls = [];
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async url => {
    calls.push(new URL(url, 'http://fixture'));
    return calls.length === 1 ? new Response(JSON.stringify({ code: 'stale_collection_cursor' }), { status: 409 })
      : new Response(JSON.stringify({ kind: 'conversation', folderItems: [rows[37]], items: [], starredItems: [], history: {} }));
  };
  const page = await api.getWorkspaceDirectory('conversation', { folders: true, cursor: 'old-membership' });
  assert.equal(page.reset, true);
  assert.equal(page.folderItems[0].conversation.id, 'chat-37');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.searchParams.get('folders') === 'true'));
  assert.equal(calls[1].searchParams.has('cursor'), false);
});
