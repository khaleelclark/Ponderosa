import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const ts = createRequire(new URL('../../apps/web/package.json', import.meta.url))('typescript');
const source = readFileSync(new URL('../../apps/web/src/components/ChatDeletionDialog.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function render(conversation) {
  let query, deleted, closed = false;
  const jsx = (type, props) => ({ type, props });
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@mui/material': Object.fromEntries(['Alert','Box','Button','CircularProgress','Dialog','DialogActions','DialogContent','DialogTitle','Stack','Typography'].map(name => [name, name])),
    '@tanstack/react-query': { useQuery: options => { query = options; return { data: [{id:'b',title:'Beta'},{id:'a',title:'Alpha'}], isFetching: false, isError: false }; } },
    '../api': { api: {} },
    './ConfirmationDialogs': { ResourceDeletionDialog: 'ResourceDeletionDialog' },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => { assert.ok(name in modules, name); return modules[name]; } });
  const tree = exports.ChatDeletionDialog({ open: true, conversation, pending: false, onClose() { closed = true; }, onDelete(ids) { deleted = ids; } });
  const nodes = [];
  function visit(node) { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.forEach(visit); nodes.push(node); visit(node.props?.children); }
  visit(tree);
  return {tree, nodes, query, deleted: () => deleted, closed: () => closed};
}

test('workflow-owned Chat offers its owning settings, never an independent deletion', () => {
  const view = render({id:'chat',title:'Owned',branchId:'branch /?&'});
  assert.equal(view.query.enabled, false);
  assert.equal(view.nodes.some(n => n.type === 'ResourceDeletionDialog'), false);
  const link = view.nodes.find(n => n.type === 'Button' && n.props.children === 'Open workflow settings');
  assert.equal(link.props.href, '/branches?branch=branch%20%2F%3F%26&tab=settings');
  assert.match(view.nodes.find(n => n.type === 'Typography').props.children, /entire workflow, including its other Chats and Agents/);
  view.nodes.find(n => n.type === 'Button' && n.props.children === 'Cancel').props.onClick();
  assert.equal(view.closed(), true);
  assert.equal(view.deleted(), undefined);
});

test('ordinary Core Chat retains checked-member deletion', () => {
  const view = render({id:'core',title:'Ordinary'});
  assert.equal(view.query.enabled, true);
  assert.equal(view.tree.type, 'ResourceDeletionDialog');
  assert.equal(view.tree.props.confirmDisabled, false);
  view.tree.props.onConfirm();
  assert.deepEqual(Array.from(view.deleted()), ['a','b']);
});
