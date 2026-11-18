import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isIOSDevice } from '../../apps/web/src/browserPlatform.ts';
import { shouldIgnoreComposerKey, shouldConsumeComposerKey, shouldConsumeComposerQueueKey, shouldSendComposerKey } from '../../apps/web/src/components/chat/composerUtils.ts';
const ts = createRequire(new URL('../../apps/web/package.json', import.meta.url))('typescript');
const source = readFileSync(new URL('../../apps/web/src/components/chat/ComposerEditor.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ComposerEditor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const policy = []; let native, react;
function visit(node) {
  if (ts.isVariableDeclaration(node)) {
    if (['isIOSComposer', 'isMobileComposer'].includes(node.name.getText(ast))) policy.push('const ' + node.getText(ast) + ';');
    if (node.name.getText(ast) === 'handleKeyDown') react = node.initializer.getText(ast);
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'editor.registerCommand' && node.arguments[0]?.getText(ast) === 'KEY_ENTER_COMMAND') native = node.arguments[1].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast); assert.ok(native && react);
function run(device, { narrow = false, shift = false, ctrl = false, meta = false, alt = false, composing = false, internalComposing = false, keyCode = 13, repeat = false, menu = false, disabled = false, locked = false, canSend = true, canQueue = true, queueAvailable = true, suggestionKind = "mention" } = {}) {
  const result = { nativePrevented: 0, reactPrevented: 0, sends: 0, queues: 0, selections: 0, inserts: [], suppressed: 0, stopped: 0 };
  const context = { navigator: device, isIOSDevice: () => isIOSDevice(device), window: { matchMedia: () => ({ matches: narrow }) },
    editor: { isComposing: () => internalComposing }, disabled, locked, canSend, canQueue, menuOpen: menu, menuSuggestions: [suggestionKind === "command" ? {kind:"command",command:{name:"clear",status:"available",invocation:"runtime"}} : { kind: "mention", handle: "Fixture" }], highlighted: 0,
    shouldIgnoreComposerKey, shouldConsumeComposerKey, shouldConsumeComposerQueueKey, shouldSendComposerKey, engineCommandDisabledReason: command => command.status === "unavailable" ? "Unavailable" : undefined,
    bridgeRef: { current: { isComposing: () => internalComposing, insertText: text => result.inserts.push(text) } },
    onQueue: queueAvailable ? () => result.queues++ : undefined, onApplySuggestion: () => result.selections++, onSend: () => result.sends++, onSuppressMenu: () => result.suppressed++,
  };
  const compiled = ts.transpileModule(`(function(){${policy.join('\n')}return {native:${native},react:${react}}})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const handlers = vm.runInNewContext(compiled, context);
  const event = { key: 'Enter', shiftKey: shift, ctrlKey: ctrl, metaKey: meta, altKey: alt, repeat, isComposing: composing, keyCode, preventDefault: () => result.nativePrevented++ };
  result.nativeConsumed = handlers.native(event);
  handlers.react({ ...event, nativeEvent: { isComposing: composing, keyCode },
    preventDefault: () => result.reactPrevented++, stopPropagation: () => result.stopped++ });
  return result;
}
const android = { userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S926B) Chrome/140.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5 };
const ios = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 };
const mac = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 };
for (const [name, device] of [['Android', android], ['iPhone', ios], ['desktop-site iPad', { ...mac, maxTouchPoints: 5 }]]) {
  for (const narrow of [true, false]) for (const shift of [false, true]) test(`${name} ${narrow ? 'narrow' : 'wide'} ${shift ? 'Shift+' : ''}Enter delegates one newline to Lexical and never sends`, () => {
    const r = run(device, { narrow, shift });
    assert.equal(r.nativeConsumed, false); assert.equal(r.nativePrevented, 0);
    assert.equal(r.sends, 0); assert.equal(r.reactPrevented, 0); assert.deepEqual(r.inserts, []);
  });
}
for (const [name, device] of [['Mac', mac], ['Windows touch laptop', { userAgent: 'Windows Chrome', platform: 'Win32', maxTouchPoints: 10 }]]) {
  for (const narrow of [true, false]) test(`${name} ${narrow ? 'narrow' : 'wide'} Enter retains desktop Send`, () => {
    const r = run(device, { narrow }); assert.equal(r.nativeConsumed, true); assert.equal(r.sends, 1);
  });
}
test('desktop Shift+Return and repeated/IME Enter retain their existing ownership', () => {
  assert.deepEqual(run(mac, { shift: true }).inserts, ['\n']);
  assert.deepEqual(run(mac, { shift: true, narrow: true }).inserts, []);
  assert.equal(run(mac, { repeat: true }).sends, 0);
  for (const device of [android, ios, mac]) for (const input of [{ composing: true }, { keyCode: 229 }]) {
    const r = run(device, input); assert.equal(r.sends, 0); assert.equal(r.stopped, 1); assert.equal(r.nativePrevented, 0);
  }
});
test('mobile Enter dismisses suggestions without submitting or selecting them', () => {
  const r = run(android, { menu: true }); assert.equal(r.sends, 0); assert.equal(r.suppressed, 1); assert.equal(r.reactPrevented, 0);
});

for (const [name, device] of [['Mac', mac], ['Android keyboard', android], ['iPhone keyboard', ios], ['iPad keyboard', { ...mac, maxTouchPoints: 5 }]]) {
  for (const menu of [false, "mention", "command"]) test(`${name}: Ctrl+Enter queues exactly once before mobile newline or highlighted suggestion`, () => {
    const r = run(device, { ctrl: true, menu: Boolean(menu), suggestionKind: menu || "mention" });
    assert.equal(r.nativeConsumed, true); assert.equal(r.nativePrevented, 1); assert.equal(r.reactPrevented, 1);
    assert.equal(r.queues, 1); assert.equal(r.sends, 0); assert.equal(r.selections, 0); assert.deepEqual(r.inserts, []);
  });
  for (const state of [{ repeat: true }, { canQueue: false }, { queueAvailable: false }, { disabled: true }, { locked: true }, { meta: true }, { alt: true }]) test(`${name}: Ctrl+Enter retains draft when ${JSON.stringify(state)}`, () => {
    const r = run(device, { ctrl: true, menu: true, ...state });
    assert.equal(r.nativeConsumed, true); assert.equal(r.reactPrevented, 1); assert.equal(r.queues, 0); assert.equal(r.sends, 0); assert.equal(r.selections, 0); assert.deepEqual(r.inserts, []);
  });
  for (const state of [{ composing: true }, { keyCode: 229 }, { internalComposing: true }]) test(`${name}: composing Ctrl+Enter never submits ${JSON.stringify(state)}`, () => {
    const r = run(device, { ctrl: true, ...state });
    assert.equal(r.queues, 0); assert.equal(r.sends, 0); assert.equal(r.selections, 0); assert.equal(r.stopped, 1); assert.equal(r.nativePrevented, 0);
  });
}
test('desktop suggestion Enter still selects; Cmd+Enter is not a queue alias; Ctrl+Shift+Enter retains Shift newline', () => {
  assert.equal(run(mac, { menu: true }).selections, 1);
  const cmd = run(mac, { meta: true }); assert.equal(cmd.queues, 0); assert.equal(cmd.sends, 1);
  assert.deepEqual(run(mac, { ctrl: true, shift: true }).inserts, ['\n']);
  assert.equal(shouldSendComposerKey({ key: 'Enter', ctrlKey: true, shiftKey: false, isComposing: false, repeat: false }), false);
});
