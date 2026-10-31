import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)), React=require('react'),ts=require('typescript');
const widget=name=>Object.assign(()=>null,{displayName:name}),mui=new Proxy({},{get:(o,key)=>o[key]??=(widget(key))});
const Banner=widget('ChatLiveBanner'),Delivery=widget('MessageDeliveryStatus'),Usage=widget('ProviderQuotaIndicator');
function harness(messages,extra={}){
  let index=0;const values=[],calls=[],exports={};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/ProviderFailureBanner.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{exports,Date,Map,Set,require:name=>({react:{...React,useEffect(){},useState:initial=>{const i=index++;if(!(i in values))values[i]=initial;return[values[i],v=>values[i]=v]}},'@mui/material':mui,'@tanstack/react-query':{useQueryClient:()=>({invalidateQueries:async input=>calls.push(['invalidate',input])})},'../api':{api:{recheckEngine:async provider=>calls.push(['recheck',provider])}},'../queryKeys':{queryKeys:{engines:{all:['engines']}}},'./chat/ChatLiveBanner':{ChatLiveBanner:Banner},'./MessageDeliveryStatus':{MessageDeliveryStatus:Delivery},'./ProviderUsageCenter':{ProviderQuotaIndicator:Usage},'./WorkspaceReadOnlyContext':{useWorkspaceReadOnly:()=>false}}[name]??require(name))});
  const render=()=>{index=0;return [...walk(exports.ProviderFailureBanner({projectId:'p',messages,agents:[{id:'a',title:'Full multiword Agent name'}],children:'working fallback',...extra}))]};
  return{render,calls,exports};
}
function* walk(node){if(!React.isValidElement(node))return;yield node;for(const child of React.Children.toArray(node.props.children))yield*walk(child)}
const text=node=>React.isValidElement(node)?React.Children.toArray(node.props.children).map(text).join(''):String(node??'');
const receipt=(category,extra={})=>({activationId:'exact-work',targetAgentId:'a',state:'failed',updatedAt:'2026-10-23T20:00:00Z',attemptCount:1,canRetry:true,providerFailure:{category,providerId:'codex',recovery:'action_required',runId:'failed-run',...extra}});
for(const[category,expected]of[['quota_exhausted','Codex usage limit reached'],['rate_limit','Codex limited this request'],['throttled','Codex is temporarily limiting requests'],['capacity','Codex is temporarily at capacity']])test('UI014 actual Chat banner and Details: '+category,()=>{
 const r=receipt(category),h=harness([{text:'Exact retained request',deliveryReceipts:[r]}]);
 let nodes=h.render();assert.equal(nodes.find(n=>n.type===Banner).props.singleLine,true);assert.match(text(nodes.find(n=>n.type===Banner)),new RegExp(expected));
 assert.equal(nodes.find(n=>n.type===mui.Dialog).props.open,false);
 nodes.find(n=>n.type===mui.ButtonBase).props.onClick();nodes=h.render();assert.equal(nodes.find(n=>n.type===mui.Dialog).props.open,true);
 assert.match(nodes.map(text).join(' '),/Full multiword Agent name|Exact retained request/);
 const delivery=nodes.find(n=>n.type===Delivery);assert.equal(delivery.props.hideCancelAction,true);assert.equal(delivery.props.receipts[0],r,'Use existing exact-ID retry/duplicate-work controls');
 assert.equal(nodes.find(n=>n.type===Usage).props.preferredProvider,'codex');
 if(category==='quota_exhausted')assert.match(nodes.map(text).join(' '),/provider did not report a reset time/);
 if(category==='rate_limit')assert.match(nodes.map(text).join(' '),/cannot yet confirm whether this is temporary throttling or an exhausted allowance/);
});
test('UI014 Details use canonical reset/retry state, deduplicate exact work and recheck never clears it or retries work',async()=>{
 const r=receipt('quota_exhausted',{providerId:'claude',resetAt:'2026-10-24T01:00:00Z',recovery:'scheduled',nextRetryAt:'2026-10-24T01:00:00Z'});
 const message={text:'Retained',deliveryReceipts:[r]},h=harness([message,message]);
 h.render().find(n=>n.type===mui.ButtonBase).props.onClick();let nodes=h.render();
 assert.equal(nodes.filter(n=>n.type===Delivery).length,1);assert.match(nodes.map(text).join(' '),/Provider-reported reset/);
 await nodes.find(n=>n.type===mui.Button&&text(n)==='Recheck claude').props.onClick();await new Promise(setImmediate);nodes=h.render();
 assert.deepEqual(h.calls.map(c=>c[0]),['recheck','invalidate']);assert.equal(h.render().filter(n=>n.type===Delivery).length,1);assert.match(nodes.map(text).join(' '),/does not confirm that its usage allowance has reset/);
 const stopped=harness([{text:'Stopped',deliveryReceipts:[receipt('rate_limit',{recovery:'stopped'})]}]);assert.match(stopped.render().map(text).join(' '),/Automatic retries stopped/);
 const empty=harness([]);assert.match(empty.render().map(text).join(''),/working fallback/);assert.match(empty.render().map(text).join(''),/No active provider interruptions/);
});

test('UI014 shared broadcasts count affected deliveries, not duplicated user messages',()=>{
 const a=receipt('quota_exhausted'),b={...a,activationId:'another-work',targetAgentId:'another-agent'};
 const h=harness([{text:'One message to two agents',deliveryReceipts:[a,b]}]);
 const banner=h.render().find(node=>node.type===Banner);assert.match(text(banner),/2 deliveries/);assert.doesNotMatch(text(banner),/2 messages/);
});
