import {openSelect} from '../shared/mounted-controls';
// Deferred regression source for the existing mounted browser harness; not executed.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BranchDisclosureReview} from '../../apps/web/src/components/branches/BranchDisclosureReview';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const settle=async()=>{for(let i=0;i<8;i++)await tick();};
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(item=>item.textContent===text)!;
export async function branchDisclosureReviewRegression():Promise<void>{
 const originalFetch=globalThis.fetch,host=document.createElement('div');document.body.append(host);
 const storageKey='branch-disclosure-command:branch:source-run',saved=localStorage.getItem(storageKey);localStorage.removeItem(storageKey);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const sent:{url:string;body:Record<string,unknown>}[]= [];
 const destination={projectId:'fresh-project',conversationId:'fresh-chat',executionId:'fresh-run',resourceStepId:'fresh-step',resourceGeneration:0};
 let state='awaiting_disclosure',disclosure={state:'unreviewed',revision:0,reviewHash:undefined as string|undefined},hash='review-1',previewUnavailable=false,composerKey='composer-key';
 const summary=()=>({commandKey:composerKey,admissionId:'canonical-admission',checkpointId:4,checkpointHash:'cut',destination,state,restoreSupported:state==='admitted',disclosure});
 const review=()=>({admissionId:'canonical-admission',reviewHash:hash,revision:disclosure.revision,state:disclosure.state,active:disclosure.state==='approved'&&disclosure.reviewHash===hash,policyRevision:'policy',hostCutSha256:'host-cut',review:{admissionId:'canonical-admission',reservation:{branchId:'branch',sourceExecutionId:'source-run',checkpointId:4,checkpointHash:'cut',destination,custody:{custodyId:'independent-custody'}},stage:{agentMap:{original:'fresh'},artifactMap:{}},facts:[{kind:'communication',id:'fact',sha256:'fact-hash',originalAgentIds:['original'],destinationAgentIds:['fresh'],originalAudience:{kind:'private',agentIds:['original']},originalActor:{agentId:'original'}}]},facts:[{kind:'communication',id:'fact',sha256:'fact-hash',originalAgentIds:['original'],destinationAgentIds:['fresh'],originalAudience:{kind:'private',agentIds:['original']},originalActor:{agentId:'original'},content:{text:'Exact original private fact'}}],policy:{revision:'current'}});
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{
  const url=String(input),method=init?.method??'GET';
  if(method==='POST'){
   const body=JSON.parse(String(init?.body));assert(localStorage.getItem(storageKey),'persist full input before any effect');sent.push({url,body});
   if(body.checkpointId){composerKey=body.commandKey;state='awaiting_disclosure';throw new TypeError('Preparation response lost');}
   if(url.endsWith('/admit')){state='admitted';throw new TypeError('Admission response lost');}
   if(body.action==='approve'){
    if(sent.filter(item=>item.body.action==='approve').length===1){hash='review-2';return json({error:'Policy changed'},409);}
    disclosure={state:'revoked',revision:2,reviewHash:hash};throw new TypeError('Approval response lost; concurrently revoked');
   }
   disclosure={state:'revoked',revision:disclosure.revision+1,reviewHash:body.reviewHash};
   return json({admissionId:'canonical-admission',commandKey:body.commandKey,action:'revoke',reviewHash:body.reviewHash,revision:disclosure.revision,state:'revoked',active:false});
  }
  if(url.endsWith('/historical-checkpoints'))return json([{id:4,branchId:'branch',executionId:'source-run',contentHash:'cut',restoreSupported:false,eligibility:'unsupported_dependency'}]);
  if(url.includes('/disclosure?commandKey=')){
   const choice=[...sent].reverse().find(item=>item.body.action==='approve')!.body;
   return json({admissionId:'canonical-admission',commandKey:choice.commandKey,action:'approve',reviewHash:choice.reviewHash,revision:Number(choice.expectedRevision)+1,state:'approved',active:false});
  }
  if(url.endsWith('/disclosure'))return previewUnavailable?json({error:'Custody bytes unavailable'},409):json(review());
  if(url.includes('/destinations?commandKey='))return json(summary());
  if(url.endsWith('/destinations'))return json([summary()]);
  throw Error(`Unexpected call ${url}`);
 };
 const render=(key:string)=>root.render(<QueryClientProvider client={client}><BranchDisclosureReview key={key} branchId="branch" executionId="source-run" enabled onChanged={()=>{}}/></QueryClientProvider>);
 const select=async()=>{openSelect(document.querySelector('[role=combobox]'));await tick();(Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent?.includes('fresh-chat')) as HTMLElement).click();await tick();};
 const acknowledge=async()=>{(Array.from(document.querySelectorAll('input[type=checkbox]')).find(item=>item.closest('label')?.textContent?.includes('exact historical facts')) as HTMLInputElement).click();await tick();};
 try{
  render('initial');await settle();button('Review Fresh Destination').click();await settle();await select();button('Preview Disclosure').click();await settle();
  assert(sent.length===0,'discovery/preview cannot approve, import or activate');
  assert(document.body.textContent?.includes('Exact original private fact')&&document.body.textContent?.includes('fresh recipients: fresh'),'exact fact, original scope and new recipients remain reviewable');
  await acknowledge();button('Approve Disclosure').click();await tick();button('Approve Exact Disclosure').click();await settle();
  assert(sent.length===1,'409 never auto-approves');assert(!button('Approve Disclosure')||(button('Approve Disclosure') as HTMLButtonElement).disabled,'stale review loses acknowledgement');
  assert(localStorage.getItem(storageKey),'409 preserves original choice for pure readback');button('Inspect Retained Command').click();await settle();assert(sent.length===1&&!localStorage.getItem(storageKey),'only matching GET receipt resolves held choice');
  button('Preview Disclosure').click();await settle();await acknowledge();button('Approve Disclosure').click();await tick();button('Approve Exact Disclosure').click();await settle();
  assert(localStorage.getItem(storageKey),'lost response retains exact choice');
  render('remount');await settle();button('Review Fresh Destination').click();await settle();button('Inspect Retained Command').click();await settle();
  assert(sent.length===2,'pure lost-response lookup cannot replay approval');
  assert(document.body.textContent?.includes('currently active false'),'old approved receipt is explicitly inactive');
  assert(localStorage.getItem(storageKey)===null,'exact choice receipt resolves only that command');
  await select();assert((button('Revoke Disclosure') as HTMLButtonElement).disabled,'revoked persisted choice is never revived from an old approval receipt');
  disclosure={state:'approved',revision:3,reviewHash:'persisted-current'};previewUnavailable=true;button('Refresh Destinations').click();await settle();
  button('Preview Disclosure').click();await settle();assert(document.body.textContent?.includes('Custody bytes unavailable'),'show unavailable preview');
  button('Revoke Disclosure').click();await tick();button('Revoke Exact Choice').click();await settle();
  assert(sent[2].body.reviewHash==='persisted-current'&&sent[2].body.expectedRevision===3,'revocation uses canonical persisted choice without bytes');
  previewUnavailable=false;hash='current-admit';disclosure={state:'approved',revision:5,reviewHash:hash};button('Refresh Destinations').click();await settle();button('Preview Disclosure').click();await settle();await acknowledge();
  button('Admit Reviewed Destination').click();await tick();button('Admit Destination').click();await settle();
  assert(sent[3].body.commandKey==='composer-key'&&sent[3].body.reviewHash==='current-admit','admission uses canonical composer key and fresh current human hash');
  button('Inspect Retained Command').click();await settle();assert(sent.length===4&&localStorage.getItem(storageKey)===null,'lost admission response reads canonical receipt without another activation effect');
  (Array.from(document.querySelectorAll('summary')).find(item=>item.textContent==='Prepare From Saved Checkpoint') as HTMLElement).click();await tick();
  openSelect(document.querySelectorAll('[role=combobox]')[1]);await tick();
  (Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent==='4 · cut') as HTMLElement).click();await tick();
  (Array.from(document.querySelectorAll('input[type=checkbox]')).find(item=>item.closest('label')?.textContent?.includes('reconciled original external effects')) as HTMLInputElement).click();await tick();
  button('Prepare Fresh Destination').click();await tick();button('Prepare Destination').click();await settle();
  assert(sent[4].body.checkpointId===4&&sent[4].body.expectedHash==='cut'&&sent[4].body.reconcileEffects===true,'prepare selects immutable retained checkpoint and explicit effects reconciliation');
  assert(localStorage.getItem(storageKey),'lost preparation response retains full original input');
  button('Inspect Retained Command').click();await settle();assert(sent.length===5&&localStorage.getItem(storageKey)===null,'preparation lookup discovers staged canonical admission without another import');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;if(saved===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,saved);}
}
