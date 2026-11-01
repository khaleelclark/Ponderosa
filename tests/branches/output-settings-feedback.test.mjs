import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const ts=require('typescript');
const source=readFileSync(new URL('../../apps/web/src/components/OutputAgentApp.tsx',import.meta.url),'utf8');
function fixture(pathname='/assistant'){
 const state=[];let index=0,tree;const requests=[];
 const app={agentId:'speaker',branchId:'branch',chatId:'chat',projectId:'project',title:'VeryLongOutputTitle'.repeat(20),engine:'codex',versionId:'version',automatic:true,everyMs:600000};
 const imports={react:{useState(initial){const i=index++;if(!(i in state))state[i]=initial;return [state[i],value=>{state[i]=value}];},useEffect(){}},
  '@tanstack/react-query':{useQuery(options){return {data:options.queryKey[0]==='assistant-status'?{initialized:true,enabled:true,app}:options.queryKey[0]==='output-app'?app:[],refetch:async()=>{}};}},
  '../api/real':{realApi:{updateAgent:async()=>{throw Error('Model update refused');}},requestJson:async(url,options)=>{requests.push({url,options});throw Error('Workflow version changed');}},
  '../api/productScope':{setStandaloneWorkspaceOwner(){}},'../hooks/useWorkspaceStream':{useWorkspaceStream:()=>({})}};
 const ui=new Proxy({},{get:(_,name)=>String(name)});
 const exports={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,window:{location:{pathname}},Error,require:name=>name in imports?imports[name]:name==='@mui/material'?ui:name==='react/jsx-runtime'?require(name):new Proxy({},{get:(_,key)=>String(key)})});
 function render(){index=0;tree=exports.OutputAgentApp();return tree;}
 function* walk(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){for(const child of node)yield* walk(child);return;}if(node.props){yield node;yield* walk(node.props.children);}}
 const nodes=()=>[...walk(render())],dialog=()=>nodes().find(n=>n.type==='Dialog');
 const button=name=>nodes().find(n=>n.type==='Button'&&n.props.children===name);
 return {nodes,dialog,button,requests};
}
for(const pathname of ['/assistant','/output/speaker']){
 test(`${pathname}: settings has a linked title and keeps schedule/model failures inside the modal`,async()=>{
  const f=fixture(pathname);f.button('Settings').props.onClick();
  const d=f.dialog();assert.equal(d.props.open,true);const title=f.nodes().find(n=>n.type==='DialogTitle');assert.equal(d.props['aria-labelledby'],title.props.id);assert.equal(title.props.children,'Settings');
  for(const [action,message] of [['Save schedule','Workflow version changed'],['Save model','Model update refused']]){
   await f.button(action).props.onClick();
   const alerts=f.nodes().filter(n=>n.type==='Alert'&&n.props.children===message);
   assert.equal(alerts.length,1,'One visible error, no hidden duplicate');
   const inside=[...function* walk(n){if(!n||typeof n!=='object')return;if(Array.isArray(n)){for(const c of n)yield* walk(c);}else if(n.props){yield n;yield* walk(n.props.children);}}(f.dialog())];
   assert.ok(inside.some(n=>n.type==='Alert'&&n.props.children===message),'Error is inside the active modal');
  }
  assert.equal(f.requests.length,1);assert.equal(JSON.parse(f.requests[0].options.body).expectedVersionId,'version');
  f.dialog().props.onClose();assert.equal(f.dialog().props.open,false);assert.ok(f.nodes().some(n=>n.type==='Alert'&&n.props.children==='Model update refused'),'Failure remains visible after closing settings');
 });
}
