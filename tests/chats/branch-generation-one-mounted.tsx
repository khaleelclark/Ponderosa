// Deferred mounted source; not executed.
import {createRoot} from 'react-dom/client';
import {BranchGenerationOne} from '../../apps/web/src/components/branches/BranchGenerationOne';
const assert=(v:unknown,m:string)=>{if(!v)throw Error(m);};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,0));};
const button=(s:string)=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===s)!;
export async function generationOneRecoveryRegression(generation=1,historyKind:'serial'|'local_parallel'='serial'):Promise<void>{
 const host=document.createElement('div');document.body.append(host);let root=createRoot(host);const originalFetch=globalThis.fetch;
 const hash='a'.repeat(64),selection={executionId:'run',stepId:'step',generation:0,checkpointId:1,checkpointHash:hash,envelopeSha256:hash,intakeFence:{identity:'fence',sha256:hash},discloseTo:['current-ref']};
 const selections=Array.from({length:generation},(_,i)=>({...selection,generation:i,checkpointId:i+1,envelopeSha256:(i+1).toString(16).padStart(64,'0'),intakeFence:{identity:`fence${i}`,sha256:hash}}));
 const preview={historyKind,generation,consumedAttempts:generation+1,maxAttempts:33,reviewHash:hash,historicalReviewHash:hash,historicalPartition:selections};let posts=0,body:any,chosen:any,conflict=false;
 const storageKey='branch-generation-one:branch:run:step';const old=localStorage.getItem(storageKey);localStorage.removeItem(storageKey);
 const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{const url=String(input);
  if(init?.method==='POST'){posts++;body=JSON.parse(String(init.body));assert(body.expectedGeneration===generation&&body.expectedReviewHash===hash,'exact preview CAS');assert(JSON.parse(localStorage.getItem(storageKey)!).body.commandKey===body.commandKey,'persist before POST');throw Error('lost capture response');}
  if(url.endsWith('/generation-history-preview'))return conflict?json({error:'cut changed'},409):json(preview);
  if(url.endsWith('/generation-history-captures'))return json([{historyKind,consumedAttempts:generation+1,maxAttempts:33,retryBudget:{state:'verified',consumedAttempts:generation+1,maxAttempts:33,evidenceHash:hash},commandKey:'canonical',state:'retained',checkpointId:1000,checkpointHash:hash,restoreSupported:false,generation,reviewHash:hash,historicalReviewHash:hash,historicalPartition:selections}]);
  if(url.includes('/issued-checkpoint?'))return json({historyKind,consumedAttempts:generation+1,maxAttempts:33,retryBudget:{state:'verified',consumedAttempts:generation+1,maxAttempts:33,evidenceHash:hash},generation,commandKey:new URL(url,window.location.origin).searchParams.get('commandKey'),state:'retained',checkpointId:1000,checkpointHash:hash,restoreSupported:false,reviewHash:hash,historicalReviewHash:hash,historicalPartition:selections});
  throw Error('unexpected '+url);
 };
 const render=()=>root.render(<BranchGenerationOne branchId="branch" executionId="run" stepId="step" enabled onSelect={v=>{chosen=v;}}/>);
 try{
  render();await settle();button('Preview generation-history capture').click();await settle();assert(document.body.textContent?.includes(`consumed attempts ${generation+1}`)&&document.body.textContent?.includes('pinned maximum attempts 33'),'consumed attempts explicit');
  (host.querySelector('input[type=checkbox]') as HTMLInputElement).click();await settle();button('Confirm generation-history capture').click();await settle();button('Capture exact cut').click();await settle();assert(posts===1&&localStorage.getItem(storageKey),'unknown held without replay');assert(JSON.parse(localStorage.getItem(storageKey)!).preview.historyKind===historyKind,'classification saved before POST');
  root.unmount();root=createRoot(host);render();await settle();button('Inspect original capture outcome').click();await settle();assert(posts===1&&chosen?.capture.checkpointId===1000,'remount pure GET recovery');assert(chosen?.preview.consumedAttempts===generation+1&&chosen?.preview.maxAttempts===33,'saved pinned budget preserved');assert(!localStorage.getItem(storageKey),'exact retained status resolves original capture');
  conflict=true;button('Preview generation-history capture').click();await settle();assert(!button('Confirm generation-history capture')&&!chosen,'409 clears stale confirmation and preparation selection');assert(posts===1,'no mutation retry');
  button('Discover generation-history captures').click();await settle();button('Read exact capture for preparation').click();await settle();assert(chosen?.capture.commandKey==='canonical','empty-browser canonical discovery uses exact key');assert(chosen?.preview.maxAttempts===33&&chosen?.preview.historyKind===historyKind,'canonical classification and verified budget preserved');
 }finally{root.unmount();host.remove();globalThis.fetch=originalFetch;if(old===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,old);}
}

import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BranchDisclosureReview} from '../../apps/web/src/components/branches/BranchDisclosureReview';
export async function generationOnePreparationRegression(generation=1,historyKind:'serial'|'local_parallel'='serial'):Promise<void>{
 const host=document.createElement('div');document.body.append(host);let root=createRoot(host);const originalFetch=globalThis.fetch,client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const hash='a'.repeat(64),selection={executionId:'run',stepId:'step',generation:0,checkpointId:1,checkpointHash:hash,envelopeSha256:hash,intakeFence:{identity:'fence',sha256:hash},discloseTo:['current-ref']};
 const selections=Array.from({length:generation},(_,i)=>({...selection,generation:i,checkpointId:i+1,envelopeSha256:(i+1).toString(16).padStart(64,'0'),intakeFence:{identity:`fence${i}`,sha256:hash}}));
 const capture={historyKind,consumedAttempts:generation+1,maxAttempts:33,retryBudget:{state:'verified',consumedAttempts:generation+1,maxAttempts:33,evidenceHash:hash},generation,commandKey:'canonical capture',state:'retained',checkpointId:1000,checkpointHash:hash,restoreSupported:false,reviewHash:hash,historicalReviewHash:hash,historicalPartition:selections};
 const key='branch-disclosure-command:branch:run',old=localStorage.getItem(key);localStorage.removeItem(key);let posts=0,prepared:any,wrong=false;
 const result=()=>({commandKey:prepared.commandKey,admissionId:'admission',checkpointId:1000,checkpointHash:hash,state:'awaiting_disclosure',historicalPartition:wrong?selections.slice(0,-1):selections,destination:{projectId:'fresh-project',conversationId:'fresh-chat',executionId:'fresh-run',resourceStepId:'fresh-step',resourceGeneration:0},disclosure:{state:'unreviewed',revision:0}});
 const json=(v:unknown)=>new Response(JSON.stringify(v),{status:200,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{const url=String(input);
  if(init?.method==='POST'){posts++;prepared=JSON.parse(String(init.body));assert(prepared.historicalReviewHash===hash&&prepared.checkpointId===1000,'exact server historical hash and retained current cut');assert(!('historicalPartition' in prepared),'no human-constructed wire selection');const saved=JSON.parse(localStorage.getItem(key)!);assert(saved.generationOne.preview.historyKind===historyKind&&saved.generationOne.capture.historyKind===historyKind,'matching classification stored for preparation');assert(JSON.stringify(saved.generationOne.preview.historicalPartition)===JSON.stringify(selections),'whole original selection saved before preparation');throw Error('lost prepare response');}
  if(url.includes('/generation-history-captures'))return json([capture]);
  if(url.includes('/issued-checkpoint?'))return json(capture);
  if(url.includes('/historical-checkpoints'))return json([]);
  if(url.includes('/destinations?commandKey='))return json(result());
  if(url.endsWith('/destinations'))return json(prepared?[result()]:[]);
  throw Error('unexpected read '+url);
 };
 const render=()=>root.render(<QueryClientProvider client={client}><BranchDisclosureReview branchId="branch" executionId="run" resourceStepIds={['step']} enabled onChanged={()=>{}}/></QueryClientProvider>);
 try{
  render();await settle();button('Review fresh destination').click();await settle();button('Discover generation-history captures').click();await settle();button('Read exact capture for preparation').click();await settle();
  const details=Array.from(document.querySelectorAll('summary')).find(s=>s.textContent==='Prepare from saved checkpoint')!;details.click();await settle();
  const label=Array.from(document.querySelectorAll('label')).find(l=>l.textContent?.includes('I reconciled original external effects'))!;(label.querySelector('input') as HTMLInputElement).click();await settle();button('Prepare fresh destination').click();await settle();button('Prepare destination').click();await settle();assert(posts===1&&localStorage.getItem(key),'lost response held');
  root.unmount();root=createRoot(host);render();await settle();button('Review fresh destination').click();await settle();wrong=true;button('Inspect retained command').click();await settle();assert(Boolean(localStorage.getItem(key)),'wrong historical receipt cannot resolve original command');
  wrong=false;button('Inspect retained command').click();await settle();assert(!localStorage.getItem(key)&&posts===1,'exact pure GET resolves preparation without POST replay');
 }finally{root.unmount();host.remove();client.clear();globalThis.fetch=originalFetch;if(old===null)localStorage.removeItem(key);else localStorage.setItem(key,old);}
}

export async function generationHistoryBoundaryRegression():Promise<void>{
 for(const generation of [2,3,32]){await generationOneRecoveryRegression(generation);await generationOnePreparationRegression(generation);}
}

// Fork and one-item-map cuts have the same canonical classification and transport.
export async function localParallelHistoryRecoveryRegression():Promise<void>{
 for(const shape of ['fork/join','one-item map'])for(const generation of [1,2,32]){
  try{await generationOneRecoveryRegression(generation,'local_parallel');await generationOnePreparationRegression(generation,'local_parallel');}catch(error){throw Error(`${shape} generation ${generation}: ${String(error)}`);}
 }
}
