import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeDraftTextRecovery, readDraftTextRecovery, recoverDraftText, acknowledgeDraftTextRecovery, retireSubmittedDraftText } from '../src/components/chat/draftTextRecovery.js';
import { readChatState, writeChatState } from '../src/chatState.js';

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

test('matching canonical and acknowledged sent drafts are not resurrected on return', () => {
  writeDraftTextRecovery('chat-a', edit());
  assert.equal(recoverDraftText('chat-a', {revision: 5, text: edit().text}), undefined);
  writeDraftTextRecovery('chat-a', edit());
  // Send persistence acknowledges the exact text/bindings before clearing it.
  acknowledgeDraftTextRecovery('chat-a', 'visit-a', edit(), 5);
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


test('new typing after an accepted empty PUT survives reload before its acknowledgement', () => {
  writeDraftTextRecovery('chat-a', edit(''));
  // Server accepts this earlier empty write as revision 5; the response is held.
  writeDraftTextRecovery('chat-a', edit('New work typed after clearing'));
  const canonical = {revision:5,text:'',mentionBindings:[]};
  assert.deepEqual(recoverDraftText('chat-a', canonical), edit('New work typed after clearing'));
  assert.deepEqual(readDraftTextRecovery('chat-a'), edit('New work typed after clearing'));
  // If the old response arrives before leaving, it advances only the base;
  // it must still preserve the text entered after the clear.
  acknowledgeDraftTextRecovery('chat-a','visit-a',edit(''),5);
  assert.deepEqual(recoverDraftText('chat-a', canonical), {...edit('New work typed after clearing'),expectedRevision:5});
});

test('confirmed submission retires matching text after leaving without erasing later or other-visit edits', () => {
  writeChatState('chat-a', edit().text);
  writeDraftTextRecovery('chat-a', edit());
  retireSubmittedDraftText('chat-a', 'visit-a', edit(), 5);
  assert.equal(readChatState('chat-a'), undefined);
  assert.equal(readDraftTextRecovery('chat-a'), undefined);
  for (const next of [edit('New unsent work'), edit(edit().text, 'visit-b')]) {
    writeChatState('chat-a', next.text);
    writeDraftTextRecovery('chat-a', next);
    retireSubmittedDraftText('chat-a', 'visit-a', edit(), 6);
    assert.equal(readChatState('chat-a'), next.text);
    assert.equal(readDraftTextRecovery('chat-a').text, next.text);
    assert.equal(readDraftTextRecovery('chat-a').clientId, next.clientId);
  }
  writeChatState('chat-b', 'Other Chat work');
  retireSubmittedDraftText('chat-a', 'visit-a', edit(), 7);
  assert.equal(readChatState('chat-b'), 'Other Chat work');
});
