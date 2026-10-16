import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve only this source tree's TS-backed .js imports for Node's native TS stripping.
const source = new URL('../../apps/web/src/', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(source) && specifier.endsWith('.js') && specifier.startsWith('.')) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
  }
  return next(specifier, context);
} });
const { writeDraftTextRecovery, readDraftTextRecovery, acknowledgeDraftTextRecovery, retireSubmittedDraftText, recoverDraftText } = await import('../../apps/web/src/components/chat/draftTextRecovery.ts');
hook.deregister();

class Storage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
function browser(t) {
  const original = globalThis.window;
  globalThis.window = { localStorage: new Storage(), sessionStorage: new Storage() };
  t.after(() => { if (original === undefined) delete globalThis.window; else globalThis.window = original; });
}
const draft = (text, clientId = 'tab-a', extra = {}) => ({ text, clientId, expectedRevision: 1, mentionBindings: [], ...extra });

test('check 2: delayed acknowledgement preserves newer typing, attachments and another tab', t => {
  browser(t); const key = 'draft-chat-a';
  const saved = draft('Earlier text');
  writeDraftTextRecovery(key, saved);
  writeDraftTextRecovery(key, draft('Newer text', 'tab-a', { attachmentIds: ['new-file'] }));
  writeDraftTextRecovery(key, draft('Other tab text', 'tab-b'));
  acknowledgeDraftTextRecovery(key, 'tab-a', saved, 2);
  assert.equal(readDraftTextRecovery(key, 'tab-a').text, 'Newer text');
  assert.deepEqual(readDraftTextRecovery(key, 'tab-a').attachmentIds, ['new-file']);
  assert.equal(readDraftTextRecovery(key, 'tab-b').text, 'Other tab text');
});
test('checks 14, 15: confirmed send retires only its exact recovery edit and leaves another Chat intact', t => {
  browser(t); const saved = draft('Submitted text');
  writeDraftTextRecovery('chat-a', saved); writeDraftTextRecovery('chat-b', draft('Unsent elsewhere'));
  retireSubmittedDraftText('chat-a', 'tab-a', saved, 2);
  assert.equal(readDraftTextRecovery('chat-a', 'tab-a'), undefined);
  assert.equal(readDraftTextRecovery('chat-b', 'tab-a').text, 'Unsent elsewhere');
});
test('check 14: a newer empty server draft does not prove ambiguous local text was saved', t => {
  browser(t); writeDraftTextRecovery('chat', draft('Unacknowledged text', 'tab-a', { attachmentIds: ['file'] }));
  const recovered = recoverDraftText('chat', { revision: 20, text: '', attachmentIds: [] });
  assert.equal(recovered.text, 'Unacknowledged text'); assert.deepEqual(recovered.attachmentIds, ['file']);
});
