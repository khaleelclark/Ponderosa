import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const ts = require('typescript'), React = require('react');
const source = name => readFileSync(new URL('../../apps/web/src/' + name, import.meta.url), 'utf8');
const transpile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;

// Exercise the real view's handlers. Only React scheduling and DOM/MUI rendering
// are controlled; no second implementation of selection or commit behavior.
function picker(overrides = {}) {
  let cursor = 0; const cells = [], effects = [], callbacks = [], listeners = new Map(), document = {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event); },
  };
  Object.assign(document, { visibilityState: 'visible', activeElement: null, body: {}, getSelection: () => ({ rangeCount: 0 }), getElementById: () => null });
  class HTMLElement {}
  const cell = initial => { const i = cursor++; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial; return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value; }]; };
  const react = { useState: cell, useRef: initial => cell(() => ({ current: initial }))[0], useCallback: fn => fn, useId: () => 'picker', useEffect(fn, deps) {
    const i = cursor++, previous = cells[i];
    if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) effects.push(() => { previous?.cleanup?.(); cells[i] = { deps, cleanup: fn() }; });
  } };
  const mui = new Proxy({ useTheme: () => ({ palette: { mode: 'dark' } }) }, { get: (object, name) => object[name] ??= () => null });
  const exports = {};
  vm.runInNewContext(transpile(source('components/ComposerRuntimeSelector.tsx')), { exports, document, HTMLElement, require: name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return require(name);
    if (name === '@mui/material') return mui;
    if (name.startsWith('@mui/icons-material/')) return { __esModule: true, default: () => null };
    throw Error(name);
  } });
  const props = { selectionKey: 'owner-a', engine: 'fixture', engines: [{ id: 'fixture', label: 'Engine' }, { id: 'other', label: 'Other' }], model: 'live-id', models: [{ id: 'live-id', label: 'Live label' }], effort: 'balanced-id', efforts: [{ id: 'tiny-id', label: 'Low' }, { id: 'balanced-id', label: 'Medium' }, { id: 'deep-id', label: 'Ultra' }], speed: 'standard', speeds: [{ id: 'standard', label: 'Normal' }, { id: 'advertised-fast-id', label: 'Fast', detail: 'Live CLI description' }], onModelChange: id => callbacks.push(['model', id]), onEffortChange: id => { callbacks.push(['effort', id]); props.effort = id; }, onSpeedChange: id => callbacks.push(['speed', id]), onEngineChange: id => callbacks.push(['engine', id]), onReset: () => callbacks.push(['reset']), ...overrides };
  function* walk(node) { if (!React.isValidElement(node)) return; yield node; for (const child of React.Children.toArray(node.props.children)) yield* walk(child); }
  let nodes;
  const render = () => { cursor = 0; nodes = [...walk(exports.ComposerRuntimeSelector(props))]; for (const effect of effects.splice(0)) effect(); return nodes; };
  const find = label => { render(); return nodes.find(node => node.props['aria-label'] === label); };
  render();
  const anchor = { ownerDocument: document, focus() {} };
  find('Choose engine, model, reasoning, and speed').props.onClick({ detail: 0, currentTarget: anchor }); render();
  return { props, callbacks, render, find, document, mui, exports, HTMLElement, close() { for (const value of cells) value?.cleanup?.(); } };
}

test('slider maps advertised stops and accessible labels to exact IDs; preview does not save', t => {
  const p = picker(); t.after(p.close);
  let slider = p.find('Reasoning effort');
  assert.deepEqual(Array.from(slider.props.marks, stop => stop.value), [0, 1, 2]);
  assert.equal(slider.props.step, 1, 'contiguous indices use integer stepping so MUI Home/End reach endpoints');
  assert.equal(slider.props.getAriaValueText(2), 'Ultra');
  slider.props.onChange({}, 2); p.render(); assert.deepEqual(p.callbacks, []);
  p.find('Reasoning effort').props.onChangeCommitted({}, 2);
  assert.deepEqual(p.callbacks, [['effort', 'deep-id']]);
  assert.equal(p.render().find(node => node.type === p.mui.Popper).props.open, true);
  p.find('Reasoning effort').props.onChangeCommitted({}, 2);
  assert.equal(p.callbacks.length, 1);
});
for (const boundary of ['close', 'model', 'catalog', 'owner', 'effort', 'pending-cycle']) test(`stale drag cannot save after ${boundary}`, t => {
  const p = picker(); t.after(p.close);
  const late = p.find('Reasoning effort').props.onChangeCommitted;
  p.find('Reasoning effort').props.onChange({}, 2);
  if (boundary === 'close') p.find('Choose engine, model, reasoning, and speed').props.onClick({ detail: 0, currentTarget: {} });
  else if (boundary === 'model') p.props.model = 'replacement';
  else if (boundary === 'catalog') p.props.efforts = [{ id: 'new', label: 'New' }];
  else if (boundary === 'owner') p.props.selectionKey = 'owner-b';
  else if (boundary === 'effort') p.props.effort = 'tiny-id';
  else { p.props.disabled = true; p.render(); p.props.disabled = false; }
  p.render(); late({}, 2); assert.deepEqual(p.callbacks, []);
});
for (const efforts of [[], [{ id: 'only', label: 'Only' }]]) test(`reasoning with ${efforts.length} stop(s) is read-only`, t => {
  const p = picker({ efforts, effort: efforts[0]?.id ?? '' }); t.after(p.close);
  assert.equal(p.find('Reasoning effort').props.disabled, true);
});
test('an external availability lock keeps the picker open with controls disabled', t => {
  const p = picker(); t.after(p.close); p.props.disabled = true;
  assert.equal(p.find('Reasoning effort').props.disabled, true);
  assert.equal(p.render().find(node => node.type === p.mui.Popper).props.open, true);
});
test('speed saves advertised tier and never writes an effort; reset is one owner action', t => {
  const p = picker(); t.after(p.close);
  p.find('Engine Fast mode off. Live CLI description').props.onClick();
  assert.deepEqual(p.callbacks, [['speed', 'advertised-fast-id']]);
  p.find('Reset to default').props.onClick();
  assert.deepEqual(p.callbacks.at(-1), ['reset']);
});
test('Escape closes inline choices before the popover and stops editor propagation', t => {
  const p = picker(); t.after(p.close); p.find('Model: Live label').props.onClick(); p.render();
  const escape = () => { const event = new Event('keydown', { cancelable: true }); Object.defineProperty(event, 'key', { value: 'Escape' }); p.document.dispatchEvent(event); assert.equal(event.defaultPrevented, true); };
  escape(); assert.equal(p.find('Model: Live label').props['aria-expanded'], false);
  assert.equal(p.render().find(node => node.type === p.mui.Popper).props.open, true);
  escape(); assert.equal(p.render().find(node => node.type === p.mui.Popper).props.open, false);
});


test('keyboard slider focus resumes after its pending save without stealing a new focus target', t => {
  const p = picker(); t.after(p.close); let focused = 0;
  const input = { isConnected: true, focus() { focused++; } };
  p.document.getElementById = () => ({ contains: element => element === input });
  p.document.activeElement = input;
  p.find('Reasoning effort').props.onChangeCommitted({}, 2);
  p.props.disabled = true; p.render(); p.document.activeElement = p.document.body;
  p.props.disabled = false; p.render(); assert.equal(focused, 1);
  p.document.activeElement = input; p.find('Reasoning effort').props.onChangeCommitted({}, 0);
  p.props.disabled = true; p.render(); p.document.activeElement = {};
  p.props.disabled = false; p.render(); assert.equal(focused, 1);
});
test('MUI thumb focus during touch restores the editor and exact saved caret without cancelling drag', t => {
  const p = picker(); t.after(p.close);
  const trigger = 'Choose engine, model, reasoning, and speed';
  p.find(trigger).props.onClick({ detail: 0, currentTarget: {} }); p.render();
  let focused = 0, restored;
  const editor = new p.HTMLElement(); Object.assign(editor, { isConnected: true, closest: () => editor, focus() { focused++; } });
  const range = {}; p.document.getSelection = () => ({ rangeCount: 1, getRangeAt: () => ({ cloneRange: () => range }), removeAllRanges() {}, addRange(value) { restored = value; } });
  p.document.activeElement = editor;
  p.find(trigger).props.onPointerDown({ pointerType: 'touch' });
  p.find(trigger).props.onClick({ detail: 1, currentTarget: { ownerDocument: p.document } });
  const slider = p.find('Reasoning effort'); slider.props.onFocusCapture();
  assert.equal(focused, 1); assert.equal(restored, range);
  slider.props.onChange({}, 2); p.find('Reasoning effort').props.onChangeCommitted({}, 2);
  assert.deepEqual(p.callbacks, [['effort', 'deep-id']]);
});

test('reset owners resolve without overrides, save one complete tuple and skip unchanged saves', () => {
  for (const name of ['ConversationView.tsx', 'AgentDetail.tsx', 'AllChatView.tsx']) {
    const text = source('components/' + name);
    const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let declaration;
    function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'resetOrChangeEngine') declaration = node; ts.forEachChild(node, visit); }
    visit(file); assert.ok(declaration, name);
    const saved = [], engine = { id: 'fixture' }, resolved = { model: 'inherited-model', effort: 'inherited-effort', speed: 'inherited-fast' };
    const globals = { engines: [engine], model: 'other', effort: 'other', speed: 'other', engine: name === 'ConversationView.tsx' ? 'fixture' : engine, selectedEngineId: 'fixture', runtimeEngine: 'fixture', agentId: 'agent', selectedAgentId: 'agent', selectedAgent: { data: { agent: {} } }, detail: { agent: {} }, preferencesQuery: {}, workspacePreferences: {}, project: {}, conversationId: 'chat', commandTargetAgent: null, settingsEngine: '', settingsModel: '', settingsEffort: '', chatStateKey: () => 'speed', readChatState: () => '', writeChatState() {}, resolveRuntimeSelection(...args) { assert.equal(args.length, 3, name + ': no explicit override'); return resolved; } };
    for (const setter of ['setSubmissionRuntimeIntent', 'setEngine', 'setRuntimeEngine', 'setModel', 'setEffort', 'setSpeed', 'setSettingsEngine', 'setSettingsModel', 'setSettingsEffort']) globals[setter] = () => {};
    for (const owner of ['persistDefaults', 'persistTargetRuntime', 'updateRuntimeSettings', 'updateRuntimeEngine']) globals[owner] = { mutate: (tuple, callbacks) => saved.push({ tuple, callbacks }) };
    globals.saveRuntimeDefaults = tuple => saved.push({ tuple });
    const context = vm.createContext(globals); vm.runInContext(transpile('const ' + declaration.getText(file) + '; resetOrChangeEngine("fixture");'), context);
    assert.equal(saved.length, 1, name);
    assert.deepEqual(Object.values(saved[0].tuple).filter(value => value !== 'fixture' && value !== 'agent'), Object.values(resolved));
    Object.assign(context, resolved); saved.length = 0;
    vm.runInContext('resetOrChangeEngine("fixture")', context); assert.equal(saved.length, 0, name + ': unchanged');
  }
});

test('automatic runtime changes are quiet; explicit Settings Save keeps its confirmation', () => {
  const mutations = [], notices = [], inline = [], exports = {};
  const imports = {
    react: { useRef: value => ({ current: value }) },
    '@tanstack/react-query': { useMutation: options => { mutations.push(options); return options; }, useQueryClient: () => ({ setQueriesData() {} }) },
    '../api': {}, '../conversationAgentCache': {}, '../hooks/useRuntimeControls': { runtimeMutationOptions: () => ({}) },
    '../queryKeys': { queryKeys: { agents: { detailPrefix: () => [], all: [] }, conversations: { detailAll: [] } } },
    './MutationNotifications': { useMutationNotification: () => notice => notices.push(notice) },
  };
  vm.runInNewContext(transpile(source('components/useAgentDetailAdministration.ts')), { exports, require: name => imports[name] });
  exports.useAgentDetailAdministration({ agentId: 'a', onRuntimeSettingsNotice: value => inline.push(value) });
  const runtime = mutations.at(-1), updated = { id: 'a' }, context = { agentId: 'a' };
  runtime.onSuccess(updated, { agentId: 'a', manual: false }, context);
  assert.deepEqual(notices, []); assert.deepEqual(inline, [undefined]);
  runtime.onSuccess(updated, { agentId: 'a', manual: true }, context);
  assert.equal(notices.length, 1); assert.match(inline.at(-1), /^Saved/);
  runtime.onError(Error('save failed'), { agentId: 'a' }, context); assert.equal(inline.at(-1), undefined);
});

test('effort casing is presentation only and ordinary model rows omit subtext', t => {
  const p = picker({ effort: 'xhigh', efforts: [{ id: 'low', label: 'low' }, { id: 'xhigh', label: 'xhigh' }], models: [{ id: 'live-id', label: 'Live label', detail: 'Latest · stores live-id' }] }); t.after(p.close);
  const slider = p.find('Reasoning effort'); assert.equal(slider.props.getAriaValueText(0), 'Low'); assert.equal(slider.props.getAriaValueText(1), 'Extra High');
  p.find('Model: Live label').props.onClick();
  assert.ok(!p.render().some(node => node.props.children === 'Latest · stores live-id'));
  p.find('Back to runtime settings').props.onClick();
  p.find('Reasoning effort').props.onChangeCommitted({}, 0); assert.deepEqual(p.callbacks, [['effort', 'low']]);
});

for (const boundary of ['owner', 'pending-cycle', 'effort']) test(`MUI latest commit callback rejects an old pointer gesture after ${boundary}`, t => {
  const p = picker(); t.after(p.close);
  p.find('Reasoning effort').props.onPointerDownCapture();
  p.find('Reasoning effort').props.onChange({ type: 'mousemove' }, 2);
  if (boundary === 'owner') p.props.selectionKey = 'owner-b';
  else if (boundary === 'effort') p.props.effort = 'tiny-id';
  else { p.props.disabled = true; p.render(); p.props.disabled = false; }
  p.render(); p.find('Reasoning effort').props.onChange({ type: 'mousemove' }, 2);
  p.find('Reasoning effort').props.onChangeCommitted({ type: 'mouseup' }, 2);
  assert.deepEqual(p.callbacks, []);
});
test('inline options remain disabled during catalog loading and retained selection handlers cannot save', t => {
  const p = picker({ models: [{ id: 'live-id', label: 'Live label' }, { id: 'new', label: 'Other' }] }); t.after(p.close);
  p.find('Model: Live label').props.onClick(); p.props.loading = true;
  const item = p.render().find(node => node.type === p.mui.MenuItem && node.props.selected === false);
  assert.equal(item.props.disabled, true); item.props.onClick(); assert.deepEqual(p.callbacks, []);
});

test('cancelled pointer cannot save, and later keyboard input remains usable', t => {
  const p = picker(); t.after(p.close);
  p.find('Reasoning effort').props.onPointerDownCapture(); p.find('Reasoning effort').props.onPointerCancel();
  p.find('Reasoning effort').props.onChangeCommitted({ type: 'mouseup' }, 2); assert.deepEqual(p.callbacks, []);
  p.find('Reasoning effort').props.onPointerDownCapture(); p.props.selectionKey = 'owner-b'; p.render();
  p.find('Reasoning effort').props.onChange({ type: 'change' }, 0); p.find('Reasoning effort').props.onChangeCommitted({ type: 'change' }, 0);
  assert.deepEqual(p.callbacks, [['effort', 'tiny-id']]);
  p.find('Reasoning effort').props.onChangeCommitted({ type: 'mouseup' }, 2); assert.equal(p.callbacks.length, 1);
});

test('inherited reset uses the real resolver, including a provider Fast default', () => {
  const exports = {}; vm.runInNewContext(transpile(source('conversationEngine.ts')), { exports });
  const engine = { id: 'fixture', models: [{ id: 'provider-default', label: 'Default', efforts: [{ id: 'low', label: 'Low' }], defaultEffort: 'low', serviceTiers: [{ id: 'cli-fast-id', label: 'Fast' }], defaultServiceTier: 'cli-fast-id' }, { id: 'project-model', label: 'Project', efforts: [{ id: 'deep', label: 'Deep' }], defaultEffort: 'deep' }], efforts: [], defaultModel: 'provider-default' };
  const inherited = exports.resolveRuntimeSelection(engine, {}, undefined);
  assert.deepEqual({ ...inherited }, { model: 'provider-default', effort: 'low', speed: 'cli-fast-id' });
  const project = exports.resolveRuntimeSelection(engine, {}, { defaultEngine: 'fixture', defaultModel: 'project-model' });
  assert.deepEqual({ ...project }, { model: 'project-model', effort: 'deep', speed: '' });
});

test('model selection is a separate compact list; Back restores runtime controls without saving', t => {
  const p = picker(); t.after(p.close);
  p.find('Model: Live label').props.onClick();
  for (const label of ['Reasoning effort', 'Engine: Engine', 'Reset to default', 'Engine Fast mode off. Live CLI description']) assert.equal(p.find(label), undefined);
  assert.ok(p.find('model options')); assert.ok(p.find('Back to runtime settings'));
  p.find('Back to runtime settings').props.onClick();
  assert.ok(p.find('Reasoning effort')); assert.ok(p.find('Model: Live label'));
  assert.deepEqual(p.callbacks, []); assert.equal(p.render().find(node => node.type === p.mui.Popper).props.open, true);
});
test('selecting a model returns to the runtime view and saves the exact advertised ID once', t => {
  const p = picker({ models: [{ id: 'live-id', label: 'Live label' }, { id: 'another-exact-id', label: 'Another' }] }); t.after(p.close);
  p.find('Model: Live label').props.onClick();
  p.render().find(node => node.type === p.mui.MenuItem && node.props.selected === false).props.onClick();
  assert.deepEqual(p.callbacks, [['model', 'another-exact-id']]); assert.ok(p.find('Reasoning effort')); assert.equal(p.find('Back to runtime settings'), undefined);
});
test('entering and leaving the model view fences an unfinished drag', t => {
  const p = picker(); t.after(p.close);
  p.find('Reasoning effort').props.onPointerDownCapture(); p.find('Reasoning effort').props.onChange({ type: 'mousemove' }, 2);
  p.find('Model: Live label').props.onClick(); p.find('Back to runtime settings').props.onClick();
  p.find('Reasoning effort').props.onChangeCommitted({ type: 'mouseup' }, 2); assert.deepEqual(p.callbacks, []);
});

test('the model panel focuses its enabled Back action even when every model is unavailable', t => {
  const p = picker({ models: [{ id: 'live-id', label: 'Unavailable pin', disabled: true }] }); t.after(p.close);
  p.find('Model: Unavailable pin').props.onClick();
  const panel = p.render().find(node => node.type === p.mui.Box && typeof node.ref === 'function');
  let focused = 0; panel.ref({ querySelector: () => ({ focus() { focused++; } }) });
  assert.equal(focused, 1); assert.ok(p.find('Back to runtime settings'));
});

// Real TanStack observers/queues and actual view mutation + hydration callbacks.
// Only transport and React scheduling are held so failure order is deterministic.
const { QueryClient, MutationObserver } = require('@tanstack/react-query');
function declaration(name, key) {
  const file = ts.createSourceFile(name, source(name), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let found;
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(file) === key) found = node.getText(file); ts.forEachChild(node, visit); }; visit(file);
  assert.ok(found, key); return found;
}
function moduleExports(name, imports) {
  const exports = {}; vm.runInNewContext(transpile(source(name)), { exports, require: key => { assert.ok(key in imports, key); return imports[key]; } }); return exports;
}
function queueHarness() {
  const client = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
  const keys = moduleExports('queryKeys.ts', { './agentHistoryPagination.js': { AGENT_DETAIL_PAGE_SIZE: 50 } }).queryKeys;
  const controls = moduleExports('hooks/useRuntimeControls.ts', { '@tanstack/react-query': { useIsMutating: filter => client.isMutating(filter) }, '../queryKeys': { queryKeys: keys }, '../conversationEngine': {} });
  const resolver = moduleExports('conversationEngine.ts', {});
  const cache = moduleExports('conversationAgentCache.ts', { './queryKeys.js': { queryKeys: keys } });
  const calls = [], gates = [], promises = [], refs = [], observers = []; let index = 0, refIndex = 0;
  const canonical = new Map();
  const api = Object.fromEntries(['Agent', 'Conversation'].map(kind => ['update' + kind, async (id, patch) => {
    const gate = Promise.withResolvers(); gates.push(gate); calls.push({ id, patch }); await gate.promise;
    const updated = { ...canonical.get(id), ...patch }; canonical.set(id, updated); return updated;
  }]));
  const useMutation = options => {
    const slot = index++; const observer = observers[slot] ??= new MutationObserver(client, options); observer.setOptions(options);
    return { ...observer.getCurrentResult(), mutate(variables) { const result = observer.mutate(variables).catch(error => error); promises.push(result); } };
  };
  const admin = moduleExports('components/useAgentDetailAdministration.ts', {
    react: { useRef(value) { return refs[refIndex++] ??= { current: value }; } },
    '@tanstack/react-query': { useMutation, useQueryClient: () => client }, '../api': { api }, '../queryKeys': { queryKeys: keys },
    '../hooks/useRuntimeControls': controls, '../conversationAgentCache': cache,
    './MutationNotifications': { useMutationNotification: () => () => {} },
  });
  function agent(id) { index = 0; refIndex = 0; return admin.useAgentDetailAdministration({ agentId: id, settingsEngine: 'fixture', settingsModel: 'M0', settingsEffort: 'low', onRuntimeSettingsNotice() {} }).updateRuntimeSettings; }
  function view(name, key, extra) {
    index = 8; const context = vm.createContext({ useMutation, api, queryClient: client, queryKeys: keys, ...cache, ...controls, ...extra });
    vm.runInContext(transpile('const ' + declaration('components/' + name + '.tsx', key) + '; exports.result = ' + key), Object.assign(context, { exports: {} }));
    if (name === 'ConversationView') vm.runInContext(transpile('const ' + declaration('components/ConversationView.tsx', 'saveRuntimeDefaults') + '; exports.save = saveRuntimeDefaults'), context);
    return context.exports;
  }
  function seed(id) { const value = { id, projectId: 'project', activeEngine: 'fixture', model: 'M0', effort: 'low', speed: 'standard', defaultEngine: 'fixture', defaultModel: 'M0', defaultEffort: 'low', defaultSpeed: 'standard' }; canonical.set(id, value); client.setQueryData(keys.agents.detail(id), { agent: value }); client.setQueryData(keys.conversations.detail(id), { conversation: value, agents: [value] }); }
  function hydrate(name, id, state, hydrated) {
    const filename = 'components/' + name + '.tsx', text = source(filename), file = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let callback;
    const marker = name === 'ConversationView' ? 'hydratedRuntimeOwner.current =' : 'hydratedRuntimeAgent.current =';
    const visit = node => { if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' && node.arguments[0]?.getText(file).includes(marker)) callback = node.arguments[0].getText(file); ts.forEachChild(node, visit); }; visit(file); assert.ok(callback);
    const current = name === 'ConversationView' ? client.getQueryData(keys.conversations.detail(id))?.agents.find(agent => agent.id === id) : client.getQueryData(keys.agents.detail(id))?.agent;
    const engine = { id: 'fixture', defaultModel: 'M0', models: ['M0', 'M1', 'M2'].map(id => ({ id, efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low', serviceTiers: [{ id: 'standard' }, { id: 'fast' }], defaultServiceTier: 'standard' })), efforts: [] };
    const env = { queryClient: client, ...controls, ...resolver, agentId: id, selectedAgentId: id, runtimeOwner: 'agent:' + id, runtimeSaving: controls.useRuntimeSaving('agent:' + id), hydratedRuntimeAgent: hydrated, hydratedRuntimeOwner: hydrated, detail: current && { agent: current }, selectedAgent: { data: current && { agent: current } }, commandTargetAgent: current, conversation: { id: 'chat', projectId: 'project' }, engines: [engine], enginesQuery: { data: [engine] }, preferencesQuery: { data: {} }, workspacePreferences: { data: {} }, projectsQuery: { data: [] }, project: undefined, resolveConversationEngine: id => id };
    for (const [setter, key] of [['setEngine','engine'], ['setRuntimeEngine','engine'], ['setRuntimeAgentId','owner'], ['setModel','model'], ['setEffort','effort'], ['setSpeed','speed']]) env[setter] = value => state[key] = value;
    vm.runInNewContext(transpile('(' + callback + ')()'), env);
  }
  return { client, keys, controls, calls, gates, promises, canonical, agent, view, seed, hydrate, close: () => client.clear() };
}
async function until(predicate) { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate()); }
for (const name of ['AgentDetail', 'ConversationView', 'AllChatView']) for (const failures of [[true,true], [false,true], [true,false]]) test(`${name}: rapid queued edits stay optimistic, serialize, and reconcile ${failures}`, async t => {
  const h = queueHarness(); t.after(h.close); h.seed('a');
  const state = {}, hydrated = {}; h.hydrate(name, 'a', state, hydrated);
  let save;
  if (name === 'AgentDetail') save = patch => h.agent('a').mutate(patch);
  else { const key = name === 'ConversationView' ? 'persistTargetRuntime' : 'updateRuntimeEngine'; const result = h.view(name, key, { conversationId: 'chat', runtimeTargetAgentId: 'a', selectedAgentId: 'a' }).result; save = patch => result.mutate({ agentId: 'a', ...patch }); }
  const tuple = model => ({ activeEngine: 'fixture', model, effort: 'high', speed: 'fast' });
  save(tuple('M1')); state.model = 'M1'; save(tuple('M2')); state.model = 'M2';
  await until(() => h.calls.length === 1); assert.equal(h.controls.useRuntimeSaving('agent:a'), true); h.hydrate(name, 'a', state, hydrated); assert.equal(state.model, 'M2');
  failures[0] ? h.gates[0].reject(Error('first rejected')) : h.gates[0].resolve();
  await until(() => h.calls.length === 2); h.hydrate(name, 'a', state, hydrated); assert.equal(state.model, 'M2', 'earlier ack must not replace latest choice'); assert.equal(h.controls.useRuntimeSaving('agent:a'), true, 'Send remains guarded for queued edit');
  failures[1] ? h.gates[1].reject(Error('last rejected')) : h.gates[1].resolve(); await Promise.all(h.promises);
  assert.equal(h.controls.useRuntimeSaving('agent:a'), false); h.hydrate(name, 'a', state, hydrated);
  assert.equal(state.model, failures[1] ? failures[0] ? 'M0' : 'M1' : 'M2');
});
test('queued Agent saves retain their owner across navigation; the new surface inherits the queued tuple', async t => {
  const h = queueHarness(); t.after(h.close); h.seed('a'); h.seed('b');
  const save = h.agent('a'); save.mutate({ activeEngine: 'fixture', model: 'M1', effort: 'high', speed: 'fast' }); save.mutate({ activeEngine: 'fixture', model: 'M2', effort: 'high', speed: 'fast' });
  await until(() => h.calls.length === 1); h.agent('b');
  for (const name of ['AgentDetail', 'ConversationView', 'AllChatView']) {
    const state = { model: 'prior-owner' }; const hydrated = { current: 'b' }; h.hydrate(name, 'a', state, hydrated); assert.equal(state.model, 'M2', name);
  }
  h.gates[0].resolve(); await until(() => h.calls.length === 2); assert.deepEqual(h.calls.map(call => call.id), ['a','a']); h.gates[1].resolve(); await Promise.all(h.promises); assert.equal(h.canonical.get('b').model, 'M0');
});
test('all surfaces share an Agent queue and a second surface can continue a pending choice', async t => {
  const h = queueHarness(); t.after(h.close); h.seed('a');
  h.agent('a').mutate({ activeEngine: 'fixture', model: 'M2', effort: 'high', speed: 'standard' }); await until(() => h.calls.length === 1);
  const state = {}; h.hydrate('AllChatView', 'a', state, {}); assert.equal(state.model, 'M2');
  const all = h.view('AllChatView', 'updateRuntimeEngine', { selectedAgentId: 'a' }).result;
  all.mutate({ agentId: 'a', activeEngine: state.engine, model: state.model, effort: state.effort, speed: 'fast' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.length, 1);
  h.gates[0].reject(Error('first failed')); await until(() => h.calls.length === 2); assert.equal(h.calls[1].patch.model, 'M2'); h.gates[1].resolve(); await Promise.all(h.promises); assert.equal(h.canonical.get('a').model, 'M2'); assert.equal(h.canonical.get('a').speed, 'fast');
});
test('queued Chat effort carries pending explicit model/engine overrides without pinning inherited fields', async t => {
  const h = queueHarness(); t.after(h.close); h.seed('chat');
  const chat = h.view('ConversationView', 'persistDefaults', { conversationId: 'chat' });
  chat.save({ defaultModel: 'M2' }); chat.save({ defaultEffort: 'high' }); await until(() => h.calls.length === 1);
  h.gates[0].reject(Error('model failed')); await until(() => h.calls.length === 2); assert.equal(h.calls[1].patch.defaultModel, 'M2'); assert.ok(!('defaultEngine' in h.calls[1].patch)); h.gates[1].resolve(); await Promise.all(h.promises);
  chat.save({ defaultSpeed: 'fast' }); await until(() => h.calls.length === 3); assert.deepEqual(Object.keys(h.calls[2].patch), ['defaultSpeed']); h.gates[2].resolve(); await Promise.all(h.promises);
});
test('opening a pending Agent before its query loads waits for data, then hydrates the queued engine and defaults', async t => {
  const h = queueHarness(); t.after(h.close); h.seed('a');
  h.agent('a').mutate({ activeEngine: 'fixture', model: 'M2', effort: 'high', speed: 'fast' }); await until(() => h.calls.length === 1);
  const key = h.keys.agents.detail('a'), detail = h.client.getQueryData(key); h.client.removeQueries({ queryKey: key, exact: true });
  const state = { model: 'prior-owner' }, hydrated = {};
  h.hydrate('AgentDetail', 'a', state, hydrated); assert.equal(hydrated.current, undefined); assert.equal(state.model, 'prior-owner');
  h.client.setQueryData(key, detail); h.hydrate('AgentDetail', 'a', state, hydrated); assert.equal(state.model, 'M2'); assert.equal(state.effort, 'high'); assert.equal(state.engine, 'fixture');
  h.gates[0].resolve(); await Promise.all(h.promises);
});
test('pending manual Settings patch preserves an earlier queued speed when a new surface opens', async t => {
  const h = queueHarness(); t.after(h.close); h.seed('a'); const settings = h.agent('a');
  settings.mutate({ activeEngine: 'fixture', model: 'M2', effort: 'high', speed: 'fast' }); settings.mutate(undefined); await until(() => h.calls.length === 1);
  const state = {}; h.hydrate('AllChatView', 'a', state, {}); assert.equal(state.model, 'M0', 'latest manual model wins'); assert.equal(state.speed, 'fast', 'omitted speed preserves pending explicit choice');
  h.gates[0].resolve(); await until(() => h.calls.length === 2); h.gates[1].resolve(); await Promise.all(h.promises);
});
