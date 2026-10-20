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
test('pending save keeps picker open while controls are disabled', t => {
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

test('reset owners resolve without overrides, save one complete tuple, reuse rollback and skip unchanged saves', () => {
  for (const name of ['ConversationView.tsx', 'AgentDetail.tsx', 'AllChatView.tsx']) {
    const text = source('components/' + name);
    const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let declaration;
    function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'resetOrChangeEngine') declaration = node; ts.forEachChild(node, visit); }
    visit(file); assert.ok(declaration, name);
    const saved = [], engine = { id: 'fixture' }, resolved = { model: 'inherited-model', effort: 'inherited-effort', speed: 'inherited-fast' };
    const globals = { engines: [engine], model: 'other', effort: 'other', speed: 'other', engine: name === 'ConversationView.tsx' ? 'fixture' : engine, selectedEngineId: 'fixture', runtimeEngine: 'fixture', agentId: 'agent', selectedAgentId: 'agent', selectedAgent: { data: { agent: {} } }, detail: { agent: {} }, preferencesQuery: {}, workspacePreferences: {}, project: {}, conversationId: 'chat', commandTargetAgent: null, settingsEngine: '', settingsModel: '', settingsEffort: '', captureRuntimeMutation: () => ({}), rememberOptimisticRuntime() {}, runtimeMutationGenerationByAgent: { current: new Map() }, runtimeCanonicalKeyByAgent: { current: new Map() }, runtimeCanonicalKey: () => 'key', chatStateKey: () => 'speed', readChatState: () => '', writeChatState() {}, dirtyRuntimeAgentId: {}, resolveRuntimeSelection(...args) { assert.equal(args.length, 3, name + ': no explicit override'); return resolved; } };
    for (const setter of ['setSubmissionRuntimeIntent', 'setEngine', 'setRuntimeEngine', 'setModel', 'setEffort', 'setSpeed', 'setSettingsEngine', 'setSettingsModel', 'setSettingsEffort']) globals[setter] = () => {};
    for (const owner of ['persistDefaults', 'persistTargetRuntime', 'updateRuntimeSettings', 'updateRuntimeEngine']) globals[owner] = { mutate: (tuple, callbacks) => saved.push({ tuple, callbacks }) };
    const context = vm.createContext(globals); vm.runInContext(transpile('const ' + declaration.getText(file) + '; resetOrChangeEngine("fixture");'), context);
    assert.equal(saved.length, 1, name);
    assert.equal(typeof saved[0].callbacks.onError, 'function', name + ': existing rollback');
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
    '../api': {}, '../conversationAgentCache': {},
    '../queryKeys': { queryKeys: { agents: { detailPrefix: () => [], all: [] }, conversations: { detailAll: [] } } },
    './MutationNotifications': { useMutationNotification: () => notice => notices.push(notice) },
  };
  vm.runInNewContext(transpile(source('components/useAgentDetailAdministration.ts')), { exports, require: name => imports[name] });
  exports.useAgentDetailAdministration({ agentId: 'a', onRuntimeSettingsNotice: value => inline.push(value) });
  const runtime = mutations.at(-1), updated = { id: 'a' }, context = { agentId: 'a' };
  runtime.onSuccess(updated, { activeEngine: 'codex' }, context);
  assert.deepEqual(notices, []); assert.deepEqual(inline, [undefined]);
  runtime.onSuccess(updated, undefined, context);
  assert.equal(notices.length, 1); assert.match(inline.at(-1), /^Saved/);
  runtime.onError(Error('save failed'), {}, context); assert.equal(inline.at(-1), undefined);
});
