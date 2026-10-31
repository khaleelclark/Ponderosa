import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const ts = createRequire(new URL('../../apps/web/package.json', import.meta.url))('typescript');
const source = readFileSync(new URL('../../apps/web/src/components/ChatContextSettings.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

// Execute the actual component and callbacks; replace only host hooks and UI leaves.
function screen(initial) {
  let value = initial, mutation, sent;
  const jsx = (type, props) => ({ type, props });
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react': { useContext: () => ({}), useState: () => [value, next => { value = next; }] },
    '@mui/material': Object.fromEntries(['Alert','Button','Dialog','DialogActions','DialogContent','DialogTitle','Stack','TextField'].map(name => [name, name])),
    '@tanstack/react-query': { useQueryClient: () => ({}), useMutation: options => { mutation = options; return { isPending: false, mutate: () => options.mutationFn() }; } },
    '../api': { api: { updateConversation: (id, payload) => { sent = { id, payload }; } } },
    '../queryKeys': {}, './ResourceSettingsContext': {}, './ResourceNotificationSettings': { ResourceNotificationSettings: 'Notifications' },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => { assert.ok(name in modules, name); return modules[name]; } });
  function render() {
    const tree = exports.ChatContextSettings({ chat: { id: 'chat', instructions: initial }, open: true, onClose() {} });
    const nodes = [];
    const visit = node => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.forEach(visit); nodes.push(node); visit(node.props?.children); };
    visit(tree);
    return { input: nodes.find(node => node.props?.label === 'Instructions').props, save: nodes.find(node => node.type === 'Button' && node.props.children === 'Save').props };
  }
  return { render, sent: () => sent };
}

test('over-limit instructions explain the disabled Save on the actual field', () => {
  const form = screen('existing');
  form.render().input.onChange({ target: { value: 'x'.repeat(100001) } });
  const { input, save } = form.render();
  assert.equal(save.disabled, true);
  assert.equal(input.error, true);
  assert.equal(input.helperText, 'Use 100,000 characters or fewer.');
});

test('the exact server boundary remains editable and saves the complete value', () => {
  // Server validation uses JS string length, including both UTF-16 units of emoji.
  const value = '😀'.repeat(50000);
  const form = screen(value), { input, save } = form.render();
  assert.equal(Boolean(input.error), false);
  assert.equal(save.disabled, false);
  assert.equal(input.helperText, 'Only this Chat and its Agents.');
  save.onClick();
  assert.equal(form.sent().id, 'chat');
  assert.equal(form.sent().payload.instructions, value);
});

test('correcting an invalid draft clears the error and preserves its submitted text', () => {
  const form = screen('existing');
  form.render().input.onChange({ target: { value: 'x'.repeat(100001) } });
  assert.equal(form.render().save.disabled, true);
  form.render().input.onChange({ target: { value: 'corrected 😀\ncomplete tail' } });
  const { input, save } = form.render();
  assert.equal(Boolean(input.error), false);
  assert.equal(save.disabled, false);
  save.onClick();
  assert.equal(form.sent().payload.instructions, 'corrected 😀\ncomplete tail');
});
