import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
const {emptyWorkflowHistory,recordWorkflowEdit,moveWorkflowHistory}=await import('../../apps/web/src/components/branches/workflow-history.ts');
const {bindDefinitionDirectories,newDefinition}=await import('../../apps/web/src/components/branches/model.ts');

const draft=()=>({definition:{...newDefinition(),name:'Workflow',entry:'work',steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'reviewer'},instructions:'Review input'}]},bindings:{agents:{reviewer:'agent-a'},directories:{custom:'/chosen'}},chatId:'chat-a'});

test('Undo/Redo restores the atomic definition, fields and bindings without publication or presentation identity',()=>{
 const before={...draft(),branchId:'branch-a',expectedVersionId:'published-a'},after={...before,definition:{...before.definition,steps:[{...before.definition.steps[0],target:{kind:'persistent_organization',ref:'team'},instructions:'Review together'}]},bindings:{...before.bindings,agents:{...before.bindings.agents,team:'created-lead'}},viewport:{x:10,y:20,zoom:1.2},selected:'work'};
 const history=recordWorkflowEdit(emptyWorkflowHistory(),before,after),undo=moveWorkflowHistory(history,after,'undo');
 assert.deepEqual(undo.draft,draft());assert.equal(undo.draft.branchId,undefined);assert.equal(undo.draft.expectedVersionId,undefined);assert.equal(undo.draft.viewport,undefined);assert.equal(undo.draft.selected,undefined);
 const redo=moveWorkflowHistory(undo.history,undo.draft,'redo');assert.deepEqual(redo.draft,{definition:after.definition,bindings:after.bindings,chatId:after.chatId});assert.equal(redo.draft.bindings.agents.team,'created-lead','Redo reuses the existing real resource identity');
 const renamed={...redo.draft,definition:{...redo.draft.definition,name:'New name'}};assert.equal(recordWorkflowEdit(undo.history,undo.draft,renamed).future.length,0,'An edit after Undo retires only its redo branch');
});

test('no-op draft edits retain redo and snapshot history cannot be mutated by a caller',()=>{
 const before=draft(),after={...before,definition:{...before.definition,name:'Edited'}};
 let history=recordWorkflowEdit(emptyWorkflowHistory(),before,after),undo=moveWorkflowHistory(history,after,'undo');history=undo.history;
 assert.equal(recordWorkflowEdit(history,undo.draft,structuredClone(undo.draft)),history,'A trigger normalization or equal field value is not an edit');
 after.definition.name='Caller mutation';assert.equal(moveWorkflowHistory(history,undo.draft,'redo').draft.definition.name,'Edited');
 undo.draft.bindings.agents.reviewer='Caller mutation';assert.equal(moveWorkflowHistory(history,draft(),'redo').draft.bindings.agents.reviewer,'agent-a');
});

test('draft history is bounded and canonical baseline resets remove both Undo and Redo',()=>{
 let current=draft(),history=emptyWorkflowHistory();for(let i=0;i<130;i++){const next={...current,definition:{...current.definition,name:`Edit ${i}`}};history=recordWorkflowEdit(history,current,next);current=next;}
 assert.equal(history.past.length,100);let moved,count=0;while((moved=moveWorkflowHistory(history,current,'undo'))){({history,draft:current}=moved);count++;}assert.equal(count,100);assert.equal(current.definition.name,'Edit 29');
 history=emptyWorkflowHistory();assert.equal(moveWorkflowHistory(history,current,'undo'),undefined);assert.equal(moveWorkflowHistory(history,current,'redo'),undefined);
});

test('structural directory initialization preserves custom and explicitly empty bindings through later field edits',()=>{
 const definition={...newDefinition(),entry:'custom',steps:[{id:'custom',kind:'script',cwdRef:'custom',runtime:'node',source:'',timeoutMs:1000},{id:'empty',kind:'script',cwdRef:'empty',runtime:'node',source:'',timeoutMs:1000},{id:'new',kind:'script',cwdRef:'new',runtime:'node',source:'',timeoutMs:1000}]},bindings={agents:{},directories:{custom:'/selected/custom',empty:'',stale:'/unused'}};
 const initialized=bindDefinitionDirectories(definition,bindings,'/chat/default');assert.deepEqual(initialized.directories,{custom:'/selected/custom',empty:'',new:'/chat/default'});
 assert.deepEqual(bindDefinitionDirectories({...definition,name:'Edited name'},initialized,'/chat/default'),initialized,'Editing another field cannot rewrite a chosen working directory');assert.deepEqual(bindDefinitionDirectories(definition,bindings).directories,{custom:'/selected/custom',empty:'',new:''});
});

/** Exercise the existing parent draft owner and its guards, rather than a second React history implementation. */
async function parentFixture(){
 const {readFile}=await import('node:fs/promises'),{createRequire}=await import('node:module'),vm=await import('node:vm'),ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript');
 const source=await readFile(new URL('../../apps/web/src/components/BranchesView.tsx',import.meta.url),'utf8'),file=ts.createSourceFile('BranchesView.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),declarations=new Map();
 function visit(node){if(ts.isVariableStatement(node))for(const declaration of node.declarationList.declarations)if(ts.isIdentifier(declaration.name))declarations.set(declaration.name.text,node.getText(file));ts.forEachChild(node,visit)}visit(file);
 const current={...draft(),branchId:'branch-a',expectedVersionId:'version-a'},scope={actionLocks:{current:new Set()},editorGeneration:1,dirty:false,selection:{current:1},versionRequest:{current:0},contexts:{data:[]},bindDefinitionDirectories,setError(){},setTab(){},setHistoryBranch(){},requestJson:async()=>({definition:{...current.definition,name:'Restored version'}}),structuredClone,emptyWorkflowHistory,recordWorkflowEdit,moveWorkflowHistory,draftHistory:{current:emptyWorkflowHistory()},currentDraft:{current},draftRevision:{current:''},workflowEdits:{current:0},savedDraft:{current:''},pendingAdvanced:{current:false},branchDraftRevision:value=>JSON.stringify(value),loading:false,openingLink:false,advancedDirty:false,review:{isPending:false},deploy:{isPending:false},discard:{isPending:false},publicationUnconfirmed:false,setAdvancedDirty(){},setDeployedUpdate(){},setEditorKey(){},updateDraft(next){scope.draft=next}};
 const context=vm.createContext(scope),load=name=>{const declaration=declarations.get(name);assert.ok(declaration,`Actual owner ${name} exists`);vm.runInContext(ts.transpileModule(declaration.replace(`const ${name}=`,`globalThis.${name}=`),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context)};
 for(const name of ['setDraft','resetWorkflowBaseline','historyLocked','moveDraftHistory','undoRedo'])load(name);
 return {scope,load};
}

test('parent Undo/Redo advances draft fences, respects every pending/uncertain lock and preserves canonical baseline',async()=>{
 const {scope:s,load}=await parentFixture(),initial=s.currentDraft.current;s.setDraft(d=>({...d,definition:{...d.definition,name:'Edited'}}));assert.equal(s.draftHistory.current.past.length,1);const fence=s.workflowEdits.current;
 for(const lock of ['loading','openingLink','advancedDirty','review','deploy','discard','publicationUnconfirmed']){if(['review','deploy','discard'].includes(lock))s[lock].isPending=true;else s[lock]=true;load('historyLocked');s.moveDraftHistory('undo');assert.equal(s.currentDraft.current.definition.name,'Edited',`Undo stays fenced during ${lock}`);if(['review','deploy','discard'].includes(lock))s[lock].isPending=false;else s[lock]=false;}
 for(const action of ['review','deploy','discard']){s.actionLocks.current.add(action);load('historyLocked');s.moveDraftHistory('undo');assert.equal(s.currentDraft.current.definition.name,'Edited',`Synchronous ${action} intent locks history before its pending render`);s.actionLocks.current.delete(action);}
 s.selection.current++;load('historyLocked');s.moveDraftHistory('undo');assert.equal(s.currentDraft.current.definition.name,'Edited','A previous editor generation cannot undo the current workflow');s.editorGeneration=s.selection.current;
 load('historyLocked');s.moveDraftHistory('undo');assert.equal(s.currentDraft.current.definition.name,'Workflow');assert.equal(s.currentDraft.current.expectedVersionId,'version-a');assert.equal(s.workflowEdits.current,fence+1);assert.equal(s.draftRevision.current,s.branchDraftRevision(s.currentDraft.current));s.moveDraftHistory('redo');assert.equal(s.currentDraft.current.definition.name,'Edited');
 s.resetWorkflowBaseline(initial);assert.equal(s.draftHistory.current.past.length,0);assert.equal(s.draftHistory.current.future.length,0);assert.equal(s.savedDraft.current,s.branchDraftRevision(initial));
});


test('restoring a historical version is one undoable unpublished edit with exact bindings',async()=>{
 const {scope:s,load}=await parentFixture(),original=structuredClone(s.currentDraft.current);load('versionDefinition');await s.versionDefinition({branchId:'branch-a',id:'historical-version'},true);assert.equal(s.draftHistory.current.past.length,1);assert.equal(s.currentDraft.current.definition.name,'Restored version');assert.equal(s.currentDraft.current.expectedVersionId,'version-a','Historical content does not replace the publication concurrency identity');s.editorGeneration=s.selection.current;s.moveDraftHistory('undo');assert.deepEqual(structuredClone(s.currentDraft.current),original);assert.equal(s.draftHistory.current.future.length,1);
});
