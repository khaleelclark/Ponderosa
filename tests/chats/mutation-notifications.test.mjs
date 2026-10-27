import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const ts = require('typescript');

// Exercise the shipped provider's queue and Snackbar contract. Elapsed-time
// behavior with real MUI/Chromium is covered by mentionPresentation.test.mjs.
function provider() {
  const cells = []; let cursor = 0;
  const state = initial => {
    const i = cursor++;
    if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
    return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value; }];
  };
  const react = { createContext: () => ({ Provider: 'Provider' }), useState: state,
    useRef: value => state(() => ({ current: value }))[0], useCallback: fn => fn,
    useMemo: fn => fn(), useEffect() {} };
  const exports = {};
  const source = readFileSync(new URL('../../apps/web/src/components/MutationNotifications.tsx', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, require: name => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return require(name);
      if (name === '@mui/material') return Object.fromEntries(['Alert', 'Box', 'Button', 'LinearProgress', 'Snackbar'].map(name => [name, name]));
      if (name === '../downloads') return {};
      throw Error(name);
    },
  });
  const render = () => { cursor = 0; const tree = exports.MutationNotificationProvider({ children: null }); return { notify: tree.props.value, snackbar: tree.props.children[1] }; };
  return { render, notify: input => render().notify(input) };
}

test('ordinary acknowledgments use three seconds, repeat with a fresh identity, and do not reappear on rerender', () => {
  const p = provider();
  for (const message of ['Workflow Saved', 'Settings Saved', 'Copied']) {
    p.notify({ message, key: 'operation' });
    const first = p.render().snackbar;
    assert.equal(first.props.autoHideDuration, 3000);
    assert.equal(first.props.children.props.children[0], message);
    first.props.onClose(null, 'clickaway');
    assert.equal(p.render().snackbar.props.open, true, 'incidental clicks do not dismiss feedback');
    p.notify({ message, key: 'operation' });
    const repeated = p.render().snackbar;
    assert.notEqual(repeated.key, first.key, 'repeat remounts MUI Snackbar to restart its timer');
    assert.equal(p.render().snackbar.key, repeated.key, 'rerender alone does not restart feedback');
    repeated.props.onClose(null, 'timeout');
    assert.equal(p.render().snackbar.props.open, false);
    assert.equal(p.render().snackbar.props.open, false);
  }
});

test('errors and explicitly actionable warnings remain durable; dismissal advances only feedback', () => {
  const p = provider();
  for (const notice of [{ message: 'Save failed', severity: 'error' }, { message: 'Review required', severity: 'warning', persistent: true }]) {
    p.notify(notice); p.notify({ message: 'Copied', key: 'queued-copy' });
    const durable = p.render().snackbar;
    assert.equal(durable.props.autoHideDuration, null);
    durable.props.children.props.onClose();
    assert.equal(p.render().snackbar.props.children.props.children[0], 'Copied');
    p.render().snackbar.props.onClose(null, 'timeout');
    assert.equal(p.render().snackbar.props.open, false);
  }
});

test('active progress retains its presentation identity and cannot be dismissed before settlement', () => {
  const p = provider(), notice = { message: 'Preparing', key: 'download', severity: 'info', persistent: true, progress: { receivedBytes: 1 } };
  p.notify(notice); const first = p.render().snackbar;
  p.notify({ ...notice, progress: { receivedBytes: 2 } });
  const progress = p.render().snackbar;
  assert.equal(progress.key, first.key);
  assert.equal(progress.props.autoHideDuration, null);
  assert.equal(progress.props.children.props.onClose, undefined);
  progress.props.onClose(null, 'escapeKeyDown');
  assert.equal(p.render().snackbar.props.open, true);
  p.notify({ message: 'Download started', key: 'download' });
  assert.notEqual(p.render().snackbar.key, first.key);
  assert.equal(p.render().snackbar.props.autoHideDuration, 3000);
});
