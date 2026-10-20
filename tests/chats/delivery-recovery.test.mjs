import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import '../shared/web-typescript-loader.mjs';
import { runQueuedMessageCommand } from '../../apps/web/src/components/queuedMessageCommandAttempts.ts';
import * as chatState from '../../apps/web/src/chatState.ts';
import { messageDeliveryPhase } from '../../apps/web/src/components/messageDeliveryPhase.ts';
import { projectMessageDeliveryReceipts } from '../../apps/web/src/components/messageDeliveryReceipts.ts';
import * as tracker from '../../apps/web/src/components/activeOperationTracker.ts';
import { ApiRequestError } from '../../apps/web/src/api/types.ts';
import { queryKeys } from '../../apps/web/src/queryKeys.ts';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const ts = require('typescript'), React = require('react');
const widget = name => Object.assign(() => null, { displayName: name });
const mui = new Proxy({}, { get: (target, name) => target[name] ??= widget(name) });
function load(relative, imports = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/' + relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, Error, Event, ...globals, require: name => {
    if (name in imports) return imports[name];
    if (name === './messageDeliveryPhase') return { messageDeliveryPhase };
    if (name === '@mui/material') return mui;
    if (name === '@mui/material/styles') return { alpha: value => value };
    if (name.startsWith('@mui/icons-material/')) return { __esModule: true, default: widget('Icon') };
    return require(name);
  } });
  return exports;
}
function hooks() {
  const state = []; let index = 0;
  const useState = initial => { const i = index++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; };
  return { react: { ...React, useState, useRef: value => useState(() => ({ current: value }))[0], useEffect() {}, useMemo: fn => fn() }, render(fn) { index = 0; return fn(); } };
}
function* walk(node) {
  if (!React.isValidElement(node)) return;
  yield node; for (const child of React.Children.toArray(node.props.children)) yield* walk(child);
}
const text = node => React.isValidElement(node) ? React.Children.toArray(node.props.children).map(text).join('') : String(node ?? '');
const client = { invalidateQueries: async () => {} };
const receipt = extra => ({ activationId: 'delivery-a', targetAgentId: 'agent-a', attemptCount: 6, ...extra });
function status(extra, api = {}) {
  const h = hooks(), module = load('components/MessageDeliveryStatus.tsx', {
    react: h.react, '@tanstack/react-query': { useQueryClient: () => client }, '../api': { api }, '../queryKeys': { queryKeys }, '../clientId': { createClientId: () => 'fixture-id' },
  });
  return () => [...walk(h.render(() => module.MessageDeliveryStatus({ projectId: 'project', receipts: [receipt(extra)], recipientName: () => 'Reader' })))];
}
for (const [extra, expected, compact] of [
  [{ state: 'run_unconfirmed', providerAcknowledged: true }, /lost contact before confirming whether the work finished/u, 'Work unconfirmed'],
  [{ state: 'retry_exhausted', providerAcknowledged: true }, /after 6 attempts; automatic recovery stopped/u, 'Reply exhausted'],
  [{ state: 'cancelled', providerAcknowledged: false }, /cancelled/u, 'Cancelled'],
  [{ state: 'cancelled', providerAcknowledged: true, runStopState: 'stopping' }, /termination has not been confirmed/u, 'Delivered · Stopping'],
  [{ state: 'cancelled', providerAcknowledged: true, runStopState: 'unconfirmed' }, /whether its work stopped is unconfirmed/u, 'Delivered · Stop unconfirmed'],
]) test(`Q01 actual delivery view distinguishes ${compact}`, () => {
  const nodes = status(extra)(), announcement = nodes.find(node => node.props.role === 'status');
  assert.equal(announcement.props['aria-live'], 'polite'); assert.match(text(announcement), expected);
  assert.ok(nodes.some(node => node.type === mui.Typography && text(node) === compact));
});
test('Q01 uncertain-work retry requires explicit confirmation and retains its identity after a lost response', async () => {
  const calls = []; let fail = true;
  const render = status({ state: 'retry_exhausted', providerAcknowledged: true, canRetry: true, retryMayDuplicate: true }, { retryMessageDelivery: async (project, activation, body) => { calls.push({ project, activation, ...body }); if (fail) throw Error('Accepted retry response lost'); } });
  const button = label => render().find(node => node.type === mui.Button && text(node) === label);
  button('Try Work Again').props.onClick(); assert.equal(calls.length, 0);
  assert.equal(render().find(node => node.type === mui.Dialog).props.open, true);
  button('Cancel').props.onClick(); assert.equal(calls.length, 0);
  button('Try Work Again').props.onClick(); button('Try Again Anyway').props.onClick(); await new Promise(setImmediate);
  assert.ok(render().some(node => node.type === mui.Alert && text(node).includes('response lost')));
  fail = false; button('Try Again Anyway').props.onClick(); await new Promise(setImmediate);
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[0].idempotencyKey, 'operator-delivery-retry:delivery-a');
  assert.equal(render().find(node => node.type === mui.Dialog).props.open, false);
});
test('Q01 partial Stop retries only the unresolved observed Run with its original key, including after replacement', async () => {
  const h = hooks(), calls = []; let retry = false, id = 0;
  const health = new Map(['a','b'].map(agentId => [agentId, { runtimeActivity: { executionId: 'old-' + agentId } }]));
  const module = load('components/useActiveOperationController.ts', {
    react: h.react, '@tanstack/react-query': { useQueryClient: () => client, useQuery: () => ({}) }, '../api': { api: { cancelRun: async (agentId, body) => {
      calls.push({ agentId, ...body }); if (agentId === 'b') { if (!retry) throw Error('Cancel acknowledgement lost'); throw new ApiRequestError(409, 'Observed Run is no longer active'); }
    } } }, '../api/types': { ApiRequestError }, '../api/backgroundCooldown': { backgroundCooldownRemaining: () => 0 }, '../clientId': { createClientId: () => 'stop-key-' + ++id }, '../queryKeys': { queryKeys }, './activeOperationTracker': tracker,
  });
  const render = () => h.render(() => module.useActiveOperationController({ activeScopeId: 'chat', healthByAgentId: health, receiptSources: [], agentTitle: id => id, invalidate() {} }));
  render().setActiveOperation(tracker.createActiveOperationTracker('delivery', ['a','b'], health, Date.now(), 'chat'));
  await render().stopOperation(); assert.equal(calls.length, 0);
  await render().cancelOperationTargets(render().stopConfirmation.targets);
  assert.deepEqual(Array.from(render().stopConfirmation.targets, target => ({ ...target })), [{ agentId: 'b', runId: 'old-b' }]);
  assert.match(render().cancelOperationError.message, /acknowledgement lost/u);
  retry = true; health.delete('a'); health.set('b', { runtimeActivity: { executionId: 'replacement-b' } });
  await render().cancelOperationTargets(render().stopConfirmation.targets);
  assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey);
  assert.equal(calls.length, 3); assert.equal(calls[2].agentId, 'b'); assert.equal(calls[2].targetRunId, 'old-b'); assert.equal(calls[2].idempotencyKey, calls[1].idempotencyKey);
  assert.equal(render().stopConfirmation, undefined); assert.equal(render().cancelOperationError, undefined);
  await render().stopOperation(); assert.equal(calls.length, 3, 'Replacement work must not become a cancellation target');
});
class Storage {
  values = new Map(); get length() { return this.values.size; } key(i) { return [...this.values.keys()][i] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; } setItem(key, value) { this.values.set(key, String(value)); } removeItem(key) { this.values.delete(key); }
}
test('Q01 captured unknown submissions survive module reload with exact scope/order and fail closed on storage refusal', async t => {
  const previous = globalThis.window, window = Object.assign(new EventTarget(), { localStorage: new Storage() }); globalThis.window = window;
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const open = () => load('components/chat/submissionOutbox.ts', { '../../chatState.js': chatState }, { window });
  const first = { version: 1, scope: 'chat-a', storageKey: 'draft-a', ownerId: 'owner', clientId: 'tab', createdAt: 1, action: 'send', text: 'Exact first text', editorText: 'Exact first text', attachmentNames: [], mentionedAgents: [], newAgentRequested: false, pending: { fingerprint: 'a'.repeat(64), idempotencyKey: 'first-key' }, status: 'unknown', dispatchStarted: true };
  const second = { ...first, createdAt: 2, pending: { ...first.pending, idempotencyKey: 'second-key' } };
  const elsewhere = { ...first, scope: 'chat-b', pending: { ...first.pending, idempotencyKey: 'elsewhere-key' } };
  const initial = open(); for (const item of [first, second, elsewhere]) initial.saveCapturedSubmission(item);
  const reloaded = open(); let calls = 0;
  assert.equal(reloaded.readCapturedSubmissions('chat-a', 'owner').length, 2); assert.equal(reloaded.readCapturedSubmissions('chat-a', 'other-owner').length, 0);
  await assert.rejects(reloaded.runCapturedSubmission(second, async () => calls++), /earlier captured message/u); assert.equal(calls, 0);
  await assert.rejects(reloaded.runCapturedSubmission(first, async () => { calls++; throw Error('Accepted response lost'); }), /response lost/u);
  assert.equal(open().readCapturedSubmissions('chat-a', 'owner')[0].pending.idempotencyKey, 'first-key');
  assert.equal(open().readCapturedSubmissions('chat-a', 'owner')[0].text, first.text);
  const final = open(); await final.runCapturedSubmission(first, async () => { final.removeCapturedSubmission(first.pending.idempotencyKey); });
  await final.runCapturedSubmission(second, async () => { calls++; final.removeCapturedSubmission(second.pending.idempotencyKey); });
  assert.equal(final.readCapturedSubmissions('chat-a', 'owner').length, 0); assert.equal(final.readCapturedSubmissions('chat-b', 'owner').length, 1);
  window.localStorage.setItem = () => { throw Error('Quota refused'); };
  assert.throws(() => final.saveCapturedSubmission(first), /could not be saved for recovery/u);
});
test('Q01 mounted queue-edit retries retain their exact key and a stale completion cannot retire a newer intent', async () => {
  const registry = new Map(), requests = []; let id = 0;
  const edit = text => ({ command: 'edit', deliveryId: 'delivery', text });
  await assert.rejects(runQueuedMessageCommand(registry, edit('Exact text'), () => 'edit-' + ++id, async body => { requests.push(body); throw Error('Response lost'); }), /Response lost/u);
  await runQueuedMessageCommand(registry, edit('Exact text'), () => 'edit-' + ++id, async body => requests.push(body));
  assert.equal(requests[0].idempotencyKey, requests[1].idempotencyKey); assert.equal(registry.size, 0);
  let release; const gate = new Promise(resolve => release = resolve);
  const old = runQueuedMessageCommand(registry, edit('Older edit'), () => 'edit-' + ++id, async () => gate);
  await assert.rejects(runQueuedMessageCommand(registry, edit('Newer edit'), () => 'edit-' + ++id, async body => { requests.push(body); throw Error('Response lost'); }));
  const newer = requests.at(-1).idempotencyKey; release(); await old;
  await runQueuedMessageCommand(registry, edit('Newer edit'), () => 'edit-' + ++id, async body => requests.push(body));
  assert.equal(requests.at(-1).idempotencyKey, newer); assert.equal(registry.size, 0);
});

test('UI004 exact receipts replace retry lineages, clear authorized empties and preserve unchanged rows', () => {
  const old = { activationId: 'old', targetAgentId: 'a', state: 'failed' };
  const fresh = { ...old, activationId: 'retry', state: 'queued' };
  const sources = [
    { communicationEventId: 'retained', text: 'unchanged authored text', deliveryReceipts: [old] },
    { communicationEventId: 'empty', deliveryReceipts: [old] },
    { communicationEventId: 'not-returned', deliveryReceipts: [old] },
    { communicationEventId: 'same', deliveryReceipts: [fresh] },
  ];
  const result = projectMessageDeliveryReceipts(sources, [
    { communicationEventId: 'retained', deliveryReceipts: [fresh] },
    { communicationEventId: 'empty', deliveryReceipts: [] },
    { communicationEventId: 'same', deliveryReceipts: [{ ...fresh }] },
  ]);
  assert.deepEqual(result[0].deliveryReceipts, [fresh]);
  assert.equal(result[0].text, sources[0].text);
  assert.deepEqual(result[1].deliveryReceipts, []);
  assert.equal(result[2], sources[2]); assert.equal(result[3], sources[3]);
  assert.deepEqual(sources[0].deliveryReceipts, [old], 'Canonical paginated data is not mutated');
});
test('UI004 routine phases require this exact acknowledged turn, preserving terminal uncertainty', () => {
  for (const state of ['queued', 'retrying', 'steering']) assert.equal(messageDeliveryPhase({ state }), 'Waiting');
  for (const state of ['preparing', 'started']) assert.equal(messageDeliveryPhase({ state }), 'Starting');
  const acknowledged = { state: 'delivered', injectionKind: 'turn', providerAcknowledged: true, injectionId: 'i', executionId: 'e' };
  assert.equal(messageDeliveryPhase(acknowledged), 'Working');
  for (const field of ['providerAcknowledged', 'injectionId', 'executionId']) assert.equal(messageDeliveryPhase({ ...acknowledged, [field]: undefined }), undefined);
  assert.equal(messageDeliveryPhase({ ...acknowledged, injectionKind: 'steer' }), undefined);
  for (const state of ['processed', 'cancelled', 'run_unconfirmed', 'recovered', 'failed', 'unconfirmed']) assert.equal(messageDeliveryPhase({ ...acknowledged, state }), undefined);
});
test('UI004 footer never borrows an earlier busy Run for a later queued message', () => {
  const h = hooks(), module = load('components/ConversationComposerStatus.tsx', {
    react: h.react, '../time': { formatExecutionElapsed: () => '0:01' },
    './chat/ChatLiveBanner': { ChatLiveBanner: mui.Box },
  });
  const props = { agents: [{ id: 'a', title: 'Reader' }], healthByAgentId: new Map([['a', { runtimeActivity: { executionId: 'earlier', startedAt: '2026-10-19T00:00:00Z' } }]]) };
  const message = deliveryReceipts => ({ role: 'user', deliveryReceipts });
  const active = { activationId: 'old', targetAgentId: 'a', state: 'delivered', injectionKind: 'turn', providerAcknowledged: true, injectionId: 'i', executionId: 'earlier' };
  const render = messages => h.render(() => module.MasterRespondingIndicator({ ...props, messages }));
  assert.match(text(render([message([active])])), /Reader is working/u);
  for (const messages of [[message([active]), message([{ ...active, activationId: 'later', state: 'queued', executionId: undefined }])],
    [message([{ ...active, executionId: 'different' }])], [message([{ ...active, state: 'processed' }])]]) {
    const nodes = [...walk(render(messages))];
    assert.ok(!nodes.some(node => node.type === mui.Tooltip), 'Only current acknowledged Working agents have a footer banner; Waiting remains on message delivery');
    assert.equal(text(nodes.find(node => node.props.role === 'status')), 'No agents are working');
  }
});

test('working summary deduplicates stable IDs and shares exact rows, phases and timer-free announcements', () => {
  const h = hooks(), module = load('components/ConversationComposerStatus.tsx', {
    react: h.react, '../time': { formatExecutionElapsed: () => '0:01' }, './chat/ChatLiveBanner': { ChatLiveBanner: mui.Box },
  });
  const agents = ['a', 'b', 'c', 'd'].map(id => ({ id, title: id === 'a' ? 'Boston' : 'Same long name '.repeat(30) }));
  const active = agents.map(agent => ({ activationId: 'turn-' + agent.id, targetAgentId: agent.id, state: 'delivered', injectionKind: 'turn', providerAcknowledged: true, injectionId: 'i-' + agent.id, executionId: 'run-' + agent.id }));
  const healthByAgentId = new Map(agents.map(agent => [agent.id, { runtimeActivity: { executionId: 'run-' + agent.id, startedAt: '2026-10-19T00:00:00Z' } }]));
  const render = (receipts, role = 'user') => [...walk(h.render(() => module.MasterRespondingIndicator({ agents, healthByAgentId, messages: [{ role, deliveryReceipts: receipts }] })))];
  for (const count of [1, 2, 4]) {
    const nodes = render([...active.slice(0, count), ...active.slice(0, count)]);
    const trigger = nodes.find(node => node.type === mui.ButtonBase), tooltip = nodes.find(node => node.type === mui.Tooltip);
    assert.equal(trigger.props['aria-label'], count === 1 ? 'Boston is working' : `${count} agents are working`);
    assert.equal(tooltip.props.describeChild, true);
    const rows = React.Children.toArray(tooltip.props.title.props.children);
    assert.deepEqual(rows.map(row => row.key.replace(/^\.\$/, '')), agents.slice(0, count).map(agent => agent.id));
    for (let i = 0; i < count; i++) assert.match(text(rows[i]), new RegExp(agents[i].title.trim() + ' — Working'));
    const live = nodes.find(node => node.props['aria-live'] === 'polite');
    assert.ok(!text(live).includes('0:01'), 'Elapsed ticks cannot mutate the live announcement');
  }
  for (const receipts of [[{ ...active[0], providerAcknowledged: false }], [{ ...active[0], injectionKind: 'steer' }],
    [{ ...active[0], state: 'preparing' }], [{ ...active[0], state: 'queued' }], []]) {
    assert.ok(!render(receipts).some(node => node.type === mui.Tooltip));
  }
  assert.ok(!render(active, 'assistant').some(node => node.type === mui.Tooltip));
  assert.equal(render([active[0], { ...active[0], state: 'processed' }, active[1]]).find(node => node.type === mui.ButtonBase).props['aria-label'], `${agents[1].title.trim()} is working`);
  render(active).find(node => node.type === mui.Tooltip).props.onOpen();
  render(active).find(node => node.type === mui.ButtonBase).props.onClick();
  assert.equal(render(active).find(node => node.type === mui.Tooltip).props.open, true, 'Clicking after hover or keyboard focus must not close the details');
  for (const name of ['Arroyo', '  South Arroyo  ', 'South  Arroyo']) {
    agents[0].title = name;
    const trigger = render([active[0]]).find(node => node.type === mui.ButtonBase);
    assert.equal(trigger.props['aria-label'], `${name.trim()} is working`);
    assert.ok(text(trigger).startsWith(`${name.trim()} is working`));
    assert.equal(agents[0].title, name, 'Presentation must not change the stored name');
  }
});

test('UI004 another receipt changing cannot rerender an unchanged retained row or roll back newer history', () => {
  const receipt = (activationId, state, updatedAt) => ({ activationId, targetAgentId: 'a', state, updatedAt });
  const sources = ['a', 'b'].map(id => ({ communicationEventId: id, text: id, deliveryReceipts: [receipt(id, 'queued', '2026-10-19T00:00:00Z')] }));
  const item = (id, state, at) => ({ communicationEventId: id, deliveryReceipts: [receipt(id, state, at)] });
  const first = projectMessageDeliveryReceipts(sources, [item('a', 'delivered', '2026-10-19T00:00:01Z'), item('b', 'queued', '2026-10-19T00:00:00Z')]);
  const next = projectMessageDeliveryReceipts(sources, [item('a', 'delivered', '2026-10-19T00:00:01Z'), item('b', 'delivered', '2026-10-19T00:00:02Z')], first);
  assert.equal(next[0], first[0]); assert.notEqual(next[1], first[1]);
  const newer = { ...sources[0], deliveryReceipts: [receipt('a', 'processed', '2026-10-19T00:00:03Z')] };
  assert.equal(projectMessageDeliveryReceipts([newer], [item('a', 'delivered', '2026-10-19T00:00:01Z')])[0], newer);
});

test('UI004 exact freshness is per recipient, not the latest timestamp across the message', () => {
  const receipt = (targetAgentId, state, second) => ({ activationId: targetAgentId, targetAgentId, state, updatedAt: `2026-10-19T00:00:${second}Z` });
  const source = { communicationEventId: 'mixed', deliveryReceipts: [receipt('a', 'processed', '30'), receipt('b', 'delivered', '40')] };
  const result = projectMessageDeliveryReceipts([source], [{ communicationEventId: 'mixed', deliveryReceipts: [receipt('a', 'queued', '10'), receipt('b', 'delivered', '40')] }]);
  assert.equal(result[0], source);
});

test('UI004 exact reads keep historical scopes, bound batches, poll stopping, and release aborted reads', async () => {
  const h = hooks(); let queries = [], calls = 0;
  const module = load('components/useMessageDeliveryReceipts.ts', {
    react: h.react, '@tanstack/react-query': { useQueries: options => { queries = options.queries; return []; } },
    './messageDeliveryReceipts': { projectMessageDeliveryReceipts }, '../queryKeys': { queryKeys },
    '../api': { api: { activeMessageDeliveryReceipts: (_id, _body, signal) => {
      if (++calls > 1) return Promise.resolve({ items: [] });
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } } },
  }, { AbortSignal });
  const sources = Array.from({ length: 1001 }, (_, i) => ({ conversationId: 'historical', communicationEventId: String(i) }));
  sources.push({ source: { conversationId: 'global-source' }, communicationEventId: 'global' });
  h.render(() => module.useMessageDeliveryReceipts(sources, 'current-owner', false));
  assert.equal(queries.length, 3); assert.ok(queries.every(query => query.enabled === false));
  assert.deepEqual(Array.from(queries, query => query.queryKey[1]), ['historical', 'historical', 'global-source']);
  assert.ok(queries.every(query => query.queryKey[2].split('\0').length <= 1000));
  const interval = receipts => queries[0].refetchInterval({ state: { data: { items: [{ deliveryReceipts: receipts }] } } });
  assert.equal(interval([{ state: 'processed' }]), false);
  assert.equal(interval([{ state: 'cancelled', runStopState: 'stopping' }]), 5000);
  assert.equal(interval([{ state: 'queued' }]), 5000);
  const controller = new AbortController(), next = new AbortController();
  const first = queries[0].queryFn({ signal: controller.signal });
  await new Promise(setImmediate);
  const second = queries[1].queryFn({ signal: next.signal });
  assert.equal(calls, 1);
  const rejected = assert.rejects(first, { name: 'AbortError' }); controller.abort(); await rejected;
  await second; assert.equal(calls, 2);
});
