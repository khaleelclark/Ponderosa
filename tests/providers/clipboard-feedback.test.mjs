import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const ts = require('typescript'), React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { QueryClient, MutationObserver } = require('@tanstack/react-query');
const widget = name => Object.assign(() => null, { displayName: name });
const mui = new Proxy({}, { get: (target, name) => target[name] ??= widget(name) });
function load(relative, imports, globals) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/' + relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, ...globals, require: name => {
    if (name in imports) return imports[name];
    if (name === '@mui/material') return mui;
    if (name.startsWith('@mui/icons-material/')) return { __esModule: true, default: widget('Icon') };
    if (['react', 'react/jsx-runtime', 'react-dom'].includes(name)) return require(name);
    throw Error('Unexpected import: ' + name);
  } }, { filename: relative });
  return exports;
}
function* walk(node) {
  if (!React.isValidElement(node)) return;
  yield node;
  for (const child of React.Children.toArray(node.props.children)) yield* walk(child);
}
function render(fn) {
  let tree;
  function Probe() { tree = fn(); return null; }
  renderToStaticMarkup(React.createElement(Probe));
  return [...walk(tree)];
}
function setup({ clipboard, command = () => true, select = () => {} } = {}) {
  const writes = [], nodes = new Set(), notices = [];
  const document = {
    createElement: () => ({ style: {}, select, remove() { nodes.delete(this); } }),
    body: { appendChild(node) { nodes.add(node); writes.push(node.value); } },
    execCommand: command,
  };
  const globals = { navigator: { clipboard }, document };
  const helper = load('clipboard.ts', {}, globals);
  const client = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
  let observer;
  const usage = load('components/ProviderUsageCenter.tsx', {
    '../clipboard': helper, '../api': {}, '../providerUsageQuery': {}, '../queryKeys': {}, './providerUsagePresentation': {},
    '@tanstack/react-query': { useMutation(options) {
      observer ??= new MutationObserver(client, options);
      observer.setOptions(options);
      return { ...observer.getCurrentResult(), mutate: value => { void observer.mutate(value).catch(() => {}); } };
    } },
  }, globals);
  const path = load('components/HostPathPresentation.tsx', {
    '../clipboard': helper, './MutationNotifications': { useMutationNotification: () => notice => notices.push(notice) },
  }, globals);
  const state = { provider: 'fixture', displayName: 'Fixture', status: 'unavailable', authenticated: true,
    failure: { code: 'invalid_provider_response', message: 'private provider stderr', correlationId: 'owned', occurredAt: '2026-10-19T00:00:00Z',
      runtimeVersion: 'fixture-1', raw: 'secret', accessToken: 'secret' } };
  const card = () => render(() => usage.ProviderUsageCard({ state }));
  const button = () => card().find(node => node.props.children === 'Copy Support Report');
  const copyReport = async () => {
    button().props.onClick();
    for (let i = 0; i < 100 && observer.getCurrentResult().isPending; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(observer.getCurrentResult().isPending, false);
  };
  const alerts = () => card().filter(node => node.type === mui.Alert).map(node => ({ severity: node.props.severity, text: node.props.children }));
  return { helper, writes, nodes, notices, state, button, copyReport, alerts,
    copyPath: () => render(() => path.HostPathPresentation({ path: '/owned/café%20.txt' })).find(node => node.props['aria-label'] === 'Copy host path').props.onClick(),
    close: () => client.clear() };
}
for (const mode of ['modern', 'missing', 'denied']) test(`support report: ${mode} clipboard copies sanitized report with settled success feedback`, async t => {
  const captured = [];
  const f = setup({ clipboard: mode === 'missing' ? undefined : { writeText: async text => {
    if (mode === 'denied') throw Error('Permission denied');
    captured.push(text);
  } } });
  t.after(f.close);
  await f.copyReport();
  const report = JSON.parse((mode === 'modern' ? captured : f.writes)[0]);
  assert.deepEqual(report, { provider: 'fixture', status: 'unavailable', failure: {
    code: 'invalid_provider_response', correlationId: 'owned', occurredAt: '2026-10-19T00:00:00Z', runtimeVersion: 'fixture-1',
  } });
  assert.ok(f.alerts().some(item => item.severity === 'success' && item.text === 'Support report copied.'));
  assert.equal(f.nodes.size, 0);
});
test('support report: denied fallback is handled, retry succeeds, changed report does not retain prior success', async t => {
  let allowed = false;
  const f = setup({ clipboard: { writeText: async () => { throw Error('Denied'); } }, command: () => allowed });
  t.after(f.close);
  await f.copyReport();
  assert.ok(f.alerts().some(item => item.severity === 'error' && /could not be copied/.test(item.text)));
  assert.ok(!f.alerts().some(item => item.severity === 'success'));
  allowed = true;
  await f.copyReport();
  assert.ok(f.alerts().some(item => item.severity === 'success'));
  assert.ok(!f.alerts().some(item => item.severity === 'error'));
  f.state.failure.correlationId = 'next-report';
  assert.ok(!f.alerts().some(item => item.severity === 'success'));
  assert.equal(f.nodes.size, 0);
});
test('support report: pending write disables repeat and only confirms after completion', async t => {
  let settle;
  const f = setup({ clipboard: { writeText: () => new Promise(resolve => { settle = resolve; }) } });
  t.after(f.close);
  const pending = f.copyReport();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.button().props.disabled, true);
  assert.ok(!f.alerts().some(item => item.severity === 'success'));
  settle(); await pending;
  assert.equal(f.button().props.disabled, false);
});
test('support report: completion of a previous report cannot confirm the current report', async t => {
  let settle;
  const f = setup({ clipboard: { writeText: () => new Promise(resolve => { settle = resolve; }) } });
  t.after(f.close);
  const pending = f.copyReport();
  await new Promise(resolve => setImmediate(resolve));
  f.state.failure.correlationId = 'new-report-while-copying';
  f.button();
  settle(); await pending;
  assert.ok(!f.alerts().some(item => item.severity === 'success' || item.severity === 'error'));
});
for (const stage of ['select', 'command']) test(`clipboard fallback removes its private textarea when ${stage} throws`, async t => {
  const f = setup({ [stage]: () => { throw Error('Owned browser failure'); } });
  t.after(f.close);
  await assert.rejects(f.helper.copyText('private diagnostic'), /Owned browser failure/);
  assert.equal(f.nodes.size, 0);
});
test('host path uses fallback for missing API and reports denial without a thrown callback', async t => {
  let allowed = true;
  const f = setup({ command: () => allowed });
  t.after(f.close);
  f.copyPath(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes[0], '/owned/café%20.txt');
  assert.equal(f.notices[0].message, 'Host path copied.');
  allowed = false;
  f.copyPath(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.notices[1].severity, 'error');
  assert.equal(f.nodes.size, 0);
});
