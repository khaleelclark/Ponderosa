import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const {createEditor,$getRoot,$createParagraphNode,$createTextNode,$createLineBreakNode}=require('lexical');
const source=readFileSync(new URL('../../apps/web/src/components/chat/ComposerEditor.tsx',import.meta.url),'utf8');
const getterSource=source.match(/getCanonicalText: (.*),\n/)[1];
test('actual composer getter sees queued input before continuation hydration can treat it as empty',()=>{
 const editor=createEditor({namespace:'pending-read',onError:error=>{throw error;}}),canonicalRef={current:''};
 const get=vm.runInNewContext('('+getterSource+')',{editor,canonicalRef,$canonicalText:()=>$getRoot().getTextContent()});
 const expected='#Willow authored λ😀\nsecond line\n\nTAIL_KEEP_ME  ';
 editor.update(()=>{$getRoot().append($createParagraphNode().append($createTextNode('#Willow authored λ😀'),$createLineBreakNode(),$createTextNode('second line'),$createLineBreakNode(),$createLineBreakNode(),$createTextNode('TAIL_KEEP_ME  ')));});
 assert.equal(canonicalRef.current,'','React/update-listener cache has not received this queued input');
 assert.equal(get(),expected,'Pending input is authoritative for empty-draft checks; authored prefix/blank lines/trailing spaces survive');
});

// The other race window is truly empty: Delete has committed, Paste is next.
// Existing routing should still seed only before the user starts that draft.
const {composerShouldSeedContinuationDestination}=await import('../../apps/web/src/components/chat/composerUtils.ts');
test('continuation hydration respects interaction with the cleared next draft',()=>{
 const empty={nextSelectionKey:'reply:new',localText:'',editorText:''};
 assert.equal(composerShouldSeedContinuationDestination(empty),true);
 assert.equal(composerShouldSeedContinuationDestination({...empty,interactionStarted:true}),false);
 assert.equal(composerShouldSeedContinuationDestination({...empty,editorText:'author λ😀'}),false);
 assert.equal(composerShouldSeedContinuationDestination({...empty,retainedSelectionKey:'chosen:agent'}),false);
 assert.equal(composerShouldSeedContinuationDestination({...empty,previousSelectionKey:'reply:new'}),false);
});
