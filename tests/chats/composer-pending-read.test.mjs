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

// A hydration begun before Send must not become a new editable draft.
const sendTS=require('typescript');
const sendSource=readFileSync(new URL('../../apps/web/src/components/chat/Composer.tsx',import.meta.url),'utf8');
const sendAst=sendTS.createSourceFile('Composer.tsx',sendSource,sendTS.ScriptTarget.Latest,true,sendTS.ScriptKind.TSX);
let hydrate,success,failure,invalidateHydration,replaceDraftText;
function visit(node){
 if(sendTS.isVariableDeclaration(node)&&sendTS.isCallExpression(node.initializer??node)){
  if(node.name.getText(sendAst)==='invalidateDraftHydration')invalidateHydration=node.initializer.arguments[0];
  if(node.name.getText(sendAst)==='replaceText')replaceDraftText=node.initializer.arguments[0];
 }
 if(sendTS.isVariableDeclaration(node)&&node.name.getText(sendAst)==='apply'&&node.initializer&&node.initializer.getText(sendAst).includes('const restoredResults = await Promise.allSettled'))hydrate=node.initializer;
 if(sendTS.isCallExpression(node)&&sendTS.isPropertyAccessExpression(node.expression)){
  const fn=node.arguments[0];
  if(fn&&sendTS.isArrowFunction(fn)&&fn.body.getText(sendAst).includes('const submissionMayClearDraft = composerSubmissionMayClearDraft'))success=fn;
  if(node.expression.name.text==='catch'&&fn&&sendTS.isArrowFunction(fn)&&fn.body.getText(sendAst).includes('const intentUnchanged ='))failure=fn;
 }
 sendTS.forEachChild(node,visit);
}
visit(sendAst);assert(hydrate&&success&&failure&&invalidateHydration&&replaceDraftText,'Actual Composer hydration, mutation and Send callbacks must be found');
const hydrationEnd=hydrate.body.statements.findIndex(n=>n.getText(sendAst)==='draftContentGeneration.current += 1;');assert(hydrationEnd>0);
// Execute the real asynchronous hydration through its first content mutation.
// Remaining rendering is irrelevant: this mutation alone invalidates Send's guard.
const hydration=`async()=>{${hydrate.body.statements.slice(0,hydrationEnd+1).map(n=>n.getText(sendAst)).join('\n')}}`;
const admittedStart=sendSource.indexOf('    sendingRef.current = true;');
const admittedEnd=sendSource.indexOf('    const outgoingId =',admittedStart);assert(admittedStart>0&&admittedEnd>admittedStart);
const admission=sendSource.slice(admittedStart,admittedEnd);
const helperSource=readFileSync(new URL('../../apps/web/src/components/chat/composerUtils.ts',import.meta.url),'utf8');
const helperAst=sendTS.createSourceFile('composerUtils.ts',helperSource,sendTS.ScriptTarget.Latest,true,sendTS.ScriptKind.TS);
const helperNames=['shouldAdoptHydratedDraft','ownedDraftRevisionAfterObservation','composerSubmissionMayClearDraft','draftWriteContinuationStillOwned'];
const helpers=helperAst.statements.filter(n=>sendTS.isFunctionDeclaration(n)&&helperNames.includes(n.name?.text)).map(n=>n.getText(helperAst).replace(/^export /,''));assert.equal(helpers.length,4);
const compile=s=>sendTS.transpileModule(s,{compilerOptions:{target:sendTS.ScriptTarget.ES2022,module:sendTS.ModuleKind.None}}).outputText;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function sendHydrationFixture(){
 const download=deferred(),state={files:['sent.webm'],text:'',stored:['sent'],error:undefined,clears:0};
 const chain={ownedRevision:1,clientId:'owned-client',pendingDeletionIds:new Set(),tail:Promise.resolve()};
 const c={Error,Set,Map,Promise,console,cancelled:false,hydrationGeneration:7,draftHydrationGeneration:{current:7},draftRevision:{current:1},draft:{revision:2,attachmentIds:['sent'],attachments:[{id:'sent'}]},
  api:{downloadDraftAttachment:()=>download.promise,putConversationDraft:async(_scope,body)=>{state.stored=[...body.attachmentIds];return{revision:3};},deleteDraftAttachment:async()=>{}},
  locallyRemovedDraftAttachmentIds:{current:new Set()},pendingText:undefined,draftStorageKey:undefined,inputRef:{current:{isFocused:()=>false}},draftLocallyEdited:{current:true},draftWriteChain:{current:chain},
  draftContentGeneration:{current:3},sendingRef:{current:false},setSending(){},textRef:{current:''},setTextState:s=>state.text=s,
  submittedScopeStillActive:()=>true,setPreparedRetry(){},submittedContentGeneration:3,submittedDraftWriteChain:chain,runtimeCommandSubmission:false,submittedDraftScope:'owned-chat',submittedRecovery:undefined,
  submittedText:'',submittedMentionBindings:[],submittedOwnedDraftRevision:1,retireSubmittedDraftText(){},continuationSeedIntent:{current:undefined},selectionIntent:{current:undefined},draftGeneration:{current:1},draftEditVersion:{current:0},draftAttachmentsLocallyEdited:{current:true},unrestoredDraftAttachmentIds:{current:['sent']},
  setKnownMentionBindings(){},retainedAgentDestination:undefined,setActiveDefaultDestination(){},replacePastedText(){},clearDraftAttachments(){state.files=[];state.clears++;c.invalidateDraftHydration();},
  activeDraftScopeRef:{current:'owned-chat'},draftOwnerId:'owned-agent',withCapturedDraftSubmissions:(_scope,body)=>body,queryClient:{getQueryData(){},setQueryData(){}},queryKeys:{conversationDraft:{detail:()=>[]}},pendingSubmissionRef:{current:undefined},stagedIds:['sent'],submittedSupersededPastedTextAttachmentIds:[],submittedPastedTextAttachmentId:undefined,pastedTextAttachmentId:{current:undefined},setCaret(){},
  ApiRequestError:class extends Error{},userDraftMutationGeneration:{current:0},submittedUserMutationGeneration:0,activeSubmissionIntentKeyRef:{current:'send'},submissionIntentKey:'send',action:'send',setSendError:e=>state.error=e,submittedPastedText:undefined,
 };
 vm.createContext(c);vm.runInContext(compile(helpers.join('\n')),c);
 const run=s=>vm.runInContext(compile(s),c);
 c.invalidateDraftHydration=run(`(${invalidateHydration.getText(sendAst)})`);c.replaceText=run(`(${replaceDraftText.getText(sendAst)})`);
 return{c,state,download,run,async start(){const pending=run(`(${hydration})()`);run(admission);download.resolve(new File(['owned audio'],'sent.webm'));await pending;},async succeed(){run(`(${success.getText(sendAst)})()`);await chain.tail;},async fail(){await run(`(${failure.getText(sendAst)})(new Error('offline'))`);}};
}
test('Send invalidates an earlier delayed hydration before it can retain an already-sent attachment',async()=>{
 const f=sendHydrationFixture();await f.start();await f.succeed();assert.equal(f.state.clears,1);assert.deepEqual(f.state.files,[]);assert.deepEqual(f.state.stored,[],'successful Send retires the same canonical staged draft too');
});
test('a successful old Send still preserves an actually newer draft incarnation',async()=>{
 const f=sendHydrationFixture();await f.start();f.c.replaceText('newer draft');f.state.files=['new.webm'];await f.succeed();assert.equal(f.state.clears,0);assert.deepEqual(f.state.files,['new.webm']);assert.equal(f.state.text,'newer draft');assert.deepEqual(f.state.stored,['sent']);
});
test('failed Send preserves the original attachment for explicit recovery',async()=>{
 const f=sendHydrationFixture();await f.start();await f.fail();assert.equal(f.state.clears,0);assert.deepEqual(f.state.files,['sent.webm']);assert.deepEqual(f.state.stored,['sent']);assert.equal(f.state.error,'offline');
});
test('failed old Send cannot replace genuinely newer draft text or attachments',async()=>{
 const f=sendHydrationFixture();await f.start();f.c.replaceText('newer draft');f.state.files=['new.webm'];await f.fail();assert.equal(f.state.clears,0);assert.deepEqual(f.state.files,['new.webm']);assert.equal(f.state.text,'newer draft');
});

// The normal App takes the captured-outbox path, which retires the editable
// snapshot immediately. Metadata CAS responses can still contain that old body.
const attachmentSource=readFileSync(new URL('../../apps/web/src/components/chat/useComposerDraftAttachments.ts',import.meta.url),'utf8');
const attachmentAst=sendTS.createSourceFile('useComposerDraftAttachments.ts',attachmentSource,sendTS.ScriptTarget.Latest,true,sendTS.ScriptKind.TS);
const attachmentCallbacks=new Map();
function findAttachmentCallbacks(node){
 if(sendTS.isVariableDeclaration(node)&&['clear','mergeRestored'].includes(node.name.getText(attachmentAst))&&sendTS.isCallExpression(node.initializer??node))attachmentCallbacks.set(node.name.getText(attachmentAst),node.initializer.arguments[0].getText(attachmentAst));
 sendTS.forEachChild(node,findAttachmentCallbacks);
}
findAttachmentCallbacks(attachmentAst);assert.equal(attachmentCallbacks.size,2);
const reducerSource=helperAst.statements.find(n=>sendTS.isFunctionDeclaration(n)&&n.name?.text==='composerAttachmentReducer').getText(helperAst).replace(/^export /,'');
const captureCall=sendSource.indexOf('      executeCaptured(item, handler, submittedDraftWriteChain, [...files]);');assert(captureCall>0);
const captureRetirementStart=sendSource.indexOf('      continuationSeedIntent.current = selectionIntent.current;',captureCall);
const captureRetirementEnd=sendSource.indexOf('      return;',captureRetirementStart);assert(captureRetirementEnd>captureRetirementStart);
const captureRetirement=sendSource.slice(captureRetirementStart,captureRetirementEnd);
let capturedFailure;
function findCapturedFailure(node){
 if(sendTS.isCallExpression(node)&&node.expression.getText(sendAst)==='runCapturedSubmission'&&node.arguments[2]?.getText(sendAst).includes('const accepted = item.status === "accepted"'))capturedFailure=node.arguments[2].getText(sendAst);
 sendTS.forEachChild(node,findCapturedFailure);
}
findCapturedFailure(sendAst);assert(capturedFailure,'Actual captured failure callback must be found');
function capturedRetirementFixture(){
 const sent=new File(['original voice'],'sent.webm',{type:'audio/webm'}),attachment={id:'sent',name:'sent.webm'};
 const state={attachments:{files:[sent]},text:'#Agent ',saved:undefined};
 const ids={current:new Map([[sent,'sent']])},removed={current:new Set(['earlier-capture'])};
 const pending={idempotencyKey:'captured-send',draftAttachmentIds:['sent'],editableDraftAttachmentIds:['sent']};
 const chain={clientId:'owned-client',pendingDeletionIds:new Set(),ownedRevision:2};
 const c={File,console,stagedIds:['sent'],continuationSeedIntent:{current:undefined},selectionIntent:{current:undefined},draftGeneration:{current:1},draftEditVersion:{current:0},draftLocallyEdited:{current:true},draftAttachmentsLocallyEdited:{current:true},unrestoredDraftAttachmentIds:{current:[]},pendingSelection:{current:undefined},
  retainedAgentDestination:undefined,safeDefaultDestination:undefined,draftStorageKey:undefined,submittedRecovery:undefined,submittedDraftWriteChain:chain,draftRecoveryCaptureId:()=>undefined,
  draftContentGeneration:{current:1},textRef:{current:state.text},setTextState:text=>state.text=text,replacePastedText(){},pastedTextAttachmentId:{current:undefined},setKnownMentionBindings(){},setActiveDefaultDestination(){},inputRef:{current:{resetDocument(){}}},setCaret(){},setSendError(){},
  draftHydrationGeneration:{current:0},metadata:{current:new Map([['sent',attachment]])},attachmentIds:ids,locallyRemovedIds:removed,locallyRemovedDraftAttachmentIds:removed,locallyRemovedFiles:{current:new WeakSet()},pendingUploads:{current:[]},activeUploads:{current:0},generation:{current:0},setUploadStates(){},setAttachmentVersion(){},
  dispatch:action=>{state.attachments=c.reducer(state.attachments,action);},
  item:{scope:'owned-chat',ownerId:'owned-owner',status:'pending',dispatchStarted:true,pending},loadedUnderLock:true,previouslyDispatched:true,ApiRequestError:class extends Error{},CapturedSubmissionOrderError:class extends Error{},durableSubmissionMayBeReleased:()=>{throw Error('Uncertain transport must not use definitive rejection');},saveCapturedSubmission:item=>{state.saved=structuredClone(item);},
 };
 vm.createContext(c);const run=s=>vm.runInContext(compile(s),c);
 c.reducer=run('('+reducerSource.replace(/^function composerAttachmentReducer/,'function')+')');
 c.replaceText=run('('+replaceDraftText.getText(sendAst)+')');c.onBeforeClear=run('('+invalidateHydration.getText(sendAst)+')');
 c.clearDraftAttachments=run('('+attachmentCallbacks.get('clear')+')');c.mergeRestored=run('('+attachmentCallbacks.get('mergeRestored')+')');
 return{c,state,sent,attachment,pending,ids,removed,retire:()=>run(`(()=>{${captureRetirement}})()`),hydrate:(rows)=>c.mergeRestored(rows),fail:()=>run('('+capturedFailure+')(new Error("connection lost after dispatch"),item)')};
}
test('captured Send retirement cannot rehydrate its old staged audio from a metadata-only response',()=>{
 const f=capturedRetirementFixture();f.retire();assert.equal(f.state.attachments.files.length,0);
 f.hydrate([{attachment:f.attachment,file:new File(['downloaded original voice'],'restored.webm')}]);
 assert.equal(f.state.attachments.files.length,0,'old captured staging must not become an editable draft again');
 assert.equal(f.ids.current.size,0,'the next editable autosave contains no captured attachment ID');
 assert(f.removed.current.has('sent'));assert(f.removed.current.has('earlier-capture'));
 assert.equal(f.c.submittedDraftWriteChain.pendingDeletionIds.size,0,'captured payload protection is not a deletion request');
});
test('late captured metadata preserves newer audio and successive captures retain older consumption fences',()=>{
 const f=capturedRetirementFixture();f.retire();
 const newer=new File(['new voice'],'new.webm'),meta={id:'new',name:'new.webm'};
 f.state.attachments={files:[newer]};f.ids.current.set(newer,'new');
 f.hydrate([{attachment:f.attachment,file:new File(['old voice'],'old.webm')}]);
 assert.equal(f.state.attachments.files.length,1);assert.equal(f.state.attachments.files[0],newer);assert.equal(f.ids.current.get(newer),'new');
 f.c.stagedIds=['new'];f.retire();f.hydrate([{attachment:f.attachment,file:f.sent},{attachment:meta,file:newer}]);
 assert.equal(f.state.attachments.files.length,0);for(const id of ['earlier-capture','sent','new'])assert(f.removed.current.has(id));
});
test('uncertain captured-send failure retains its exact protected audio for recovery without reviving the editable draft',()=>{
 const f=capturedRetirementFixture();f.retire();f.fail();
 assert.equal(f.state.saved.status,'unknown');assert.deepEqual(f.state.saved.pending,f.pending);
 assert.equal(f.state.attachments.files.length,0);assert.equal(f.c.submittedDraftWriteChain.pendingDeletionIds.size,0);
});
