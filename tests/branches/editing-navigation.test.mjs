import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import '../shared/web-typescript-loader.mjs';
const {branchRoutePath,parseBranchRoute,retainedBranchDrafts}=await import('../../apps/web/src/branchesRouting.ts');
const ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript');
const jsx=(type,props)=>({type,props});
async function fixture(){
 const source=await readFile(new URL('../../apps/web/src/components/branches/BranchNavigation.tsx',import.meta.url),'utf8');
 const states=[],effects=[],listeners=new Map(),historyEvents=[],entries=[{state:{branchesIndex:0},path:'/branches?branch=a'}];let cursor=0,slot=0,rendering=false,again=false,tree,router,settingsAllowed=true,otherAllowed=true,settingsPrompts=0,otherPrompts=0;
 const location={origin:'https://dev.test'};
 const updateLocation=()=>{const url=new URL(entries[cursor].path,location.origin);Object.assign(location,{href:url.href,pathname:url.pathname,search:url.search})};updateLocation();
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const useState=initial=>{const index=slot++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return [states[index],next=>{states[index]=typeof next==='function'?next(states[index]):next;if(rendering)again=true;else render()}]};
 const useRef=initial=>useState(()=>({current:initial}))[0];
 const useCallback=(fn,deps)=>{const index=slot++;if(!states[index]||!same(states[index].deps,deps))states[index]={deps,fn};return states[index].fn};
 const useEffect=(fn,deps)=>{const index=slot++;if(!states[index]||!same(states[index].deps,deps)){const before=states[index];states[index]={deps,cleanup:before?.cleanup};effects.push(()=>{states[index].cleanup?.();states[index].cleanup=fn()})}};
 const react={useState,useRef,useCallback,useEffect,useLayoutEffect:useEffect,useContext:context=>context.value,createContext:value=>({value,Provider:'Provider'})};
 const history={get state(){return entries[cursor].state},replaceState(state,_title,path){entries[cursor]={state,path:path??entries[cursor].path};updateLocation()},pushState(state,_title,path){entries.splice(cursor+1);entries.push({state,path});cursor++;updateLocation()},go(delta){const next=cursor+delta;if(next<0||next>=entries.length)return;cursor=next;updateLocation();historyEvents.push({state:entries[cursor].state})}};
 const window={location,history,confirm(){otherPrompts++;return otherAllowed},addEventListener(type,fn){listeners.set(type,fn)},removeEventListener(type,fn){if(listeners.get(type)===fn)listeners.delete(type)}};
 const module={exports:{}};
 const scope={window,navigator:{},URL,URLSearchParams,Number,Set,console,module,exports:module.exports,require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name.includes('productScope')?{isBranchesPath:pathname=>pathname==='/branches'}:name.includes('branchesRouting')?{branchRoutePath,parseBranchRoute,retainedBranchDrafts}:name.includes('reloadSafety')?{confirmUnsavedNavigation(){settingsPrompts++;return settingsAllowed}}:name.includes('ConfirmationDialogs')?{ConfirmDialog:'ConfirmDialog'}:(()=>{throw Error(name)})()};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,scope);
 function render(){rendering=true;do{again=false;slot=0;tree=module.exports.BranchNavigation({children:value=>{router=value;return 'content'}});while(effects.length)effects.shift()()}while(again);rendering=false}
 render();
 const providers=()=>({dirty:tree.props.value,workflow:tree.props.children.props.value,guard:tree.props.children.props.children.props.value,prompt:tree.props.children.props.children.props.children[1]});
 const actions={branchId:'a',pending:false,canSave:true,canDiscard:true,save(){},discard(){}};const get=()=>actions;providers().workflow(get);
 return {router:()=>router,actions,mark:(key,value=true)=>providers().dirty(key,value),prompt:()=>providers().prompt,guard:(action,abandon)=>providers().guard(action,abandon),refresh:()=>providers().workflow(get,true),replaceOwner:branchId=>{actions.branchId=branchId;providers().workflow(get,true)},settings:value=>{settingsAllowed=value},other:value=>{otherAllowed=value},counts:()=>({settingsPrompts,otherPrompts}),location,history,entries,listeners,flushHistory(){while(historyEvents.length)listeners.get('popstate')?.(historyEvents.shift())},historyPosition:()=>cursor};
}

test('Save And Leave waits for its exact successful workflow settlement and repeats no submission',async()=>{
 const f=await fixture();f.mark('workflow');let done,calls=0;f.actions.save=complete=>{calls++;done=complete};assert.equal(f.router().navigate({branchId:'b',tab:'workflow'}),false);assert.equal(f.router().route.branchId,'a');assert.equal(f.prompt().props.title,'Unsaved Changes');
 f.prompt().props.onConfirm();assert.equal(f.prompt().props.open,false);f.prompt().props.onConfirm();assert.equal(calls,1);assert.equal(f.router().route.branchId,'a');done(true);assert.equal(f.router().route.branchId,'b');done(true);assert.equal(f.entries.length,2,'A late duplicate callback cannot navigate twice');
});

test('Back To Editing, failed save, and stale-owner callbacks retain the accepted route',async()=>{
 for(const outcome of ['cancel','failure','owner']){const f=await fixture();f.mark('workflow');let complete;f.actions.save=done=>{complete=done};f.router().navigate({branchId:'b',tab:'workflow'});if(outcome==='cancel')f.prompt().props.onCancel();else{f.prompt().props.onConfirm();if(outcome==='owner')f.replaceOwner('new-owner');complete(outcome==='owner')}
  assert.equal(f.router().route.branchId,'a',outcome);assert.equal(f.entries.length,1,outcome);
 }
});

test('Discard And Leave uses the existing owner callback and preserves independent settings guards',async()=>{
 const f=await fixture();f.mark('workflow-editor');f.mark('branch-capabilities:a');let complete;f.actions.discard=done=>{complete=done};f.other(false);f.router().navigate({branchId:'b',tab:'workflow'});f.prompt().props.secondaryAction.onClick();complete(true);assert.equal(f.router().route.branchId,'a');assert.equal(f.counts().otherPrompts,1);assert.equal(f.prompt().props.open,false,'A canceled independent guard retires the old destination');
 f.other(true);f.mark('workflow-editor',false);f.router().navigate({branchId:'c',tab:'workflow'});assert.equal(f.router().route.branchId,'c');
});

test('same-Branch tabs and non-abandoning nested guards retain workflow edits without a workflow prompt',async()=>{
 const f=await fixture();f.mark('workflow');f.mark('workflow-editor');for(const tab of ['chats','executions','settings','workflow'])assert.equal(f.router().navigate({branchId:'a',tab}),true);
 assert.equal(f.prompt().props.open,false);let ran=0;assert.equal(f.guard(()=>ran++),true);assert.equal(ran,1);assert.equal(f.guard(()=>ran++,true),false);assert.equal(f.prompt().props.open,true);assert.equal(ran,1);
});

test('pending and unavailable owner controls remain current without replacing the queued destination',async()=>{
 const f=await fixture();f.mark('workflow');f.router().navigate({branchId:'b',tab:'workflow'});f.actions.pending=true;f.actions.canDiscard=false;f.refresh();assert.equal(f.prompt().props.pending,true);assert.equal(f.prompt().props.secondaryAction.disabled,true);f.actions.pending=false;f.actions.canSave=false;f.refresh();assert.equal(f.prompt().props.confirmDisabled,true);f.actions.canSave=true;f.refresh();let complete;f.actions.save=done=>{complete=done};f.prompt().props.onConfirm();complete(true);assert.equal(f.router().route.branchId,'b');
});

test('browser Back restores the accepted URL before review and replays the exact destination once',async()=>{
 const f=await fixture();f.router().navigate({branchId:'b',tab:'workflow'});f.actions.branchId='b';f.refresh();f.mark('workflow');let complete;f.actions.save=done=>{complete=done};f.history.go(-1);f.flushHistory();assert.equal(f.location.search,'?branch=b');assert.equal(f.router().route.branchId,'b');assert.equal(f.prompt().props.open,true);f.prompt().props.onCancel();assert.equal(f.historyPosition(),1);
 f.history.go(-1);f.flushHistory();f.prompt().props.onConfirm();complete(true);f.flushHistory();assert.equal(f.router().route.branchId,'a');assert.equal(f.location.search,'?branch=a');assert.equal(f.historyPosition(),0);assert.equal(f.entries.length,2);
});

test('clean browser Back accepts its destination directly without adding history entries',async()=>{
 const f=await fixture();f.router().navigate({branchId:'b',tab:'workflow'});f.actions.branchId='b';f.refresh();f.history.go(-1);f.flushHistory();assert.equal(f.router().route.branchId,'a');assert.equal(f.location.search,'?branch=a');assert.equal(f.entries.length,2);assert.equal(f.prompt().props.open,false);
});

test('reload retains the native unsaved-changes warning without treating presentation changes as edits',async()=>{
 const f=await fixture();let prevented=0;const event={preventDefault(){prevented++}};f.listeners.get('beforeunload')(event);assert.equal(prevented,0);f.mark('workflow');f.listeners.get('beforeunload')(event);assert.equal(prevented,1);assert.equal(event.returnValue,'');f.mark('workflow',false);f.listeners.get('beforeunload')(event);assert.equal(prevented,1);
});

test('shared confirmation shell disables all actions and dismissal while pending',async()=>{
 const source=await readFile(new URL('../../apps/web/src/components/ConfirmationDialogs.tsx',import.meta.url),'utf8'),module={exports:{}};const scope={module,exports:module.exports,require:name=>name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='react'?{}:new Proxy({},{get:(_target,key)=>String(key)})};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,scope);
 for(const pending of [true,false]){let closed=0;const props={open:true,title:'Unsaved Changes',children:'Keep edits',pending,confirmLabel:'Save And Leave',cancelLabel:'Back To Editing',onCancel(){closed++},onConfirm(){},secondaryAction:{label:'Discard And Leave',onClick(){}}};const outer=module.exports.ConfirmDialog(props),shell=outer.type(outer.props),buttons=shell.props.children[2].props.children;
  assert.equal(buttons.length,3);assert.equal(buttons[0].props.children,'Back To Editing');assert.equal(buttons[1].props.children,'Discard And Leave');assert.equal(buttons[2].props.children,pending?'Save And Leave…':'Save And Leave');assert.ok(buttons.every(button=>Boolean(button.props.disabled)===pending));shell.props.onClose();assert.equal(closed,pending?0:1);
 }
});
