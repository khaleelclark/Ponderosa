import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import '../shared/web-typescript-loader.mjs';
import { runQueuedMessageCommand } from '../../apps/web/src/components/queuedMessageCommandAttempts.ts';
import * as chatState from '../../apps/web/src/chatState.ts';
import { messageDeliveryPhase } from '../../apps/web/src/components/messageDeliveryPhase.ts';
import { applyQueuedMessageCancellation, messageHiddenByQueue, projectMessageDeliveryReceipts } from '../../apps/web/src/components/messageDeliveryReceipts.ts';
import { reconcileQueuedMessages, reconcileQueuedProjectMessages } from '../../apps/web/src/components/ConversationView.helpers.ts';
import * as tracker from '../../apps/web/src/components/activeOperationTracker.ts';
import { draftPendingSubmissionRetired } from '@ponderosa/core';
import { ApiRequestError, ApiTransportError } from '../../apps/web/src/api/types.ts';
import { queryKeys } from '../../apps/web/src/queryKeys.ts';
import { sha256Bytes } from '../../apps/web/src/components/idempotentAttempt.ts';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const ts = require('typescript'), React = require('react');

test('confirmed queue deletion fences stale queue/history reads without hiding other deliveries',async()=>{
 const {QueryClient}=require('@tanstack/react-query'),client=new QueryClient();
 const queued={activationId:'delivery',targetAgentId:'agent',state:'queued',queuedForNextRun:true,attemptCount:1,updatedAt:'2026-11-10T00:00:00Z'};
 const deleted={...queued,state:'cancelled',queuedForNextRun:undefined,queueDeletionConfirmed:true,updatedAt:'2026-11-10T00:00:01Z'};
 const source={id:'message',communicationEventId:'message',conversationId:'chat',communicationSender:{kind:'user',userId:'local-operator'},text:'Exact retained input',createdAt:queued.updatedAt,deliveryReceipts:[queued]};
 const queue=[{deliveryId:'delivery',messageId:'message',targetAgentId:'agent',conversationId:'chat',text:source.text,status:'queued'}];
 const key=queryKeys.conversations.activeDeliveryReceipts('chat','message','');let release;
 const oldRead=client.fetchQuery({queryKey:key,queryFn:()=>new Promise(resolve=>{release=()=>resolve({items:[{communicationEventId:'message',deliveryReceipts:[queued]}]});})});
 await Promise.resolve();applyQueuedMessageCancellation(client,{cancelled:true,replayed:false,status:'cancelled',message:{conversationId:'chat',communicationEventId:'message',deliveryReceipts:[deleted]}});
 let projected=projectMessageDeliveryReceipts([source],client.getQueryData(key).items);
 release();await oldRead.catch(()=>{});
 assert.equal(client.getQueryData(key).items[0].deliveryReceipts[0].queueDeletionConfirmed,true,'Cancelled old fetch cannot replace accepted canonical evidence');
 for(const stale of [[queued],[{...queued,updatedAt:deleted.updatedAt}],[]]){
  projected=projectMessageDeliveryReceipts([source],[{communicationEventId:'message',deliveryReceipts:stale}],projected);
  assert.equal(messageHiddenByQueue(projected[0]),true);assert.deepEqual(reconcileQueuedMessages(projected,queue),[]);
  assert.deepEqual(reconcileQueuedProjectMessages([{kind:'message',message:projected[0]}],queue).timeline,[],'No Cancelled placeholder in shared Chat projection');
 }
 assert.equal(messageHiddenByQueue({...source,deliveryReceipts:[{...deleted,queueDeletionConfirmed:undefined}]}),false,'Unrelated cancelled work remains visible');
 for(const state of ['delivered','processed','unconfirmed','queued']){
  const sibling={...queued,targetAgentId:'other',activationId:'other-delivery',queuedForNextRun:undefined,state};
  assert.equal(messageHiddenByQueue({...source,deliveryReceipts:[{...deleted,queueDeletionConfirmed:undefined},sibling]},new Set(['message'])),false,'Another legitimate recipient remains visible: '+state);
 }
 const changed={...source,conversationId:'other-chat'};assert.equal(messageHiddenByQueue(projectMessageDeliveryReceipts([changed],[],projected)[0]),false,'Retained proof cannot cross conversation owner');
 for(const state of ['delivered','processed','run_unconfirmed','unconfirmed']){
  const acknowledged={...queued,state,queuedForNextRun:undefined,providerAcknowledged:true,updatedAt:deleted.updatedAt};
  assert.equal(messageHiddenByQueue(projectMessageDeliveryReceipts([source],[{communicationEventId:'message',deliveryReceipts:[acknowledged]}],projected)[0]),false,'Equal-clock effect evidence wins over deletion: '+state);
 }
 assert.deepEqual(reconcileQueuedMessages(projected,[{...queue[0],deliveryId:'old-attempt'}]),[],'An older queue attempt cannot survive exact deletion evidence');
 const next={...queued,activationId:'new-attempt',attemptCount:2,updatedAt:'2026-11-10T00:00:02Z',queuedForNextRun:undefined};
 assert.equal(reconcileQueuedMessages([{...source,deliveryReceipts:[{...queued,state:'processed',queuedForNextRun:undefined}]}],[{...queue[0],deliveryId:'new-attempt'}]).length,1,'A newer queue read remains available while canonical receipts still show another older attempt');
 assert.equal(messageHiddenByQueue(projectMessageDeliveryReceipts([source],[{communicationEventId:'message',deliveryReceipts:[next]}],projected)[0]),false,'New canonical attempt supersedes historical proof');
 client.clear();
});
class CapturedRetirementStorageError extends Error {}
const widget = name => Object.assign(() => null, { displayName: name });
const mui = new Proxy({}, { get: (target, name) => target[name] ??= widget(name) });
function load(relative, imports = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/' + relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, Error, Event, ...globals, require: name => {
    if (name in imports) return name==='./submissionOutbox'?{CapturedRetirementStorageError,...imports[name]}:imports[name];
    if(name==='../../api/productScope'||name==='../api/productScope')return {productApiPath:path=>path};
    if(name==='../../api/types')return {ApiRequestError,ApiTransportError};
    if(name==='../../api/queryRetry')return {queryRetryDelay:()=>0};
    if(name==='@ponderosa/core')return {draftPendingSubmissionRetired};
    if (name === './WorkspaceReadOnlyContext') return { useWorkspaceReadOnly: () => false };
    if (name === './messageDeliveryPhase') return { messageDeliveryPhase };
    if (name === './ReviewedContinuationDialog') return { ReviewedContinuationDialog: widget('ReviewedContinuationDialog') };
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
  [{ state: 'unconfirmed', taskDecisionRepairHold: true }, /could not verify the Decision status for Reader.s work/u, 'Task Check Held'],
  [{ state: 'run_unconfirmed', providerAcknowledged: true }, /lost contact before confirming whether the work finished/u, 'Work Unconfirmed'],
  [{ state: 'retry_exhausted', providerAcknowledged: true }, /after 6 attempts; automatic recovery stopped/u, 'Reply Exhausted'],
  [{ state: 'cancelled', providerAcknowledged: false }, /cancelled/u, 'Cancelled'],
  [{ state: 'cancelled', providerAcknowledged: true, runStopState: 'stopping' }, /termination has not been confirmed/u, 'Delivered · Stopping'],
  [{ state: 'cancelled', providerAcknowledged: true, runStopState: 'unconfirmed' }, /whether its work stopped is unconfirmed/u, 'Delivered · Stop Unconfirmed'],
]) test(`Q01 actual delivery view distinguishes ${compact}`, () => {
  const nodes = status(extra)(), announcement = nodes.find(node => node.props.role === 'status');
  assert.equal(announcement.props['aria-live'], 'polite'); assert.match(text(announcement), expected);
  assert.ok(nodes.some(node => node.type === mui.Typography && text(node) === compact));
});
test('a Decision-accounting hold and context-refresh hold are both disclosed', () => {
 const nodes=status({state:'unconfirmed',taskDecisionRepairHold:true,contextRolloverHold:'retry_available',contextRolloverAttemptId:'held'})();
 const announcement=nodes.find(node=>node.props.role==='status');assert.match(text(announcement),/Task recovery is held until it can be checked/);assert.match(text(announcement),/Context refresh also could not safely continue/);
 assert.ok(!nodes.some(node=>node.type===mui.Button&&['Try Work Again','Try Delivery Again'].includes(text(node))));
});
test('Decision-accounting hold does not expose a steering recovery action', () => {
 const nodes=status({state:'unconfirmed',taskDecisionRepairHold:true,injectionKind:'steer',injectionId:'old-injection',canRetry:true,canLetCurrentRunFinish:true})();
 assert.ok(nodes.some(node=>node.props.role==='status'&&text(node).includes('could not verify')));
 assert.ok(!nodes.some(node=>node.type===mui.Button&&['Review Interrupted Work','Try Work Again','Try Delivery Again','Let Current Run Finish'].includes(text(node))));
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
    react: h.react, './MutationNotifications':{useMutationNotification:()=>()=>{}},'../api/productScope':{productApiPath:path=>path}, '@tanstack/react-query': { useQueryClient: () => client, useQuery: () => ({}) }, '../api': { api: { cancelRun: async (agentId, body) => {
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
  assert.throws(() => final.saveCapturedSubmission({...first,pending:{...first.pending,idempotencyKey:'storage-refused'}}), /could not be saved for recovery/u);
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
test('UI013 an exact steering wait reason stays visible ahead of generic Waiting', () => {
  for (const [reason, label] of Object.entries({ context_refresh: 'Waiting For Context Refresh', prior_steering: 'Waiting For Earlier Steer', revision_pending: 'Saving Message Edit', provider_not_ready: 'Waiting For Provider', provider_unsupported: 'Provider Cannot Steer', preparation_retry: 'Retrying Steer Preparation', run_starting: 'Waiting For Run Startup', scheduler_pending: 'Steer Pending' })) {
    for (const state of ['queued', 'retrying']) {
      const nodes = status({ state, steeringWaitReason: reason })();
      assert.ok(nodes.some(node => node.type === mui.Typography && text(node) === label), `${state}: ${reason}`);
    }
  }
});
test('UI013 current queue blockers explain Waiting without borrowing another turn acknowledgement', () => {
  for (const [reason, label] of Object.entries({ host_resource_pressure: 'Waiting For Host Resources', provider_disabled: 'Provider Disabled', authentication_unknown: 'Checking Provider Sign-In', authentication_required: 'Provider Sign-In Required', provider_unavailable: 'Waiting For Provider', provider_retry: 'Waiting To Retry Provider', current_run: 'Waiting For Current Run' })) {
    const nodes = status({ state: 'queued', queueWaitReason: reason })();
    assert.ok(nodes.some(node => node.type === mui.Typography && text(node) === label), reason);
    assert.ok(!nodes.some(node => node.type === mui.Typography && text(node) === 'Working'));
  }
  const terminal = status({ state: 'processed', queueWaitReason: 'host_resource_pressure', steeringWaitReason: 'provider_not_ready' })();
  assert.ok(!terminal.some(node => node.type === mui.Typography && /Waiting/.test(text(node))));
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

test('unconfirmed steer says it is held instead of promising an automatic interruption',()=>{
 const nodes=status({state:'unconfirmed',canLetCurrentRunFinish:true,injectionId:'held'})();
 const announcement=nodes.find(node=>node.props.role==='status');
 assert.match(text(announcement),/unconfirmed/);
 assert.match(text(announcement),/held for review/);
 assert.doesNotMatch(text(announcement),/Interrupting|recovering now/);
 assert.ok(nodes.some(node=>node.type===mui.Button&&text(node)==='Let Current Run Finish'));
});

test('ordinary outgoing Chat identity works without Web Crypto and matches server IDs', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'crypto', descriptor) : delete globalThis.crypto);
  const h = hooks();
  h.react.useCallback = fn => fn;
  const module = load('components/chat/OutgoingMessage.tsx', {
    './ChatAttachments': { ChatAttachments: widget('Attachments') },
    '../CopyMessageButton':{CopyMessageButton:widget('Copy')},
    './capturedDraftSubmissions':{reconcileAcceptedCapture:async()=>true},
    '@tanstack/react-query': { useQuery: () => ({}),useQueryClient:()=>({}) },
    '../../api': { api: {} },
    '../../queryKeys': { queryKeys },
    './submissionOutbox': { readCapturedSubmissions: () => [] },
    react: h.react,
    '../../clientId': { createClientId: () => 'sending-fixture' },
    '../idempotentAttempt': { sha256Bytes },
    '../ConversationChromeContext': { ConversationChromeContext: React.createContext(undefined) },
    './ChatMessageFrame': { ChatMessageFrame: widget('Frame') },
    './ChatMessages': { ChatMessageBody: widget('Body') },
  }, { crypto: {}, TextEncoder });
  const render = () => h.render(() => module.OutgoingMessageProvider({ children: null, scope: 'chat-a' })).props.value;
  const cases = [
    ['broadcast', 'chat-a\0send-key'],
    ['user-dm', 'multi-direct:chat-a:send-key'],
    ['user-message', 'project-a\0agent-a\0send-key'],
    ['broadcast', 'chat-λ😀\0' + 'x'.repeat(100)],
  ];
  for (const [prefix, seed] of cases) {
    const id = render().begin('synthetic message', []);
    await render().identify(id, prefix, seed);
    const expected = prefix + '-' + createHash('sha256').update(seed, 'utf8').digest('hex');
    assert.equal(render().messages[0].communicationId, expected);
    render().accepted(id);
    render().reconcile([{communicationEventId:expected}]);
    assert.equal(render().messages[0].reconciled,true,'Canonical observation adopts the exact optimistic operation');
    assert.equal(render().messages[0].text,'','Adopted anchors retain no second message text');
    render().reconcile([]);
    assert.equal(render().messages.length,0,'Presentation anchor leaves with its canonical row');
  }
});

test('captured send acquires the latest durable marker after another tab releases the lock', async t => {
  const previousWindow = globalThis.window;
  const window = Object.assign(new EventTarget(), { localStorage: new Storage() });
  globalThis.window = window;
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  let tail = Promise.resolve();
  const navigator = { locks: { request: async (_name, run) => {
    const previous = tail; let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous; try { return await run(); } finally { release(); }
  } } };
  const open = () => load('components/chat/submissionOutbox.ts', { '../../chatState.js': chatState }, { window, navigator });
  const first = open(), second = open();
  const item = { version: 1, scope: 'chat-a', storageKey: 'draft-a', ownerId: 'owner', clientId: 'tab-a', createdAt: 1, action: 'send', text: 'Exact message', editorText: 'Exact message', attachmentNames: [], mentionedAgents: [], newAgentRequested: false, pending: { fingerprint: 'a'.repeat(64), idempotencyKey: 'same-key' }, status: 'pending', dispatchStarted: false };
  first.saveCapturedSubmission(item);
  let proceed, entered; const gate = new Promise(resolve => { proceed = resolve; });
  const locked = new Promise(resolve => { entered = resolve; });
  const tabA = first.runCapturedSubmission(item, async () => {
    first.saveCapturedSubmission({ ...item, dispatchStarted: true });
    entered(); await gate;
    throw Error('Acknowledgement lost');
  }, error => {
    first.saveCapturedSubmission({ ...item, dispatchStarted: true, status: 'unknown', error: error.message });
  });
  await locked;
  let observed;
  const tabB = second.runCapturedSubmission(item, async current => { observed = current; });
  proceed(); await Promise.all([tabA, tabB]);
  assert.equal(observed?.dispatchStarted, true, 'the second tab must use the current durable dispatch marker');
  assert.equal(observed?.status, 'unknown');
});

test('settings handoff receipt exposes retry only for a provably unstarted hold', async () => {
  const calls=[];
  const render=status({state:'unconfirmed',settingsTransitionHold:'retry_available',canRetry:true},
    {retryMessageDelivery:async (...args)=>calls.push(args)});
  const nodes=render(),announcement=nodes.find(node=>node.props.role==='status');
  assert.match(text(announcement),/original message remains queued/u);
  assert.ok(nodes.some(node=>node.type===mui.Typography&&text(node)==='Waiting For Context'));
  const retry=nodes.find(node=>node.type===mui.Button&&text(node)==='Try Delivery Again');
  assert.ok(retry);retry.props.onClick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);assert.equal(calls[0][0],'project');assert.equal(calls[0][1],'delivery-a');
  assert.equal(calls[0][2].idempotencyKey,'fixture-id');
  assert.deepEqual(Object.keys(calls[0][2]),['idempotencyKey']);
  assert.ok(!nodes.some(node=>node.type===mui.Button&&text(node)==='Cancel Delivery'));
  const both=status({state:'unconfirmed',settingsTransitionHold:'review_required',taskDecisionRepairHold:true,canRetry:true})();
  assert.match(text(both.find(node=>node.props.role==='status')),/Decision status.*Context refresh also could not safely continue/u);
  assert.ok(!both.some(node=>node.type===mui.Button&&/Try Delivery Again|Review Interrupted Work|Cancel Delivery/u.test(text(node))));
  const uncertain=status({state:'unconfirmed',settingsTransitionHold:'review_required',canRetry:true})();
  assert.match(text(uncertain.find(node=>node.props.role==='status')),/review the Agent’s activity/u);
  assert.ok(!uncertain.some(node=>node.type===mui.Button&&/Try Delivery Again|Review Interrupted Work|Cancel Delivery/u.test(text(node))));
});


test('UI012 observed acceptance survives stale metadata writers and removal bypasses only send order',async t=>{
 const previous=globalThis.window,previousNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 const window=Object.assign(new EventTarget(),{localStorage:new Storage()});globalThis.window=window;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_key,run)=>run()}}});
 t.after(()=>{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;if(previousNavigator)Object.defineProperty(globalThis,'navigator',previousNavigator);else delete globalThis.navigator;});
 const module=load('components/chat/submissionOutbox.ts',{'../../chatState.js':chatState},{window,navigator:globalThis.navigator});
 const first={version:1,scope:'chat',storageKey:'draft',ownerId:'owner',clientId:'tab',createdAt:1,action:'send',text:'Earlier uncertain input',editorText:'Earlier uncertain input',attachmentNames:[],mentionedAgents:[],newAgentRequested:false,pending:{fingerprint:'a'.repeat(64),idempotencyKey:'earlier'},status:'unknown',dispatchStarted:true};
 const later={...first,createdAt:2,text:'Definitely rejected later',status:'failed',dispatchStarted:false,pending:{...first.pending,idempotencyKey:'later'}};
 module.saveCapturedSubmission(first);module.saveCapturedSubmission(later);
 assert.equal(module.earlierCapturedSubmission(later).pending.idempotencyKey,'earlier');
 let calls=0;await assert.rejects(module.runCapturedSubmission(later,async()=>calls++),/earlier captured/);assert.equal(calls,0);
 await assert.rejects(module.removeRejectedCapturedSubmission(first,async()=>calls++),/Acceptance is unconfirmed/);assert.equal(calls,0);
 let release;const gate=new Promise(resolve=>release=resolve);
 const removing=module.removeRejectedCapturedSubmission(later,async current=>{await gate;module.removeCapturedSubmission(current.pending.idempotencyKey);});
 assert.equal(module.capturedSubmissionActivity('later'),'remove');release();await removing;
 assert.deepEqual(Array.from(module.readCapturedSubmissions('chat'),item=>item.pending.idempotencyKey),['earlier']);
 module.saveCapturedSubmission({...first,status:'accepted',communicationId:'canonical-exact',acceptedDeliveryIds:['observed-delivery']});
 module.saveCapturedSubmission({...first,status:'pending'});module.saveCapturedSubmission({...first,status:'failed'});
 const observed=module.readCapturedSubmissions('chat')[0];assert.equal(observed.status,'accepted');assert.equal(observed.communicationId,'canonical-exact');assert.deepEqual(Array.from(observed.acceptedDeliveryIds),['observed-delivery']);
});

test('UI012 exact retirement preserves canonical siblings/newer draft and retries CAS without merging stale local captures',async()=>{
 const pending={idempotencyKey:'remove-exact',fingerprint:'a'.repeat(64)},earlier={idempotencyKey:'canonical-earlier',fingerprint:'b'.repeat(64)};
 let current={conversationId:'chat',ownerId:'owner',revision:8,clientId:'newer-tab',text:'Newer exact editable text',attachmentIds:['newer-attachment'],pendingSubmissions:[earlier,pending]},conflict=true;const writes=[];
 const module=load('components/chat/capturedDraftSubmissions.ts',{'../../api':{api:{getConversationDraft:async()=>current,putConversationDraft:async(_scope,body)=>{writes.push(body);if(conflict){conflict=false;current={...current,revision:9,text:'Even newer text'};throw new ApiRequestError(409,'CAS conflict');}return current={...current,...body,revision:current.revision+1,retiredPendingSubmissionIds:body.retirePendingSubmissionIds.map(idempotencyKey=>({idempotencyKey}))};}}},'./submissionOutbox':{capturedSubmissionRetired:()=>false,removeCapturedSubmission:()=>{},readCapturedSubmissions:()=>[{pending:{idempotencyKey:'invalid-local-earlier',uploads:[{scope:'broadcast',recipients:[{agentId:'invalid-chat-owner',attachmentIds:['original']}]}]}}]}});
 await assert.rejects(module.persistCapturedDraftSubmission('chat','owner','old-tab',pending,true,8),/CAS conflict/);
 const result=await module.persistCapturedDraftSubmission('chat','owner','old-tab',pending,true,8);
 assert.equal(result.draft.text,'Even newer text');assert.deepEqual(Array.from(result.draft.attachmentIds),['newer-attachment']);assert.deepEqual(Array.from(result.draft.pendingSubmissions,item=>item.idempotencyKey),['canonical-earlier']);assert.deepEqual(Array.from(writes[1].retirePendingSubmissionIds),['remove-exact']);assert.equal(result.mayAdvanceDraftRevision,false);
 current={...current,retiredPendingSubmissionIds:[{idempotencyKey:pending.idempotencyKey}]};const count=writes.length;assert.equal((await module.persistCapturedDraftSubmission('chat','owner','old-tab',pending,true,8)).retired,true);assert.equal(writes.length,count,'Already-settled exact retirement issues no replacement write');
});

test('automatic context maintenance has no delivery badge, technical checks or recovery controls',()=>{
 assert.deepEqual(status({state:'unconfirmed',settingsTransitionHold:'retry_available',contextRecoveryRequired:{sourceRunId:'earlier'},canRetry:true})(),[]);
});

test('UI018 verified retirement fences a stale tab body write and preserves another operation',async t=>{
 const previous=globalThis.window,window=Object.assign(new EventTarget(),{localStorage:new Storage()});globalThis.window=window;t.after(()=>previous===undefined?delete globalThis.window:globalThis.window=previous);
 const open=()=>load('components/chat/submissionOutbox.ts',{'../../chatState.js':chatState},{window});
 const item={version:1,scope:'chat',ownerId:'owner',storageKey:'draft',clientId:'tab',createdAt:1,action:'send',text:'Frozen original',editorText:'Frozen original',attachmentNames:[],mentionedAgents:[],newAgentRequested:false,pending:{idempotencyKey:'retired-exact',fingerprint:'a'.repeat(64),captureRevision:4},status:'failed'};
 const first=open();first.saveCapturedSubmission(item);first.removeCapturedSubmission(item.pending.idempotencyKey,item);
 chatState.writeChatState('ponderosa.submission.v1.retired-exact',JSON.stringify(item));
 const stale=open();assert.equal(stale.readCapturedSubmissions().length,0);stale.saveCapturedSubmission(item);let calls=0;await stale.runCapturedSubmission(item,async()=>calls++);assert.equal(calls,0,'Late callback cannot re-execute a retired key');
 const other={...item,pending:{...item.pending,idempotencyKey:'different-key'}};stale.saveCapturedSubmission(other);assert.equal(stale.readCapturedSubmissions()[0].pending.idempotencyKey,'different-key');
 const wrongOwner={...item,ownerId:'another-owner'};assert.equal(stale.capturedSubmissionRetired(item.pending.idempotencyKey,wrongOwner),false,'Marker has exact owner boundary');
});

test('UI018 Retry adopts server preparation instead of replacing it with the browser snapshot',async()=>{
 const pending={idempotencyKey:'prepared',fingerprint:'0'.repeat(64),captureRevision:0};
 const prepared={...pending,fingerprint:'b'.repeat(64),intentFingerprint:'a'.repeat(64),agentTitle:'Prepared Title',uploads:[{scope:'agent',recipients:[{agentId:'agent',attachmentIds:['file']}]}]};
 const current={conversationId:'chat',ownerId:'owner',revision:2,clientId:'editor',text:'New editable text',attachmentIds:[],pendingSubmissions:[prepared]};let sent;
 const module=load('components/chat/capturedDraftSubmissions.ts',{'../../api':{api:{getConversationDraft:async()=>current,putConversationDraft:async(_scope,body)=>{sent=body;return {...current,...body,revision:3};}}},'./submissionOutbox':{capturedSubmissionRetired:()=>false,removeCapturedSubmission:()=>{},readCapturedSubmissions:()=>[{scope:'chat',ownerId:'owner',pending,status:'failed'}]}});
 const result=await module.persistCapturedDraftSubmission('chat','owner','old-tab',pending);assert.equal(sent.captureMetadataOnly,true);assert.equal(result.pendingSubmission.agentTitle,'Prepared Title');assert.equal(result.pendingSubmission.fingerprint,prepared.fingerprint);assert.equal(result.pendingSubmission.uploads[0].recipients[0].attachmentIds[0],'file');assert.equal(sent.text,current.text);
});

test('UI018 metadata retirement stops before a product-changing GET can become a different product PUT',async()=>{
 let namespace='/api/conversations',writes=0;
 const pending={idempotencyKey:'exact',fingerprint:'a'.repeat(64),captureRevision:0};
 const module=load('components/chat/capturedDraftSubmissions.ts',{'../../api/productScope':{productApiPath:()=>namespace},'../../api':{api:{getConversationDraft:async()=>{namespace='/api/branches/engine/conversations';return {revision:1,pendingSubmissions:[pending]};},putConversationDraft:async()=>writes++}},'./submissionOutbox':{capturedSubmissionRetired:()=>false,removeCapturedSubmission:()=>{},readCapturedSubmissions:()=>[]}});
 await assert.rejects(module.persistCapturedDraftSubmission('chat','owner','tab',pending,true),/destination changed/);assert.equal(writes,0);
});

test('UI018 accepted housekeeping has one bounded cycle per eligible lifecycle, never canonical rerender loops',async()=>{
 const {QueryClient}=require('@tanstack/react-query');const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});let status=403,writes=0;
 const pending={idempotencyKey:'accepted-cycle',fingerprint:'a'.repeat(64),captureRevision:0},item={scope:'chat',ownerId:'owner',clientId:'tab',status:'accepted',pending};
 const current={conversationId:'chat',ownerId:'owner',revision:1,clientId:'tab',text:'Unrelated editor',attachmentIds:[],pendingSubmissions:[pending]};
 const module=load('components/chat/capturedDraftSubmissions.ts',{'../../api':{api:{getConversationDraft:async()=>current,putConversationDraft:async(_scope,body)=>{writes++;if(status)throw new ApiRequestError(status,'Controlled retirement error');return {...current,...body,revision:2,pendingSubmissions:[],retiredPendingSubmissionIds:[{idempotencyKey:pending.idempotencyKey}]};}}},'./submissionOutbox':{removeCapturedSubmission:()=>{},readCapturedSubmissions:()=>[item]}});
 try{await assert.rejects(module.reconcileAcceptedCapture(client,item));for(let i=0;i<5;i++)await assert.rejects(module.reconcileAcceptedCapture(client,item));await assert.rejects(module.reconcileAcceptedCapture(client,item,true));assert.equal(writes,1,'Permanent rejection cannot hot loop on render/focus');
 client.removeQueries();status=503;await assert.rejects(module.reconcileAcceptedCapture(client,item));assert.equal(writes,5,'Transient failures use bounded native retry');for(let i=0;i<5;i++)await assert.rejects(module.reconcileAcceptedCapture(client,item));assert.equal(writes,5);status=0;await module.reconcileAcceptedCapture(client,item,true);assert.equal(writes,6,'Meaningful reconnect can resume an eligible failed cycle');await module.reconcileAcceptedCapture(client,item);assert.equal(writes,6,'Verified success stays deduplicated');
 }finally{client.clear();}
});

test('UI018 a new capture registers independently of an accepted sibling retirement',async()=>{
 const accepted={status:'accepted',scope:'chat',ownerId:'owner',pending:{idempotencyKey:'accepted-a',fingerprint:'a'.repeat(64),captureRevision:0}},pending={idempotencyKey:'new-b',fingerprint:'b'.repeat(64),captureRevision:0};let writes=0;
 const current={conversationId:'chat',ownerId:'owner',revision:2,text:'Newer editor',attachmentIds:[],pendingSubmissions:[accepted.pending]};
 const module=load('components/chat/capturedDraftSubmissions.ts',{'../../api':{api:{getConversationDraft:async()=>current,putConversationDraft:async(_scope,body)=>{writes++;assert.equal(body.retirePendingSubmissionIds,undefined,'Ordinary registration never carries unrelated retirement');return {...current,...body,revision:3};}}},'./submissionOutbox':{removeCapturedSubmission:()=>{},readCapturedSubmissions:()=>[accepted]}});
 const result=await module.persistCapturedDraftSubmission('chat','owner','tab',pending);assert.equal(writes,1);assert.deepEqual(Array.from(result.draft.pendingSubmissions,item=>item.idempotencyKey),['accepted-a','new-b']);
});

test('UI018 deferred accepted retirement resumes on original-scope focus and restored storage without replay',async()=>{
 const {QueryClient}=require('@tanstack/react-query'),client=new QueryClient({defaultOptions:{queries:{gcTime:Infinity}}});let namespace='/api/branches/engine/conversations',writes=0,storageFails=false,retired=false;
 const pending={idempotencyKey:'deferred-retirement',fingerprint:'a'.repeat(64),captureRevision:0},item={scope:'chat',ownerId:'owner',clientId:'tab',apiNamespace:'/api/conversations',status:'accepted',pending};
 const module=load('components/chat/capturedDraftSubmissions.ts',{'../../api/productScope':{productApiPath:()=>namespace},'../../api':{api:{getConversationDraft:async()=>({conversationId:'chat',ownerId:'owner',revision:1,text:'Newer editable',attachmentIds:[],pendingSubmissions:retired?[]:[pending],retiredPendingSubmissionIds:retired?[{idempotencyKey:pending.idempotencyKey}]:[]}),putConversationDraft:async(_scope,body)=>{writes++;retired=true;return {...body,pendingSubmissions:[],revision:2,retiredPendingSubmissionIds:[{idempotencyKey:pending.idempotencyKey}]};}}},'./submissionOutbox':{readCapturedSubmissions:()=>[item],removeCapturedSubmission:()=>{if(storageFails)throw new CapturedRetirementStorageError('Controlled storage refusal');}}});
 try{await assert.rejects(module.reconcileAcceptedCapture(client,item));await assert.rejects(module.reconcileAcceptedCapture(client,item,true));assert.equal(writes,0,'Foreign focus never performs a write');namespace='/api/conversations';storageFails=true;await assert.rejects(module.reconcileAcceptedCapture(client,item,true),/storage refusal/);assert.equal(writes,1);storageFails=false;await module.reconcileAcceptedCapture(client,item,true);assert.equal(writes,1,'Restored storage settles from canonical retirement without replay or a second PUT');}finally{client.clear();}
});
