import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const ts=require('typescript');
const source=readFileSync(new URL('../../apps/web/src/components/OutputAgentApp.tsx',import.meta.url),'utf8');
function fixture(pathname='/assistant',overrides={},behavior={}){
 const state=[],deps=[],pending=[];let index=0,tree,changed=false;const requests=[],modelRequests=[],nameRequests=[];
 const app={agentId:'speaker',branchId:'branch',chatId:'chat',projectId:'project',title:'VeryLongOutputTitle'.repeat(20),engine:'codex',versionId:'version',automatic:true,triggerKind:'schedule',schedule:{scheduleKind:'interval',everyMs:600000,startsAt:'2099-01-01T00:00:00.000Z'},everyMs:600000,settingsRevision:'revision',runtimeSettings:{activeEngine:'codex',model:null,effort:null,speed:null},...overrides};
 class ApiRequestError extends Error{constructor(status,message){super(message);this.status=status;}}
 const imports={'../api/types':{ApiRequestError},'./MutationNotifications':{useMutationNotification:()=>()=>{}},'@ponderosa/core':require('@ponderosa/core'),react:{useState(initial){const i=index++;if(!(i in state))state[i]=initial;return [state[i],value=>{if(state[i]!==value){state[i]=value;changed=true;}}];},useRef(value){const i=index++;return state[i]??=( {current:value});},useMemo:factory=>factory(),useEffect(effect,next){const i=index++;if(!deps[i]||next.some((value,j)=>value!==deps[i][j])){deps[i]=next;pending.push(effect);}}},
  '@tanstack/react-query':{useQueryClient:()=>({setQueryData(){},invalidateQueries:async()=>{}}),useQuery(options){const snapshot={...app};return {data:options.queryKey[0]==='assistant-status'?{initialized:true,enabled:behavior.enabled??true,...(behavior.enabled===false?{}:{app:snapshot})}:options.queryKey[0]==='output-app'?snapshot:[],refetch:async()=>behavior.refresh?behavior.refresh(options.queryKey[0],app):({data:options.queryKey[0]==='assistant-status'?{initialized:true,enabled:true,app}:app})};}},
  '../api/real':{realApi:{updateAgent:async(id,patch)=>{if('title' in patch){nameRequests.push({id,patch});if(behavior.name)return behavior.name(patch,app,nameRequests.length);throw new ApiRequestError(409,'Name changed');}modelRequests.push({id,patch});if(behavior.model)return behavior.model(patch,app,modelRequests.length);throw Error('Model update refused');}},requestJson:async(url,options)=>{requests.push({url,options});if(behavior.schedule)return behavior.schedule(JSON.parse(options.body),app,requests.length);throw Error('Workflow version changed');}},
  '../hooks/queries':{useWorkspacePreferences:()=>({data:{}})},
  '../theme':{createPonderosaTheme:()=>({palette:{primary:{main:'#137553',contrastText:'#fff'}}}),ponderosaSurfaceVariables:()=>({})},
  '../api/productScope':{setStandaloneWorkspaceOwner(){},productApiPath:path=>path},'../hooks/useWorkspaceStream':{useWorkspaceStream:()=>({})}};
 imports.react.useLayoutEffect=imports.react.useEffect;
 const ui=new Proxy({},{get:(_,name)=>String(name)});
 const exports={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,document:{title:''},window:{location:{pathname}},Error,require:name=>name in imports?imports[name]:name==='@mui/material'?ui:name==='react/jsx-runtime'?require(name):new Proxy({},{get:()=>()=>null})});
 function render(){do{changed=false;index=0;tree=exports.OutputAgentApp({colorMode:'light',onToggleColorMode(){}});for(const effect of pending.splice(0))effect();}while(changed);return tree;}
 function* walk(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){for(const child of node)yield* walk(child);return;}if(node.props){yield node;yield* walk(node.props.children);yield* walk(node.props.control);}}
 const nodes=()=>[...walk(render())],dialog=()=>nodes().find(n=>n.type==='Dialog');
 const button=name=>nodes().find(n=>['Button','IconButton'].includes(n.type)&&(n.props['aria-label']??n.props.children)===name);
 return {nodes,dialog,button,requests,modelRequests,nameRequests,app};
}
for(const pathname of ['/assistant','/apps/speaker']){
 test(`${pathname}: settings has a linked title and keeps schedule/model recovery compact inside the modal`,async()=>{
  const f=fixture(pathname);f.button('Settings').props.onClick();
  const d=f.dialog();assert.equal(d.props.open,true);const title=f.nodes().find(n=>n.type==='DialogTitle');assert.equal(d.props['aria-labelledby'],title.props.id);assert.equal(title.props.children,pathname==='/assistant'?f.app.title+' Settings':'Settings');
  for(const [action,message] of [['Save Schedule','Workflow version changed'],['Save Model','Model update refused']]){
   if(action==='Save Schedule')f.nodes().find(n=>n.type==='Switch').props.onChange(null,false);
   else f.nodes().find(n=>n.type==='TextField'&&n.props.label==='Model').props.onChange({target:{value:'new-model'}});
   f.button(action).props.onClick();
   // The UI callback intentionally returns void while act awaits the mutation.
   await new Promise(setImmediate);
   const alerts=f.nodes().filter(n=>n.type==='Typography'&&n.props.children===message);
   assert.equal(alerts.length,1,'One visible error, no hidden duplicate');
   const inside=[...function* walk(n){if(!n||typeof n!=='object')return;if(Array.isArray(n)){for(const c of n)yield* walk(c);}else if(n.props){yield n;yield* walk(n.props.children);}}(f.dialog())];
   assert.ok(inside.some(n=>n.type==='Typography'&&n.props.children===message),'Error is inside the active modal');
  }
  assert.equal(f.requests.length,1);assert.equal(JSON.parse(f.requests[0].options.body).expectedVersionId,'version');
  f.dialog().props.onClose();f.nodes().find(n=>n.props.title==='Unsaved Settings').props.onConfirm();assert.equal(f.dialog().props.open,false);assert.ok(f.nodes().some(n=>n.type==='Typography'&&n.props.children==='Model update refused'),'Failure remains visible after closing settings');
 });
}

for(const pathname of ['/assistant','/apps/speaker'])for(const [overrides,label,hasInterval] of [
 [{triggerKind:'manual',schedule:undefined,everyMs:undefined,automatic:false},undefined,true],
 [{},undefined,true],
 [{schedule:{scheduleKind:'cron',expression:'15 9 * * 1-5',timezone:'America/New_York'},everyMs:undefined},'Cron schedule: 15 9 * * 1-5 (America/New_York)',false],
 [{schedule:{scheduleKind:'once',at:'2099-01-01T00:00:00.000Z'},everyMs:undefined},'Once at 2099-01-01T00:00:00.000Z',false],
 [{triggerKind:'filesystem',schedule:undefined,everyMs:undefined},'When files change',false],
 [{triggerKind:'webhook',schedule:undefined,everyMs:undefined},'When a webhook event arrives',false],
])test(`${pathname}: ${label??overrides.triggerKind??'interval'} displays its actual cadence and omits unchanged intervals`,async()=>{
 const f=fixture(pathname,overrides);f.button('Settings').props.onClick();
 assert.equal(Boolean(f.nodes().find(n=>n.type==='TextField'&&n.props.label==='Check Every (Minutes)')),hasInterval);
 if(label)assert.ok(f.nodes().some(n=>n.type==='Typography'&&n.props.children===label));
 if(overrides.automatic===false){assert.equal(f.button('Save Schedule').props.disabled,true);return;}
 f.nodes().find(n=>n.type==='Switch').props.onChange(null,false);f.button('Save Schedule').props.onClick();await new Promise(setImmediate);
 const body=JSON.parse(f.requests[0].options.body);assert.equal(body.automatic,false);assert.equal('everyMs'in body,false);assert.equal(body.expectedSettingsRevision,'revision');
});

for(const triggerKind of ['manual','schedule'])test(`${triggerKind}: an explicitly selected interval is submitted`,async()=>{
 const f=fixture('/apps/speaker',triggerKind==='manual'?{triggerKind,schedule:undefined,everyMs:undefined,automatic:false}:{});f.button('Settings').props.onClick();
 f.nodes().find(n=>n.type==='TextField'&&n.props.label==='Check Every (Minutes)').props.onChange({target:{value:'20'}});
 f.nodes().find(n=>n.type==='Switch').props.onChange(null,true);f.button('Save Schedule').props.onClick();await new Promise(setImmediate);
 assert.equal(JSON.parse(f.requests[0].options.body).everyMs,1200000);
});

for(const pathname of ['/assistant','/apps/speaker'])test(pathname+': interval validation accepts 730 days and blocks unsafe or unrepresentable dates',async()=>{
 const f=fixture(pathname);f.button('Settings').props.onClick();
 const field=()=>f.nodes().find(n=>n.type==='TextField'&&n.props.label==='Check Every (Minutes)');
 field().props.onChange({target:{value:String(730*24*60)}});assert.equal(field().props.error,false);
 f.button('Save Schedule').props.onClick();await new Promise(setImmediate);
 assert.equal(JSON.parse(f.requests[0].options.body).everyMs,730*86400000);
 const count=f.requests.length;
 for(const value of ['1.000001',String(Number.MAX_SAFE_INTEGER),String(8640000000000000/60000)]){
  field().props.onChange({target:{value}});assert.equal(field().props.error,true);
  f.button('Save Schedule').props.onClick();await new Promise(setImmediate);assert.equal(f.requests.length,count);
 }
});

for(const pathname of ['/assistant','/apps/speaker'])test(pathname+': background refresh never upgrades a stale draft baseline',async()=>{
 const f=fixture(pathname);f.button('Settings').props.onClick();f.nodes();
 f.app.versionId='other-version';f.app.settingsRevision='other-revision';
 f.app.runtimeSettings={activeEngine:'claude',model:'other-model',effort:null,speed:null};
 f.nodes().find(n=>n.type==='Switch').props.onChange(null,false);f.button('Save Schedule').props.onClick();await new Promise(setImmediate);
 const schedule=JSON.parse(f.requests[0].options.body);
 assert.equal(schedule.expectedVersionId,'version');assert.equal(schedule.expectedSettingsRevision,'revision');
 f.nodes().find(n=>n.type==='TextField'&&n.props.label==='Model').props.onChange({target:{value:'new-model'}});f.button('Save Model').props.onClick();await new Promise(setImmediate);
 assert.deepEqual(JSON.parse(JSON.stringify(f.modelRequests[0].patch.expectedRuntimeSettings)),{activeEngine:'codex',model:null,effort:null,speed:null});
});

for(const pathname of ['/assistant','/apps/speaker'])for(const section of ['model','schedule'])test(`${pathname}: ${section} save never adopts an intervening edit as its draft baseline`,async()=>{
 let committed;
 const behavior={
  model(patch,app,count){
   if(JSON.stringify(patch.expectedRuntimeSettings)!==JSON.stringify(app.runtimeSettings))throw Error('Model settings changed. Reload settings before saving.');
   const saved={id:app.agentId,activeEngine:patch.activeEngine,model:patch.model,effort:'medium',speed:null};
   if(count===1){committed={activeEngine:saved.activeEngine,model:saved.model,effort:saved.effort,speed:saved.speed};app.model='external-model';app.runtimeSettings={...committed,model:app.model};}
   else {app.model=patch.model;app.runtimeSettings={...committed,model:patch.model};}
   return saved;
  },
  schedule(patch,app,count){
   if(patch.expectedSettingsRevision!==app.settingsRevision)throw Error('Workflow changed. Reload settings.');
   const saved={...app,automatic:patch.automatic,settingsRevision:'committed-revision'};
   if(count===1){committed=saved;Object.assign(app,{automatic:true,settingsRevision:'external-revision'});}
   else Object.assign(app,saved);
   return saved;
  },
 };
 const f=fixture(pathname,{},behavior);f.button('Settings').props.onClick();
 if(section==='model')f.nodes().find(n=>n.type==='TextField'&&n.props.label==='Model').props.onChange({target:{value:'saved-model'}});
 else f.nodes().find(n=>n.type==='Switch').props.onChange(null,false);
 const label=section==='model'?'Save Model':'Save Schedule';f.button(label).props.onClick();await new Promise(setImmediate);f.nodes();
 if(section==='model')f.nodes().find(n=>n.type==='TextField'&&n.props.label==='Model').props.onChange({target:{value:'another-model'}});else f.nodes().find(n=>n.type==='Switch').props.onChange(null,true);
 f.button(label).props.onClick();await new Promise(setImmediate);f.nodes();
 if(section==='model'){
  assert.deepEqual(JSON.parse(JSON.stringify(f.modelRequests[1].patch.expectedRuntimeSettings)),committed);
  assert.equal(f.app.model,'external-model');
 }else{
  assert.equal(JSON.parse(f.requests[1].options.body).expectedSettingsRevision,'committed-revision');assert.equal(f.app.automatic,true);assert.equal(f.app.settingsRevision,'external-revision');
 }
 assert.ok(f.nodes().some(n=>n.type==='Typography'&&/changed/.test(n.props.children)),'The later edit remains protected by the original successful mutation result');
});


for(const pathname of ['/assistant','/apps/speaker'])test(pathname+': deferred discard reload reads persisted settings while real model save reports saving',async()=>{
 let releaseRefresh,releaseSave;
 const refreshes=[],f=fixture(pathname,{model:'stored-model',runtimeSettings:{activeEngine:'codex',model:'stored-model',effort:null,speed:null}},{
  refresh(key,app){refreshes.push(key);return new Promise(resolve=>{releaseRefresh=()=>resolve({data:key==='assistant-status'?{initialized:true,enabled:true,app:{...app}}:{...app}});});},
  model(patch,app){return new Promise(resolve=>{releaseSave=()=>{app.model=patch.model;app.runtimeSettings={...app.runtimeSettings,model:patch.model};resolve({id:app.agentId,activeEngine:app.engine,model:app.model,effort:null,speed:null});};});},
 });
 const model=()=>f.nodes().find(n=>n.type==='TextField'&&n.props.label==='Model');
 const status=()=>f.nodes().find(n=>n.type==='Typography'&&n.props.role==='status'&&n.props.variant==='body2').props.children;
 f.button('Settings').props.onClick();model().props.onChange({target:{value:'unsaved-draft'}});
 f.app.settingsRevision='external-revision';f.button('Reload Saved Settings').props.onClick();
 assert.equal(status(),'Reloading…');assert.equal(model().props.value,'unsaved-draft');assert.equal(model().props.disabled,true);
 assert.equal(f.app.model,'stored-model');assert.equal(f.modelRequests.length,0);assert.equal(f.requests.length,0);
 releaseRefresh();await new Promise(setImmediate);
 assert.equal(status(),'');assert.equal(model().props.value,'stored-model');assert.equal(f.app.model,'stored-model');
 model().props.onChange({target:{value:'saved-model'}});f.button('Save Model').props.onClick();
 assert.equal(status(),'Saving…');assert.equal(f.app.model,'stored-model');assert.equal(f.modelRequests.length,1);
 assert.equal(f.modelRequests[0].patch.expectedRuntimeSettings.model,'stored-model');
 releaseSave();await new Promise(setImmediate);
 assert.equal(status(),'Saving…');assert.equal(f.app.model,'saved-model');
 releaseRefresh();await new Promise(setImmediate);
 assert.equal(status(),'Model Saved');assert.equal(model().props.value,'saved-model');assert.equal(f.app.model,'saved-model');
 assert.equal(f.requests.length,0);assert.deepEqual(refreshes,[pathname==='/assistant'?'assistant-status':'output-app',pathname==='/assistant'?'assistant-status':'output-app']);
});

test('a confirmed settings write with failed readback stays saved and leaves read failures to the query owner',async()=>{
 const f=fixture('/assistant',{}, {schedule:async(_input,app)=>({...app}),refresh:async()=>({error:new Error('Controlled readback failure')})});
 f.button('Settings').props.onClick();f.nodes().find(n=>n.type==='Switch').props.onChange(null,false);f.button('Save Schedule').props.onClick();await new Promise(setImmediate);
 assert.equal(f.requests.length,1,'one explicit settings write');assert.ok(f.nodes().some(n=>n.type==='Typography'&&n.props.role==='status'&&n.props.children==='Changes saved. Current settings are still being checked.'),'confirmed write is not relabeled as a failed action');
 assert.equal(f.nodes().filter(n=>n.type==='Typography'&&typeof n.props.children==='string'&&/Controlled readback failure|Changes saved, but/.test(n.props.children)).length,0,'readback does not become a duplicate string action banner');
});

for(const pathname of ['/assistant','/apps/speaker'])test(pathname+': unchanged sections cannot save and no permanent draft reload is offered',()=>{
 const f=fixture(pathname);f.button('Settings').props.onClick();
 for(const label of ['Save Model','Save Schedule'])assert.equal(f.button(label).props.disabled,true);
 assert.equal(f.button('Reload Saved Settings'),undefined);assert.equal(f.button('Discard Draft And Reload'),undefined);
 assert.equal(Boolean(f.button('More Options')),pathname!=='/assistant');
});
test('Name saves independently, adopts the canonical spelling and a failed readback cannot replay the write',async()=>{
 const f=fixture('/assistant',{}, {name:async(patch,app)=>{app.title=patch.title;return {id:app.agentId,title:patch.title};},refresh:async()=>({error:new Error('Readback failed')})});
 f.button('Settings').props.onClick();
 const field=label=>f.nodes().find(n=>n.type==='TextField'&&n.props.label===label);
 field('Model').props.onChange({target:{value:'draft-model'}});f.nodes().find(n=>n.type==='Switch').props.onChange(null,false);
 field('Name').props.onChange({target:{value:'My Pine Partner'}});f.button('Save Name').props.onClick();await new Promise(setImmediate);
 assert.equal(f.nameRequests.length,1);assert.equal(f.nameRequests[0].patch.expectedTitle,'VeryLongOutputTitle'.repeat(20));assert.equal(f.app.title,'My Pine Partner');
 assert.equal(field('Model').props.value,'draft-model');assert.equal(f.nodes().find(n=>n.type==='Switch').props.checked,false);assert.equal(f.button('Save Name').props.disabled,true);
 assert.ok(f.nodes().some(n=>n.type==='Typography'&&n.props.children==='Changes saved. Current settings are still being checked.'));
 f.button('Save Name').props.onClick();await new Promise(setImmediate);assert.equal(f.nameRequests.length,1);
});
test('Name validation shares canonical rules; conflict preserves edits and reload affects settings only',async()=>{
 const f=fixture();f.button('Settings').props.onClick();const name=()=>f.nodes().find(n=>n.type==='TextField'&&n.props.label==='Name');
 for(const value of ['','   ','Bad\u0001Name','Line\nBreak']){name().props.onChange({target:{value}});assert.equal(f.button('Save Name').props.disabled,true);}
 name().props.onChange({target:{value:'Case Preserved '.repeat(40).trim()}});assert.equal(f.button('Save Name').props.disabled,false);
 f.button('Save Name').props.onClick();await new Promise(setImmediate);assert.equal(name().props.value,'Case Preserved '.repeat(40).trim());assert.ok(f.button('Reload Saved Settings'));
 f.app.title='Other Editor';f.button('Reload Saved Settings').props.onClick();await new Promise(setImmediate);assert.equal(name().props.value,'Other Editor');assert.equal(f.nameRequests.length,1);
});

test('Paused Assistant keeps the existing Enable action in settings',()=>{
 const f=fixture('/assistant',{}, {enabled:false});f.button('Settings').props.onClick();assert.ok(f.button('Enable Assistant'));assert.equal(f.button('Disable Assistant'),undefined);
});
