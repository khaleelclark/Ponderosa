import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript');
const source=readFileSync(new URL('../../apps/web/src/components/branches/WorkflowEditor.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('WorkflowEditor.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function owner(name,scope={}){
 const matches=[];function walk(node){if(ts.isFunctionDeclaration(node)&&node.name?.text===name||ts.isVariableDeclaration(node)&&node.name.getText(ast)===name)matches.push(ts.isFunctionDeclaration(node)?node:node.initializer);ts.forEachChild(node,walk)}walk(ast);
 assert.equal(matches.length,1,`One existing ${name} owner`);
 return vm.runInNewContext(ts.transpileModule('('+matches[0].getText(ast)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:{},...scope});
}
const capture=owner('workflowInsertionAnchor');
const button=(identity,rect,document)=>({dataset:{workflowInsertion:identity},isConnected:true,ownerDocument:document,getBoundingClientRect:()=>rect,focus(options){this.focused=options.preventScroll}});

test('the menu snapshots the exact clicked client rectangle after scroll, zoom and dock layout',()=>{
 for(const rectangle of [{x:120,y:440,width:44,height:44},{x:720,y:90,width:44,height:44},{x:276,y:630,width:44,height:44},{x:20,y:116,width:28,height:28}]){
  const control=button('edge:chosen',rectangle,{querySelectorAll:()=>[]}),anchor=capture(control);
  assert.equal(anchor.nodeType,1);assert.deepEqual(anchor.getBoundingClientRect(),rectangle);
  control.isConnected=false;control.getBoundingClientRect=()=>({x:0,y:0,width:0,height:0});
  assert.deepEqual(anchor.getBoundingClientRect(),rectangle,'A React Flow redraw cannot send MUI to the detached control’s zero rectangle');
 }
});

test('dismissal restores focus to a redrawn originating control by insertion identity',()=>{
 const rect={x:300,y:420,width:44,height:44},document={querySelectorAll:()=>[other,hidden,replacement]},original=button('edge:chosen',rect,document),other=button('edge:another',rect,document),hidden=button('edge:chosen',{...rect,width:0},document),replacement=button('edge:chosen',rect,document),anchor=capture(original);
 original.isConnected=false;anchor.restoreFocus();
 assert.equal(replacement.focused,true);assert.equal(original.focused,undefined);assert.equal(other.focused,undefined);assert.equal(hidden.focused,undefined);
});

test('Outline insertion snapshots its clicked control and returns focus to the retained Outline trigger',()=>{
 const rect={x:256,y:610,width:160,height:40},document={querySelectorAll:()=>[]},original=button('edge:chosen',rect,document),outline=button(undefined,{x:900,y:720,width:44,height:44},document),anchor=capture(original,outline);
 original.isConnected=false;assert.deepEqual(anchor.getBoundingClientRect(),rect);anchor.restoreFocus();assert.equal(outline.focused,true);
});

test('Branching preserves the canonical insertion target and successful insertion does not replay dismissed-menu focus',()=>{
 let insertionTarget,addAnchor,branching,definition={entry:'original'},published,selected,open=false,focusRequest=0;const dismissedInsertion={current:{stale:true}},scope={workflowInsertionAnchor:capture,dismissedInsertion,setInsertionTarget:value=>{insertionTarget=value},setBranching:value=>{branching=value},setAddAnchor:value=>{addAnchor=value},setInsertError(){}};
 const openAdd=owner('openAdd',scope),target={kind:'edge',edgeId:'failure-connection'},control=button(JSON.stringify(target),{x:310,y:512,width:44,height:44},{querySelectorAll:()=>[]});
 openAdd(target,control);assert.equal(insertionTarget,target);assert.equal(branching,false);assert.equal(dismissedInsertion.current,null);
 branching=true; // The existing Branching menu replaces options without opening another menu or target.
 const add=owner('add',{...scope,addAnchor,definition,insertionTarget,insertGuidedStep:(value,kind,actual)=>{assert.equal(value,definition);assert.equal(kind,'condition');assert.equal(actual,target);return {ok:true,definition:{entry:'new'},selected:'new'}},onDraft:value=>{published=value},setSelected:value=>{selected=value},setEditorOpen:value=>{open=value},setFocusRequest:update=>{focusRequest=update(focusRequest)}});
 add('condition');assert.equal(published.definition.entry,'new');assert.equal(selected,'new');assert.equal(open,true);assert.equal(focusRequest,1);assert.equal(addAnchor,null);assert.equal(dismissedInsertion.current,null);
});

test('dismissal waits for MUI exit before restoring focus and cannot restore into an inactive workspace',()=>{
 let addAnchor={restored:0,restoreFocus(){this.restored++}},current=addAnchor;const dismissedInsertion={current:null};
 owner('closeAdd',{addAnchor,dismissedInsertion,setAddAnchor:value=>{addAnchor=value}})();assert.equal(addAnchor,null);assert.equal(current.restored,0);
 const matches=[];function walk(node){if(ts.isArrowFunction(node)&&node.getText(ast).includes('const anchor=dismissedInsertion.current;'))matches.push(node);ts.forEachChild(node,walk)}walk(ast);assert.equal(matches.length,1);
 const ownerState={current:{active:true}},mounted={current:true},exit=vm.runInNewContext(ts.transpileModule('('+matches[0].getText(ast)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{dismissedInsertion,mounted,owner:ownerState});
 exit();assert.equal(current.restored,1);assert.equal(dismissedInsertion.current,null);
 dismissedInsertion.current=current;ownerState.current.active=false;exit();assert.equal(current.restored,1);assert.equal(dismissedInsertion.current,null);
});

test('invalid insertion keeps the same target, menu and draft instead of silently moving insertion elsewhere',()=>{
 const addAnchor={},insertionTarget={kind:'edge',edgeId:'removed-connection'},dismissedInsertion={current:null};let error;
 const add=owner('add',{addAnchor,insertionTarget,definition:{},dismissedInsertion,insertGuidedStep:(_definition,_kind,target)=>{assert.equal(target,insertionTarget);return {ok:false,reason:'This connection no longer exists.'}},setInsertError:value=>{error=value},onDraft(){assert.fail('Invalid insertion must not publish a draft change')},setAddAnchor(){assert.fail('Keep the menu open with its original target')}});
 add('agent');assert.equal(error,'This connection no longer exists.');assert.equal(dismissedInsertion.current,null);
});
