import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const ts=require('typescript');
const source=readFileSync(new URL('../../apps/web/src/components/OutputAgentApp.tsx',import.meta.url),'utf8');
function fixture(pathname='/assistant',overrides={}){
 const state=[],deps=[],pending=[];let index=0,tree,changed=false;const requests=[],modelRequests=[];
 const app={agentId:'speaker',branchId:'branch',chatId:'chat',projectId:'project',title:'VeryLongOutputTitle'.repeat(20),engine:'codex',versionId:'version',automatic:true,triggerKind:'schedule',schedule:{scheduleKind:'interval',everyMs:600000,startsAt:'2099-01-01T00:00:00.000Z'},everyMs:600000,settingsRevision:'revision',runtimeSettings:{activeEngine:'codex',model:null,effort:null,speed:null},...overrides};
 const imports={react:{useState(initial){const i=index++;if(!(i in state))state[i]=initial;return [state[i],value=>{if(state[i]!==value){state[i]=value;changed=true;}}];},useRef(value){const i=index++;return state[i]??=( {current:value});},useEffect(effect,next){const i=index++;if(!deps[i]||next.some((value,j)=>value!==deps[i][j])){deps[i]=next;pending.push(effect);}}},
  '@tanstack/react-query':{useQuery(options){const snapshot={...app};return {data:options.queryKey[0]==='assistant-status'?{initialized:true,enabled:true,app:snapshot}:options.queryKey[0]==='output-app'?snapshot:[],refetch:async()=>({data:options.queryKey[0]==='assistant-status'?{initialized:true,enabled:true,app}:app})};}},
  '../api/real':{realApi:{updateAgent:async(id,patch)=>{modelRequests.push({id,patch});throw Error('Model update refused');}},requestJson:async(url,options)=>{requests.push({url,options});throw Error('Workflow version changed');}},
  '../hooks/queries':{useWorkspacePreferences:()=>({data:{}})},
  '../api/productScope':{setStandaloneWorkspaceOwner(){}},'../hooks/useWorkspaceStream':{useWorkspaceStream:()=>({})}};
 imports.react.useLayoutEffect=imports.react.useEffect;
 const ui=new Proxy({},{get:(_,name)=>String(name)});
 const exports={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,window:{location:{pathname}},Error,require:name=>name in imports?imports[name]:name==='@mui/material'?ui:name==='react/jsx-runtime'?require(name):new Proxy({},{get:()=>()=>null})});
 function render(){do{changed=false;index=0;tree=exports.OutputAgentApp({colorMode:'light',onToggleColorMode(){}});for(const effect of pending.splice(0))effect();}while(changed);return tree;}
 function* walk(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){for(const child of node)yield* walk(child);return;}if(node.props){yield node;yield* walk(node.props.children);yield* walk(node.props.control);}}
 const nodes=()=>[...walk(render())],dialog=()=>nodes().find(n=>n.type==='Dialog');
 const button=name=>nodes().find(n=>n.type==='Button'&&n.props.children===name);
 return {nodes,dialog,button,requests,modelRequests,app};
}
for(const pathname of ['/assistant','/apps/speaker']){
 test(`${pathname}: settings has a linked title and keeps schedule/model failures inside the modal`,async()=>{
  const f=fixture(pathname);f.button('Settings').props.onClick();
  const d=f.dialog();assert.equal(d.props.open,true);const title=f.nodes().find(n=>n.type==='DialogTitle');assert.equal(d.props['aria-labelledby'],title.props.id);assert.equal(title.props.children,'Settings');
  for(const [action,message] of [['Save schedule','Workflow version changed'],['Save model','Model update refused']]){
   f.button(action).props.onClick();
   // The UI callback intentionally returns void while act awaits the mutation.
   await new Promise(setImmediate);
   const alerts=f.nodes().filter(n=>n.type==='Alert'&&n.props.children===message);
   assert.equal(alerts.length,1,'One visible error, no hidden duplicate');
   const inside=[...function* walk(n){if(!n||typeof n!=='object')return;if(Array.isArray(n)){for(const c of n)yield* walk(c);}else if(n.props){yield n;yield* walk(n.props.children);}}(f.dialog())];
   assert.ok(inside.some(n=>n.type==='Alert'&&n.props.children===message),'Error is inside the active modal');
  }
  assert.equal(f.requests.length,1);assert.equal(JSON.parse(f.requests[0].options.body).expectedVersionId,'version');
  f.dialog().props.onClose();assert.equal(f.dialog().props.open,false);assert.ok(f.nodes().some(n=>n.type==='Alert'&&n.props.children==='Model update refused'),'Failure remains visible after closing settings');
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
 assert.equal(Boolean(f.nodes().find(n=>n.type==='TextField'&&n.props.label==='Check every (minutes)')),hasInterval);
 if(label)assert.ok(f.nodes().some(n=>n.type==='Typography'&&n.props.children===label));
 f.nodes().find(n=>n.type==='Switch').props.onChange(null,false);f.button('Save schedule').props.onClick();await new Promise(setImmediate);
 const body=JSON.parse(f.requests[0].options.body);assert.equal(body.automatic,false);assert.equal('everyMs'in body,false);assert.equal(body.expectedSettingsRevision,'revision');
});

for(const triggerKind of ['manual','schedule'])test(`${triggerKind}: an explicitly selected interval is submitted`,async()=>{
 const f=fixture('/apps/speaker',triggerKind==='manual'?{triggerKind,schedule:undefined,everyMs:undefined,automatic:false}:{});f.button('Settings').props.onClick();
 f.nodes().find(n=>n.type==='TextField'&&n.props.label==='Check every (minutes)').props.onChange({target:{value:'20'}});
 f.nodes().find(n=>n.type==='Switch').props.onChange(null,true);f.button('Save schedule').props.onClick();await new Promise(setImmediate);
 assert.equal(JSON.parse(f.requests[0].options.body).everyMs,1200000);
});

for(const pathname of ['/assistant','/apps/speaker'])test(pathname+': background refresh never upgrades a stale draft baseline',async()=>{
 const f=fixture(pathname);f.button('Settings').props.onClick();f.nodes();
 f.app.versionId='other-version';f.app.settingsRevision='other-revision';
 f.app.runtimeSettings={activeEngine:'claude',model:'other-model',effort:null,speed:null};
 f.button('Save schedule').props.onClick();await new Promise(setImmediate);
 const schedule=JSON.parse(f.requests[0].options.body);
 assert.equal(schedule.expectedVersionId,'version');assert.equal(schedule.expectedSettingsRevision,'revision');
 f.button('Save model').props.onClick();await new Promise(setImmediate);
 assert.deepEqual(JSON.parse(JSON.stringify(f.modelRequests[0].patch.expectedRuntimeSettings)),{activeEngine:'codex',model:null,effort:null,speed:null});
});
