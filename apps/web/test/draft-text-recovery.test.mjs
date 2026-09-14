import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeDraftTextRecovery, readDraftTextRecovery, recoverDraftText, acknowledgeDraftTextRecovery } from '../src/components/chat/draftTextRecovery.js';

beforeEach(() => {
  const entries = new Map();
  globalThis.window = { localStorage: {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  } };
});
const edit = (text = 'Saved\nLatest edit', clientId = 'visit-a') => ({text, clientId, expectedRevision: 4, mentionBindings: []});

test('edit, leave before debounce, return retains text and the original revision', () => {
  writeDraftTextRecovery('chat-a', edit());
  assert.equal(recoverDraftText('chat-b', {revision: 4, text: 'Saved'}), undefined);
  assert.deepEqual(recoverDraftText('chat-a', {revision: 4, text: 'Saved'}), edit());
  acknowledgeDraftTextRecovery('chat-a', 'visit-a', edit(), 5);
  assert.equal(readDraftTextRecovery('chat-a'), undefined);
});

test('acknowledged or subsequently sent draft is not resurrected on return', () => {
  writeDraftTextRecovery('chat-a', edit());
  assert.equal(recoverDraftText('chat-a', {revision: 5, text: edit().text}), undefined);
  writeDraftTextRecovery('chat-a', edit());
  assert.equal(recoverDraftText('chat-a', {revision: 6, text: ''}), undefined);
  assert.equal(readDraftTextRecovery('chat-a'), undefined);
  // A new edit against the already-cleared revision is real work.
  writeDraftTextRecovery('chat-a', {...edit(), expectedRevision: 6});
  assert.equal(recoverDraftText('chat-a', {revision: 6, text: ''}).text, edit().text);
});

test('competing revision does not grant authority to overwrite another edit', () => {
  writeDraftTextRecovery('chat-a', edit());
  const recovered = recoverDraftText('chat-a', {revision: 5, text: 'Another browser edit'});
  assert.equal(recovered.expectedRevision, 4); // Existing server CAS rejects 4 against 5.
  assert.equal(recovered.text, edit().text);
});

test('older save acknowledgements preserve later edits and cannot clear another visit', () => {
  writeDraftTextRecovery('chat-a', edit('Latest local text'));
  acknowledgeDraftTextRecovery('chat-a', 'visit-a', edit('Earlier local text'), 5);
  assert.deepEqual(readDraftTextRecovery('chat-a'), {...edit('Latest local text'), expectedRevision: 5});
  writeDraftTextRecovery('chat-a', edit('Latest local text', 'visit-b'));
  acknowledgeDraftTextRecovery('chat-a', 'visit-a', edit('Latest local text'), 6);
  assert.deepEqual(readDraftTextRecovery('chat-a'), edit('Latest local text', 'visit-b'));
});


test('same visible text with a new mention binding survives an older acknowledgement', () => {
  const binding = {agentId:'agent-1',projectId:'project',handle:'Helper',currentHandle:'Helper',currentTitle:'Helper'};
  const old = {...edit('#Helper hello'), mentionBindings:[binding]};
  const newer = {...old,mentionBindings:[{...binding,agentId:'agent-2'}]};
  writeDraftTextRecovery('chat-a',newer);
  acknowledgeDraftTextRecovery('chat-a','visit-a',old,5);
  assert.deepEqual(readDraftTextRecovery('chat-a'),{...newer,expectedRevision:5});
  assert.deepEqual(recoverDraftText('chat-a',{revision:5,text:old.text,mentionBindings:old.mentionBindings}),{...newer,expectedRevision:5});
});
