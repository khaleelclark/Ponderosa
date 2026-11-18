// Deferred mounted regression source; not executed.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {LifecycleDiscovery} from '../../apps/web/src/components/lifecycle/LifecycleDiscovery';
import {currentProductScope} from '../../apps/web/src/api/productScope';
import {groupAbandonmentStorageKey} from '../../apps/web/src/components/lifecycle/groupCaptureAbandonment';
const assert=(v:unknown,m:string)=>{if(!v)throw Error(m);};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text)!;
const acknowledge=async()=>{Array.from(document.querySelectorAll('label')).find(l=>l.textContent==='I reviewed every captured and uncaptured member, file inventory, revision and blocker; preserve all evidence')!.querySelector('input')!.click();await settle();};
export async function groupCaptureAbandonmentRegression():Promise<void>{
 const originalFetch=globalThis.fetch,host=document.createElement('div');document.body.append(host);let root=createRoot(host);
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}}),hash='a'.repeat(64),gets:string[]=[],posts:{url:string;body:any}[]=[];
 const entry={executionId:'source',captureKey:'issued-group-capture:'+hash,sourceOwner:'retained_only',state:'capturing',evidenceSha256:hash,capturedCheckpointIds:['package0'],sources:[0,1].map(i=>({checkpointId:`package${i}`,sourceChatId:`chat${i}`,agentIds:[`agent${i}`],intent:{executionId:'source',resourceStepId:`step${i}`,resourceGeneration:0,frontierSha256:hash,hostCutSha256:hash,bindingSha256:hash,configurationSha256:hash}}))};
 const key=groupAbandonmentStorageKey(window.location.origin,currentProductScope(),entry),saved=localStorage.getItem(key);localStorage.removeItem(key);
 let held=true,stalePage=false,ownerRemoved=false,fail=true;
 const review=()=>({executionId:entry.executionId,captureKey:entry.captureKey,groupId:hash,captureSha256:hash,branchRevision:hash,reviewSha256:hash,references:[],blockers:[],packages:entry.sources.map((source,i)=>({source,custodyId:String(i).repeat(64),state:i?'capturing':'retained',sourceAgentIds:source.agentIds,references:[],blockers:held&&i?['second member native exit missing']:[],reviewSha256:hash,files:i?[]:[{name:'original.payload',sha256:hash,byteLength:42}]}))});
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(init?.method==='POST'){
   const body=JSON.parse(String(init.body));posts.push({url,body});
   if(url.endsWith('/abandonment-review')){assert(!ownerRemoved,'recovery must not refresh a missing owner');assert(Object.keys(body).sort().join(',')==='captureKey,executionId','exact review identity');return json(review());}
   assert(url==='/api/lifecycle/checkpoint-capture-groups/abandon','no singular fallback');
   assert(localStorage.getItem(key)?.includes(body.commandKey),'persist whole-group command before POST');
   assert(Object.keys(body).sort().join(',')==='captureKey,commandKey,executionId,preserveEvidence,reviewSha256'&&body.preserveEvidence===true,'exact evidence-preserving body');
   if(fail){fail=false;return json({error:'All archives moved; final SQL commit failed'},409);}
   const r=review();return json({state:'abandoned',groupId:hash,commandKey:body.commandKey,reviewSha256:hash,captureArchiveSha256:hash,packages:r.packages.map(p=>({state:'reconciled',custodyId:p.custodyId,commandKey:body.commandKey,reviewSha256:hash,preservedBytes:p.files.reduce((n,f)=>n+f.byteLength,0),filesSha256:hash})),branch:{schema:'branch-group-custody-abandon.v1',state:'abandoned',input:{executionId:entry.executionId,captureKey:entry.captureKey,commandKey:body.commandKey,captureSha256:hash,expectedRevision:hash},sources:entry.sources,packageRetirements:r.packages.map(p=>({custodyId:p.custodyId,sourceSha256:hash,revision:hash})),originalCaptureRaw:'PRIVATE RAW SNAPSHOT',createdAt:'now'}});
  }
  gets.push(url);
  if(url.includes('/checkpoint-capture-groups?')){
   if(ownerRemoved)return json({items:[],revision:'after-owner-removal'});
   if(url.includes('cursor='))return stalePage?json({error:'Inventory changed'},409):json({items:[entry],revision:'groups'});
   return json({items:Array.from({length:50},(_,i)=>({...entry,captureKey:'issued-group-capture:'+i.toString(16).padStart(64,'0')})),revision:'groups',nextCursor:'opaque & cursor'});
  }
  return json({error:'Destination or unrelated lifecycle review unavailable'},409);
 };
 const render=()=>root.render(<QueryClientProvider client={client}><LifecycleDiscovery/></QueryClientProvider>);
 const select=async(captureKey=entry.captureKey)=>{(document.querySelectorAll('[role=combobox]')[0] as HTMLElement).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));await settle();(Array.from(document.querySelectorAll('[role=option]')).find(o=>o.textContent?.includes(captureKey)) as HTMLElement).click();await settle();};
 try{
  render();await settle();assert(gets.some(url=>url.includes('/checkpoint-capture-groups?')),'fourth inventory independent of destination failure');
  button('Load More whole-group capture intents').click();await settle();await select();button('Review Whole-Group Capture Abandonment').click();await settle();
  button('Refresh Whole-Group Abandonment Review').click();await settle();assert(button('Abandon Reviewed Whole-Group Capture').disabled,'second member hold blocks all');
  held=false;button('Refresh Whole-Group Abandonment Review').click();await settle();await acknowledge();button('Abandon Reviewed Whole-Group Capture').click();await settle();button('Confirm Whole-Group Abandonment').click();await settle();
  assert(Boolean(localStorage.getItem(key)),'FS/SQL409 retains original command');assert(posts.filter(p=>p.url.endsWith('/abandon')).length===1,'no automatic replay');
  button('Close').click();await settle();button('Restart whole-group capture intents').click();await settle();await select('issued-group-capture:'+'0'.repeat(64));stalePage=true;button('Load More whole-group capture intents').click();await settle();assert(!button('Review Whole-Group Capture Abandonment'),'cursor409 unmounts stale review and confirmation');
  ownerRemoved=true;root.unmount();root=createRoot(host);client.clear();render();await settle();button('Recover Retained Whole-Group Command').click();await settle();
  assert(document.body.textContent?.includes('1 captured / 1 uncaptured'),'all original member counts retained through remount');
  button('Recover Exact Whole-Group Command').click();await settle();button('Confirm Whole-Group Abandonment').click();await settle();
  const mutations=posts.filter(p=>p.url.endsWith('/abandon'));assert(mutations.length===2&&JSON.stringify(mutations[0].body)===JSON.stringify(mutations[1].body),'explicit recovery uses byte-identical original POST');
  assert(!localStorage.getItem(key),'only exact exhaustive receipt clears pending');assert(!document.body.textContent?.includes('PRIVATE RAW SNAPSHOT'),'raw Branch snapshot undisplayed');
  assert(document.body.textContent?.includes('disk space and history were not reclaimed'),'retained bytes do not claim disk reclamation');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;if(saved===null)localStorage.removeItem(key);else localStorage.setItem(key,saved);}
}
