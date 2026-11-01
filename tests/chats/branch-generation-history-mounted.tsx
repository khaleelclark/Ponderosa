// Deferred mounted source; not executed.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BranchGenerationOne} from '../../apps/web/src/components/branches/BranchGenerationOne';
import {BranchDisclosureReview} from '../../apps/web/src/components/branches/BranchDisclosureReview';
const assert=(v:unknown,m:string)=>{if(!v)throw Error(m);};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,0));};
const button=(s:string)=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===s)!;
export async function generationHistoryDisclosureRegression():Promise<void>{
 for(const generation of [2,3,32]){
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host),originalFetch=globalThis.fetch,client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  const key='branch-disclosure-command:branch:source',old=localStorage.getItem(key);localStorage.removeItem(key);
  const hash=(i:number)=>i.toString(16).padStart(64,'0'),selections=Array.from({length:generation},(_,i)=>({executionId:'source',stepId:'step',generation:i,checkpointId:i+1,checkpointHash:hash(i+1),envelopeSha256:hash(i+100),intakeFence:{identity:`fence${i}`,sha256:hash(i+200)},discloseTo:['current-ref']}));
  const facts=selections.map(s=>({kind:'historical_generation',id:`fact${s.generation}`,sha256:hash(s.generation+300),originalAgentIds:[`old${s.generation}`],destinationAgentIds:['fresh-agent'],originalActor:{agentId:`old${s.generation}`},originalAudience:{projectId:`original-project${s.generation}`,agentIds:[`old${s.generation}`]}}));
  const content=facts.map((f,i)=>({...f,content:{seal:{identity:{executionId:'source',stepId:'step',generation:i,agentIds:f.originalAgentIds},checkpointId:selections[i].checkpointId,checkpointHash:selections[i].checkpointHash,envelopeSha256:selections[i].envelopeSha256,intakeFence:selections[i].intakeFence,receipt:{checkpointId:`package${i}`}},retirement:{resultJson:'original retirement'}}}));
  const destination={projectId:'fresh-project',conversationId:'fresh-chat',executionId:'fresh-run',resourceStepId:'fresh-step',resourceGeneration:0};let sent:any,bad=false;
  const summary={commandKey:'original prepare',admissionId:'admission',checkpointId:100,checkpointHash:hash(999),destination,historicalPartition:selections,state:'awaiting_disclosure',disclosure:{state:'unreviewed',revision:0}};
  const review=()=>({admissionId:'admission',reviewHash:hash(998),hostCutSha256:hash(997),policyRevision:'policy-current',revision:0,active:false,review:{admissionId:'admission',reservation:{branchId:'branch',sourceExecutionId:'source',checkpointId:100,checkpointHash:hash(999),destination,historicalPartition:selections,custody:{intent:{resourceGeneration:generation,resourceStepId:'step'}}},stage:{agentMap:{'current-ref':'fresh-agent'}},facts},facts:bad?content.slice(0,-1):content,policy:{restrictedCapabilityIds:['policy-current']}});
  const json=(v:unknown)=>new Response(JSON.stringify(v),{status:200,headers:{'content-type':'application/json'}});
  globalThis.fetch=async(input,init)=>{const url=String(input);if(init?.method==='POST'){sent=JSON.parse(String(init.body));throw Error('lost choice response');}if(url.includes('/historical-checkpoints'))return json([]);if(url.endsWith('/disclosure'))return json(review());if(url.endsWith('/destinations'))return json([summary]);if(url.includes('/review'))return json({error:'retirement not part of this fixture'});throw Error('unexpected '+url);};
  try{
   root.render(<QueryClientProvider client={client}><BranchDisclosureReview branchId="branch" executionId="source" enabled onChanged={()=>{}}/></QueryClientProvider>);await settle();button('Review fresh destination').click();await settle();(document.querySelector('[role=combobox]') as HTMLElement).click();await settle();(document.querySelector('[role=option]') as HTMLElement).click();await settle();
   bad=true;button('Preview disclosure').click();await settle();assert(!button('Approve disclosure'),'omitting last historical package/fact refuses whole review');
   bad=false;button('Preview disclosure').click();await settle();for(let i=0;i<generation;i++){assert(document.body.textContent?.includes(`Retired source generation ${i} · nondispatchable evidence`),'every prior generation labelled');assert(document.body.textContent?.includes(`package${i}`),'every original package visible');}
   assert(document.body.textContent?.includes('Current source package generation '+generation),'current source distinguished from destination generation zero');assert(button('Approve disclosure').disabled,'all-facts acknowledgement required');
   (Array.from(document.querySelectorAll('input[type=checkbox]')).find(v=>v.closest('label')?.textContent?.includes('exact historical facts')) as HTMLInputElement).click();await settle();button('Approve disclosure').click();await settle();button('Approve exact disclosure').click();await settle();assert(sent?.reviewHash===hash(998)&&sent?.action==='approve','single whole-history choice binds final human hash');assert(localStorage.getItem(key),'unknown choice remains held');
  }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;if(old===null)localStorage.removeItem(key);else localStorage.setItem(key,old);}
 }
}

export async function generationHistorySavedBudgetRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),originalFetch=globalThis.fetch;
 const key='branch-generation-one:branch:source:step',old=localStorage.getItem(key);localStorage.removeItem(key);
 const hash=(i:number)=>i.toString(16).padStart(64,'0');let selected:any,conflict=true;const calls:string[]=[];
 const row={historyKind:'local_parallel',generation:2,commandKey:'original/key',state:'retained',checkpointId:100,checkpointHash:hash(999),restoreSupported:false,reviewHash:hash(998),historicalReviewHash:hash(997),historicalPartition:[0,1].map(g=>({executionId:'source',stepId:'step',generation:g,checkpointId:g+1,checkpointHash:hash(g+1),envelopeSha256:hash(g+100),intakeFence:{identity:`fence${g}`,sha256:hash(g+200)},discloseTo:['current']})),consumedAttempts:3,maxAttempts:100,retryBudget:{state:'verified',consumedAttempts:3,maxAttempts:100,evidenceHash:hash(800)}};
 globalThis.fetch=async(input,init)=>{const url=String(input);calls.push(url);assert(!init?.method||init.method==='GET','recovery is pure GET');const value=url.endsWith('/generation-history-captures')?[row]:url.endsWith('/issued-checkpoint?commandKey=original%2Fkey')?{...row,historyKind:conflict?'serial':'local_parallel'}:undefined;assert(value,'no fresh preview or invented selector');return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});};
 try{
  root.render(<BranchGenerationOne branchId="branch" executionId="source" stepId="step" enabled onSelect={v=>{selected=v;}}/>);await settle();
  button('Discover generation-history captures').click();await settle();assert(document.body.textContent?.includes('consumed attempts 3'),'verified discovery numbers visible');assert(document.body.textContent?.includes(hash(800)),'saved evidence hash visible');
  button('Read exact capture for preparation').click();await settle();assert(!selected,'conflicting classification stays held');assert(!button('Read exact capture for preparation'),'stale inventory cleared');assert(calls.length===2,'no automatic retry');
  conflict=false;button('Discover generation-history captures').click();await settle();button('Read exact capture for preparation').click();await settle();assert(selected?.preview.consumedAttempts===3&&selected?.preview.maxAttempts===100,'exact saved budget reaches preparation');assert(selected.preview.retryBudget.evidenceHash===hash(800),'exact proof retained');assert(selected.preview.historyKind==='local_parallel','classification preserved for preparation');assert(selected.capture.checkpointId===100,'exact current checkpoint preserved');assert(calls.length===4,'only explicit GET recovery');
 }finally{root.unmount();host.remove();globalThis.fetch=originalFetch;if(old===null)localStorage.removeItem(key);else localStorage.setItem(key,old);}
}
