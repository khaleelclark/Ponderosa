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
const { writeDraftTextRecovery, readDraftTextRecovery, observeDraftTextRecovery, discardDraftTextRecovery, hasDraftRecoveryContent, acknowledgeDraftTextRecovery, retireSubmittedDraftText, recoverDraftText } = await import('../../apps/web/src/components/chat/draftTextRecovery.ts');
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
  assert.equal(readDraftTextRecovery(key, 'tab-a'), undefined, 'one retained logical draft, not a per-writer gallery');
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

test('UI018 repeated mounted visits retain one logical recovery record per scope', t=>{
  browser(t);
  for(let visit=0;visit<8;visit++)writeDraftTextRecovery('bounded-chat',draft('Retained text '+visit%2,'visit-'+visit));
  assert.equal(readDraftTextRecovery('bounded-chat').text,'Retained text 1');
  assert.equal([...window.localStorage.values.keys()].filter(key=>key.startsWith('bounded-chat.pending-text.')).length,1);
});
test('UI018 an empty new visit does not replace authored recovery text',t=>{
  browser(t);writeDraftTextRecovery('seed-chat',draft('Unsent authored text','authored'));
  writeDraftTextRecovery('seed-chat',draft('','new-visit'));
  assert.equal(readDraftTextRecovery('seed-chat').text,'Unsent authored text');
});

const binding={agentId:'agent-boston',projectId:'project-a',handle:'Boston',currentHandle:'Boston',currentTitle:'Boston'};
const authored=(key,value,fence)=>{observeDraftTextRecovery(key,fence);return writeDraftTextRecovery(key,value,fence);};
test('UI018 acknowledgement preserves newer own text/files and its exact edit identity',t=>{
  browser(t);const fence={};authored('own-edit',draft('Before'),fence);const saved=readDraftTextRecovery('own-edit');
  authored('own-edit',draft('After','tab-a',{attachmentIds:['new-file'],mentionBindings:[binding]}),fence);const newer=readDraftTextRecovery('own-edit');
  acknowledgeDraftTextRecovery('own-edit','tab-a',saved,2);const pending=readDraftTextRecovery('own-edit');
  assert.equal(pending.text,'After');assert.deepEqual(pending.attachmentIds,['new-file']);assert.deepEqual(pending.mentionBindings,[binding]);assert.equal(pending.captureId,newer.captureId);assert.equal(pending.expectedRevision,2);
});
test('UI018 a default mention is not a backup and cannot replace authored text',t=>{
  browser(t);const seed=draft('#Boston ','new-visit',{mentionBindings:[binding]});
  assert.equal(hasDraftRecoveryContent(seed),false);writeDraftTextRecovery('only-seed',seed);assert.equal(readDraftTextRecovery('only-seed'),undefined);
  writeDraftTextRecovery('seed-retains-authored',draft('Actual body'));writeDraftTextRecovery('seed-retains-authored',seed);assert.equal(readDraftTextRecovery('seed-retains-authored').text,'Actual body');
  assert.equal(hasDraftRecoveryContent(draft('#unknown')),true,'An unknown literal tag is authored text');
});
test('UI018 explicit clear invalidates stale background saves and cannot resurrect on return',t=>{
  browser(t);const old={},clear={};authored('deliberate-clear',draft('Unsent'),old);window.localStorage.setItem('deliberate-clear','Unsent');writeDraftTextRecovery('untouched-chat',draft('Other Chat'));
  observeDraftTextRecovery('deliberate-clear',clear);discardDraftTextRecovery('deliberate-clear','tab-b',1,clear);
  assert.equal(readDraftTextRecovery('deliberate-clear'),undefined);assert.equal(window.localStorage.getItem('deliberate-clear'),null);
  assert.equal(writeDraftTextRecovery('deliberate-clear',draft('Unsent'),old),false);
  assert.equal(recoverDraftText('deliberate-clear',{revision:1,text:'Unsent'}).text,'');
  assert.equal(recoverDraftText('deliberate-clear',{revision:2,text:''}).text,'');
  assert.equal(recoverDraftText('deliberate-clear',{revision:3,text:'Unobserved late save'}).text,'','Keep the explicit clear pending under its original CAS, rather than resurrect late text');
  assert.equal(readDraftTextRecovery('untouched-chat').text,'Other Chat');
});
test('UI018 a late send acknowledgement cannot retire identical newly authored text',t=>{
  browser(t);const fence={};authored('identical-after-send',draft('Same text'),fence);const sent=readDraftTextRecovery('identical-after-send');
  retireSubmittedDraftText('identical-after-send','tab-a',sent,2);authored('identical-after-send',draft('Same text'),fence);const next=readDraftTextRecovery('identical-after-send');
  assert.notEqual(sent.captureId,next.captureId);acknowledgeDraftTextRecovery('identical-after-send','tab-a',sent,3);retireSubmittedDraftText('identical-after-send','tab-a',sent,3);
  assert.equal(readDraftTextRecovery('identical-after-send').captureId,next.captureId);
});
test('UI018 stale-tab effect writes cannot replace a different tab’s newer edit',t=>{
  browser(t);const a={},b={};authored('cross-tab-fence',draft('A'),a);const saved=readDraftTextRecovery('cross-tab-fence');authored('cross-tab-fence',draft('B','tab-b'),b);
  assert.equal(writeDraftTextRecovery('cross-tab-fence',draft('A'),a),false);acknowledgeDraftTextRecovery('cross-tab-fence','tab-a',saved,2);assert.equal(readDraftTextRecovery('cross-tab-fence').text,'B');
  authored('cross-tab-fence',draft('A intentional new typing'),a);assert.equal(readDraftTextRecovery('cross-tab-fence').text,'A intentional new typing');
});
function legacy(key,text,id,revision=1){window.localStorage.setItem(key+'.pending-text.v2.'+id,JSON.stringify(draft(text,id,{expectedRevision:revision})));}
test('UI018 legacy collapse prefers visible authored content without inventing storage recency',t=>{
  browser(t);for(let i=0;i<8;i++)legacy('legacy-collapse',i%2?'Second':'Visible','visit-'+i);legacy('foreign-scope','Do not remove','other');window.localStorage.setItem('legacy-collapse','Visible');window.sessionStorage.setItem('legacy-collapse.pending-writer.v2','visit-7');
  assert.equal(readDraftTextRecovery('legacy-collapse').text,'Visible');assert.equal([...window.localStorage.values.keys()].filter(k=>k.startsWith('legacy-collapse.pending-text.')).length,1);assert.ok(window.localStorage.getItem('foreign-scope.pending-text.v2.other'));
});
test('UI018 failed storage migration preserves legacy evidence; successful retry prunes only that scope',t=>{
  browser(t);legacy('full-storage','Keep me','old');legacy('different-full-scope','Other','other');const original=window.localStorage.setItem.bind(window.localStorage);window.localStorage.setItem=(key,value)=>{if(key.endsWith('.v3'))throw Error('QuotaExceeded');original(key,value);};
  assert.equal(readDraftTextRecovery('full-storage').text,'Keep me');assert.ok(window.localStorage.getItem('full-storage.pending-text.v2.old'));
  window.localStorage.setItem=original;writeDraftTextRecovery('full-storage',draft('Current authored content'));assert.equal(readDraftTextRecovery('full-storage').text,'Current authored content');assert.equal(window.localStorage.getItem('full-storage.pending-text.v2.old'),null);assert.ok(window.localStorage.getItem('different-full-scope.pending-text.v2.other'));
});
test('UI018 unavailable browser storage keeps one in-memory recovery without throwing',t=>{
  browser(t);Object.defineProperty(window,'localStorage',{get(){throw Error('Denied');}});
  assert.doesNotThrow(()=>writeDraftTextRecovery('denied-storage',draft('Retained in this page')));assert.equal(readDraftTextRecovery('denied-storage').text,'Retained in this page');
});
test('UI018 uncertain-save recovery preserves mention identity and extracted paste bytes/references',t=>{
  browser(t);const body='#Boston ',paste='Complete extracted paste',record=draft(body,'tab-a',{mentionBindings:[binding],pastedText:paste,pastedTextAttachmentId:'paste-id'});
  writeDraftTextRecovery('paste-recovery',record);const pending=recoverDraftText('paste-recovery',{revision:20,text:''});assert.equal(pending.pastedText,paste);assert.equal(pending.pastedTextAttachmentId,'paste-id');assert.deepEqual(pending.mentionBindings,[binding]);assert.equal(pending.expectedRevision,1);
  assert.equal(recoverDraftText('paste-recovery',{revision:21,text:body,mentionBindings:[binding],attachmentIds:[],pastedTextAttachmentId:'paste-id'}),undefined);
});
