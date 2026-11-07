import {openSelect} from '../shared/mounted-controls';
// Deferred browser regression source; run only in the existing mounted harness.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BranchResourceReview} from '../../apps/web/src/components/branches/BranchResourceReview';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const settle=async()=>{for(let i=0;i<6;i++)await tick();};
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(item=>item.textContent===text)!;
export async function branchResourceReviewRegression():Promise<void>{
 const originalFetch=globalThis.fetch,host=document.createElement('div');document.body.append(host);
 const storageKey='branch-resource-release:branch:run:step',saved=localStorage.getItem(storageKey);localStorage.removeItem(storageKey);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const deletes:Record<string,unknown>[]=[],choices:Record<string,unknown>[]=[],reads:string[]=[];
 let generation=3,hash='policy-1',referenced=false,choiceRecorded=false;
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 const receipt=()=>({commandKey:deletes[0].commandKey,stepExecutionId:'step',generation:3,custodyId:'custody',receiptSha256:'receipt',state:'releasing'});
 globalThis.fetch=async(input,init)=>{
  const url=String(input),method=init?.method??'GET';
  if(method==='DELETE'){
   assert(localStorage.getItem(storageKey)===String(init?.body),'persist exact release input before deletion');deletes.push(JSON.parse(String(init?.body)));
   if(referenced)return json({error:'Retained checkpoint custody is referenced by a restored resource'},409);
   if(deletes.length===1)throw new TypeError('Response lost');return json({...receipt(),state:'released'});
  }
  if(method==='POST'){
   choices.push(JSON.parse(String(init?.body)));if(choices.length===1){hash='policy-2';return json({error:'Current policy changed'},409);}choiceRecorded=true;return json({reviewSha256:hash,source:[],destination:{restrictedCapabilityIds:[]}});
  }
  reads.push(url);
  if(url.includes('/checkpoint-custody?'))return json(receipt());
  assert(!url.endsWith('/access-review'),'never inspect using the legacy journal-writing GET');
  return json({branchId:'branch',executionId:'run',stepExecutionId:'step',generation,state:'reserved',destinationChatId:'actual-chat',destinationChatAvailable:true,importState:null,custody:{kind:'capture',state:'retained',custodyId:'custody',receiptSha256:'receipt',checkpointId:'cut',packageSha256:'package'},accessChoiceCurrent:choiceRecorded,currentPolicyReview:{reviewSha256:hash,source:[{ref:'agent',settings:{restrictedCapabilityIds:['capability']}}],destination:{restrictedCapabilityIds:[]}}});
 };
 const render=(key:string,enabled=true)=>root.render(<QueryClientProvider client={client}><BranchResourceReview key={key} branchId="branch" executionId="run" stepId="step" enabled={enabled} onChanged={()=>{}}/></QueryClientProvider>);
 const choose=async()=>{openSelect(document.querySelector('[role=combobox]'));await tick();(Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent==='Apply source restrictions') as HTMLElement).click();await tick();};
 try{
  render('initial');await settle();button('Review resource').click();await settle();
  assert(document.body.textContent?.includes('actual-chat')&&document.body.textContent?.includes('Generation 3'),'show actual destination and generation');
  assert(choices.length===0&&deletes.length===0,'inspection cannot apply or release');
  const restrictions=document.querySelector('[role=combobox]')!;
  assert(restrictions.getAttribute('aria-required')==='true'&&document.getElementById(restrictions.getAttribute('aria-describedby')??'')?.textContent==='Choose restrictions to continue.','per-Agent restrictions expose the required choice and its help');
  assert(button('Confirm restrictions').disabled&&document.body.textContent?.includes('Select restrictions above before confirming.'),'disabled confirmation identifies the missing choice');
  await choose();assert(!document.body.textContent?.includes('Select restrictions above before confirming.'),'explicit selection clears missing-choice hint');button('Confirm restrictions').click();await tick();button('Apply restrictions').click();await settle();
  assert(choices.length===1,'409 cannot retry access choice');assert((button('Confirm restrictions') as HTMLButtonElement).disabled,'fresh policy requires fresh choice');
  await choose();button('Confirm restrictions').click();await tick();button('Apply restrictions').click();await settle();
  assert(choices[1].reviewSha256==='policy-2','fresh choice uses refreshed opaque policy hash');
  assert(!document.body.textContent?.includes('Choose restrictions to continue.')&&!document.body.textContent?.includes('Select restrictions above before confirming.')&&document.querySelector('[role=combobox]')?.getAttribute('aria-required')!=='true','recorded restrictions do not ask for a new choice');
  button('Release retained checkpoint').click();await tick();button('Release checkpoint').click();await settle();
  assert(deletes.length===1&&localStorage.getItem(storageKey),'lost response retains input without retry');
  generation=4;render('remounted');await settle();button('Review resource').click();await settle();
  assert((button('Retry exact release') as HTMLButtonElement).disabled,'remount requires pure command inspection');
  button('Inspect release outcome').click();await settle();assert(deletes.length===1,'command inspection never deletes');
  button('Retry exact release').click();await tick();button('Release checkpoint').click();await settle();
  assert(JSON.stringify(deletes[0])===JSON.stringify(deletes[1]),'retry preserves original generation, receipt and key after generation changes');
  assert(localStorage.getItem(storageKey)===null,'only exact released receipt clears retained input');
  referenced=true;button('Release retained checkpoint').click();await tick();button('Release checkpoint').click();await settle();
  assert(document.body.textContent?.includes('referenced by a restored resource'),'surface exact referenced-custody refusal');
  assert(deletes.length===3,'referenced refusal never retries automatically');
  choiceRecorded=false;client.clear();render('read-only',false);await settle();button('Review resource').click();await settle();
  assert(!document.body.textContent?.includes('Choose restrictions to continue.')&&!document.body.textContent?.includes('Select restrictions above before confirming.')&&document.querySelector('[role=combobox]')?.getAttribute('aria-required')!=='true','read-only review does not ask for an unavailable choice');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;if(saved===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,saved);}
}

export async function expertCopyAccessReviewRegression():Promise<void>{
 const originalFetch=globalThis.fetch,host=document.createElement('div');document.body.append(host);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const posts:any[]=[];let hash='copy-policy-1',snapshot='a'.repeat(64),consentCurrent=false,wrongCopy=false,sourceMemoryAvailable=true;
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(_input,init)=>{
  if(init?.method==='POST'){
   posts.push(JSON.parse(String(init.body)));
   if(posts.length===1){hash='copy-policy-2';snapshot='b'.repeat(64);return json({error:'Source snapshot changed'},409);}
   consentCurrent=true;return json({reviewSha256:hash,source:[],destination:{restrictedCapabilityIds:[]}});
  }
  return json({branchId:'branch',executionId:'run',stepExecutionId:'copy-step',generation:1,state:'reserved',destinationChatId:'copy-chat',destinationChatAvailable:true,accessChoiceCurrent:consentCurrent,
   expertCopyReview:{sourceAgentId:'original-expert',sourceChatId:'original-chat',copyChatId:wrongCopy?'other-chat':'copy-chat',snapshotSha256:snapshot,sourceMemoryAvailable,reviewWithoutMemorySha256:'c'.repeat(64),consentCurrent,copySourceMemory:consentCurrent&&posts.at(-1)?.copySourceMemory===true,allowFindingsWriteback:consentCurrent&&posts.at(-1)?.allowFindingsWriteback===true},
   currentPolicyReview:{reviewSha256:hash,source:[],destination:{restrictedCapabilityIds:['unchanged-restriction']}}});
 };
 const render=(key:string)=>root.render(<QueryClientProvider client={client}><BranchResourceReview key={key} branchId="branch" executionId="run" stepId="copy-step" enabled onChanged={()=>{}}/></QueryClientProvider>);
 const check=(text:string)=>Array.from(document.querySelectorAll('label')).find(label=>label.textContent?.includes(text))?.querySelector('input') as HTMLInputElement;
 const choose=async()=>{openSelect(document.querySelector('[role=combobox]'));await tick();(Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent==='Keep destination restrictions') as HTMLElement).click();await settle();};
 try{
  render('first');await settle();button('Review resource').click();await settle();
  assert(!check('Copy the original Agent').checked&&!check('Allow this copy').checked,'both memory choices default off');
  const restrictions=document.querySelector('[role=combobox]')!;
  assert(restrictions.getAttribute('aria-required')==='true'&&document.getElementById(restrictions.getAttribute('aria-describedby')??'')?.textContent==='Choose restrictions to continue.','single restrictions choice is required independently of optional memory');
  assert(button('Confirm copy access').disabled&&document.body.textContent?.includes('Select restrictions above before confirming.'),'copy confirmation explains the missing restrictions choice');
  assert(document.body.textContent?.includes('do not grant Global Memory, browser access, or other capabilities'),'actual scope is disclosed');
  assert(document.body.textContent?.includes('each later copy needs its own memory-copy approval'),'future copies require separate approval');
  assert(document.body.textContent?.includes('source working-folder files are not copied'),'fresh workspace limitation is disclosed before approval');
  await choose();check('Allow this copy').click();await settle();
  assert(!button('Confirm copy access').disabled,'findings approval is independent of inherited memory');
  button('Confirm copy access').click();await settle();
  assert(posts.length===0,'approval is explicit and separate from selection');button('Approve copy').click();await settle();
  assert(posts.length===1,'stale approval never automatically retries');
  assert(posts[0].copySourceMemory===false&&posts[0].allowFindingsWriteback===true,'independent opt-ins are sent explicitly');
  assert(posts[0].snapshotSha256==='a'.repeat(64)&&posts[0].accessSettingsResolution.reviewSha256==='c'.repeat(64),'bind exact source snapshot and current policy');
  assert(posts[0].accessSettingsResolution.action==='keep_destination','memory approval does not apply source capabilities');
  assert(!check('Copy the original Agent').checked&&!check('Allow this copy').checked,'changed snapshot requires fresh unchecked choices');
  await choose();check('Copy the original Agent').click();await settle();button('Confirm copy access').click();await settle();button('Approve copy').click();await settle();
  assert(posts.length===2&&posts[1].copySourceMemory===true&&posts[1].allowFindingsWriteback===false,'findings remain independently optional');
  assert(posts[1].snapshotSha256==='b'.repeat(64)&&posts[1].accessSettingsResolution.reviewSha256==='copy-policy-2','fresh approval uses exact refreshed evidence');
  assert(button('Confirm copy access').disabled,'recorded consent cannot be resubmitted as fresh approval');
  assert(!document.body.textContent?.includes('Choose restrictions to continue.')&&!document.body.textContent?.includes('Select restrictions above before confirming.')&&document.querySelector('[role=combobox]')?.getAttribute('aria-required')!=='true','recorded copy approval does not show a missing-choice prompt');
  assert(check('Copy the original Agent').checked&&!check('Allow this copy').checked,'readback shows actual recorded independent consent');
  consentCurrent=false;sourceMemoryAvailable=false;client.clear();render('without-memory');await settle();button('Review resource').click();await settle();
  assert(check('Copy the original Agent').disabled&&check('Allow this copy').disabled,'unavailable memory cannot be opted into');
  await choose();assert(!button('Confirm copy access').disabled,'copy proceeds without Local Memory');button('Confirm copy access').click();await settle();button('Approve copy').click();await settle();
  assert(posts.length===3&&!posts[2].copySourceMemory&&!posts[2].allowFindingsWriteback&&posts[2].accessSettingsResolution.reviewSha256==='c'.repeat(64),'no-memory approval binds its exact reviewed package');
  wrongCopy=true;client.clear();render('mismatch');await settle();button('Review resource').click();await settle();
  assert(document.body.textContent?.includes('Resource identity changed'),'mismatched temporary Chat cannot be approved');
  assert(posts.length===3,'inspection mismatch has no mutation');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;}
 await copyApprovalFeedback();
}

export async function temporaryCopyTraceRegression():Promise<void>{
 const originalFetch=globalThis.fetch,host=document.createElement('div');document.body.append(host);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 let reads=0,writes=0,denied=false,wrong=false,available=true;
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{
  if(init?.method&&init.method!=='GET')writes++;
  if(String(input).endsWith('/copy-history')){reads++;if(denied)return json({error:'Current access no longer permits retained history'},403);return json({sourceAgentId:'original',copyAgentId:wrong?'another-copy':'copy',requestId:'request',messages:[{agentId:'copy',title:'Temporary Agent',role:'assistant',text:'Retained response after cleanup'}],runs:[{agentId:'copy',id:'retained-run',status:'completed',created_at:'2026-11-05T01:00:00Z',started_at:null,terminal_at:null},{agentId:'copy',id:'retained-timed-run',status:'completed',created_at:'2026-11-05T01:00:00Z',started_at:'2026-11-05T01:00:01Z',terminal_at:'2026-11-05T01:00:02Z'}],events:[{agentId:'copy',seq:7,ts:'2026-11-05T01:00:01Z',event:{type:'response',text:'Ordered retained work log'}},{agentId:'copy',seq:8,ts:'2026-11-05T01:00:02Z',event:{type:'completion',text:'After response'}}]});}
  return json({branchId:'branch',executionId:'run',stepExecutionId:'trace-step',generation:1,state:'retired',destinationChatId:'deleted-chat',destinationChatAvailable:false,accessChoiceCurrent:false,temporaryCopyTrace:{sourceAgentId:'original',sourceChatId:'source-chat',copyAgentId:'copy',copyChatId:'deleted-chat',requestId:'request',attemptId:'attempt',task:{instructions:'Inspect the report',input:'Original exact task input'},result:{output:'Recorded exact result'},historyAvailable:available}});
 };
 try{
  root.render(<QueryClientProvider client={client}><BranchResourceReview branchId="branch" executionId="run" stepId="trace-step" enabled onChanged={()=>{}}/></QueryClientProvider>);await settle();button('Review resource').click();await settle();
  assert(document.body.textContent?.includes('Original exact task input')&&document.body.textContent?.includes('Recorded exact result'),'task and result survive deleted Chat');
  assert(document.body.textContent?.includes('Source Agent original')&&document.body.textContent?.includes('Request request'),'source and request remain inspectable');
  const details=(title:string)=>Array.from(document.querySelectorAll('details')).find(item=>item.querySelector('summary')?.textContent===title)!;
  assert(!details('Resource identifiers').open&&!details('Copy identifiers').open,'ordinary identifiers do not precede the task as expanded technical text');
  // Closed native details can retain layout rectangles while suppressing paint.
  const result=details('View structured result');assert(!result.open&&!result.querySelector('pre')!.checkVisibility(),'structured result starts behind its labeled disclosure');
  result.querySelector('summary')!.click();await tick();assert(result.open&&result.querySelector('pre')!.checkVisibility()&&result.textContent?.includes('Recorded exact result'),'structured result remains deliberately inspectable');
  assert(reads===0,'history is only fetched deliberately');button('View retained history').click();await settle();
  assert(document.body.textContent?.includes('Retained response after cleanup')&&document.body.textContent?.includes('retained-run'),'retained messages and Run record render');
  assert(document.body.textContent?.includes('Retained Runs (2)')&&document.body.textContent?.includes('Run 1 · completed')&&document.body.textContent?.includes(`Started ${new Date('2026-11-05T01:00:01Z').toLocaleString()}`)&&document.body.textContent?.includes(`Finished ${new Date('2026-11-05T01:00:02Z').toLocaleString()}`),'retained Run status and times are readable without expanding JSON');
  const untimedRun=Array.from(document.querySelectorAll('p')).find(item=>item.textContent==='Run 1 · completed')!.parentElement!;
  assert(untimedRun.textContent?.includes('Created')&&!untimedRun.textContent?.includes('Started')&&!untimedRun.textContent?.includes('Finished'),'nullable Run times are omitted rather than invented');
  assert(!details('Retained Run history').open,'raw Run records remain available without dominating the summary');assert(document.body.textContent!.indexOf('Ordered retained work log')<document.body.textContent!.indexOf('After response'),'provider event order remains intact');
  denied=true;button('View retained history').click();await settle();assert(document.body.textContent?.includes('Current access no longer permits'),'revoked history reports current denial');assert(!document.body.textContent?.includes('Retained response after cleanup'),'revoked cache is not shown');
  denied=false;wrong=true;button('View retained history').click();await settle();assert(document.body.textContent?.includes('Retained history identity changed'),'foreign history is refused');assert(!document.body.textContent?.includes('Retained response after cleanup'),'foreign history is not displayed');
  available=false;button('Refresh current scope').click();await settle();assert(document.body.textContent?.includes('Retained history is unavailable'),'missing custody does not promise history');
  assert(writes===0,'all trace interactions are read only');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;}
}


async function copyApprovalFeedback():Promise<void>{
 for(const mode of ['success','unconfirmed','unavailable'] as const){
  const originalFetch=globalThis.fetch,host=document.createElement('div');document.body.append(host);
  const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  let posts=0,afterReads=0,changed=0,destructiveFlash=false;const bodies:any[]=[];
  const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  const wait=async(read:()=>boolean)=>{const deadline=Date.now()+4000;while(Date.now()<deadline){if(read())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Copy feedback did not settle: '+mode);};
  const snapshot='a'.repeat(64),policy='b'.repeat(64);
  globalThis.fetch=async(_input,init)=>{
   if(init?.method==='POST'){posts++;bodies.push(JSON.parse(String(init.body)));if(mode==='unconfirmed')throw new TypeError('Known unconfirmed response');return json({reviewSha256:policy,source:[],destination:{restrictedCapabilityIds:[]}});}
   if(posts){afterReads++;if(mode!=='success'||afterReads<=2)return json({error:'Resource inspection changed; refresh'},409);}
   return json({branchId:'branch',executionId:'run',stepExecutionId:'feedback-step',generation:1,state:'reserved',destinationChatId:'destination-with-long-identifier',destinationChatAvailable:true,accessChoiceCurrent:posts>0,expertCopyReview:{sourceAgentId:'selected-source',sourceChatId:'source-chat',copyChatId:'destination-with-long-identifier',snapshotSha256:snapshot,sourceMemoryAvailable:false,reviewWithoutMemorySha256:policy,consentCurrent:posts>0,copySourceMemory:false,allowFindingsWriteback:false},currentPolicyReview:{reviewSha256:policy,source:[],destination:{restrictedCapabilityIds:['existing-restriction']}}});
  };
  const observer=new MutationObserver(()=>{if(document.body.textContent?.includes('Permanently removes retained package bytes'))destructiveFlash=true;});
  try{
   root.render(<QueryClientProvider client={client}><BranchResourceReview branchId="branch" executionId="run" stepId="feedback-step" enabled onChanged={()=>{changed++;}}/></QueryClientProvider>);await settle();button('Review resource').click();await settle();
   openSelect(document.querySelector('[role=combobox]'));await tick();(Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent==='Keep destination restrictions') as HTMLElement).click();await settle();button('Confirm copy access').click();await settle();
   assert(document.body.textContent?.includes('Run this workflow job in a temporary copy of the selected Agent.'),'confirmation explains the one-job action');
   assert(document.body.textContent?.includes('Copy private/team memory: No')&&document.body.textContent?.includes('Save private findings for later copies: No'),'confirmation shows both independent choices plainly');
   const details=Array.from(document.querySelectorAll('details')).find(item=>item.querySelector('summary')?.textContent==='Approval identifiers and hashes')!;
   assert(details&&!details.open&&!details.querySelector('p')!.checkVisibility(),'opaque approval binding is secondary, not a clipped primary instruction');
   details.querySelector('summary')!.click();await tick();assert(details.open&&details.textContent?.includes(snapshot)&&details.textContent.includes(policy)&&details.textContent.includes('selected-source'),'full frozen source/snapshot/policy remain inspectable');
   assert(getComputedStyle(details.querySelector('p')!).overflowWrap==='anywhere','technical values wrap on a narrow display');
   observer.observe(document.body,{subtree:true,childList:true,characterData:true});button('Approve copy').click();
   if(mode==='success'){
    await wait(()=>document.body.textContent?.includes('Copy approved. Current progress is shown below.')===true);
    assert(afterReads===3,'only the known successful transition receives two bounded GET retries');assert(!document.body.textContent?.includes('Resource inspection changed; refresh'),'success reconciles its own transitional read error');
    button('View Run progress').click();await settle();assert(changed>=2,'current progress action refreshes the owning Run without resubmitting');
   }else if(mode==='unconfirmed'){
    await wait(()=>document.body.textContent?.includes('Access choice unconfirmed. Known unconfirmed response')===true);await new Promise(resolve=>setTimeout(resolve,300));
    assert(afterReads===1,'unknown approval outcome does not enable success-only GET retries');assert(!document.body.textContent?.includes('Copy approved.'),'unknown outcome is not relabeled successful');assert(document.body.textContent?.includes('Resource inspection changed; refresh'),'actual read failure remains actionable');
   }else{
    await wait(()=>document.body.textContent?.includes('Current progress could not be loaded; refresh current scope.')===true);await new Promise(resolve=>setTimeout(resolve,300));
    assert(afterReads===3,'persistent transitional reads stop after the bounded retries');assert(document.body.textContent?.includes('Resource inspection changed; refresh'),'unresolved cause remains visible beside the qualified approval acknowledgment');
   }
   assert(posts===1,'feedback reconciliation never repeats the approval POST');assert(!destructiveFlash,'approval dismissal never changes into checkpoint destruction');
   assert(bodies[0].snapshotSha256===snapshot&&bodies[0].accessSettingsResolution.reviewSha256===policy&&bodies[0].accessSettingsResolution.action==='keep_destination'&&!bodies[0].copySourceMemory&&!bodies[0].allowFindingsWriteback,'submitted approval retains the exact inspected binding and independent false flags');
  }finally{observer.disconnect();root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;}
 }
}

export async function temporaryCopyActionHistoryRegression():Promise<void>{
 const originalFetch=globalThis.fetch,host=document.createElement('div');document.body.append(host);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});let legacy=false,writes=0;
 const requestId='operator-request-'+('a'.repeat(120)),createdAt='2026-11-07T13:00:00.000Z';
 globalThis.fetch=async(_input,init)=>{
  if(init?.method&&init.method!=='GET')writes++;
  return new Response(JSON.stringify({branchId:'branch',executionId:'run',stepExecutionId:'audit-step',generation:0,state:'retired',destinationChatId:'deleted-chat',destinationChatAvailable:false,importState:'completed',custody:null,currentPolicyReview:null,accessChoiceCurrent:false,
   temporaryCopyActions:{approvals:[legacy?{action:'keep_destination',copySourceMemory:false,allowFindingsWriteback:false}:{actor:{kind:'user',id:'local-operator'},origin:'operator_api',requestId,createdAt,reason:'run_reviewed_temporary_copy',action:'keep_destination',copySourceMemory:false,allowFindingsWriteback:false}],
    retirement:{checkpointId:42,createdAt,...(legacy?{}:{provenance:{actor:{kind:'system',id:'ponderosa'},origin:'resource_cleanup',reason:'no_active_work_and_cleanup_completed'}})}}}),{status:200,headers:{'content-type':'application/json'}});
 };
 const render=(key:string)=>root.render(<QueryClientProvider client={client}><BranchResourceReview key={key} branchId="branch" executionId="run" stepId="audit-step" enabled onChanged={()=>{}}/></QueryClientProvider>);
 try{
  render('recorded');await settle();button('Review resource').click();await settle();
  const history=document.querySelector('[aria-label="Copy action history"]')!;
  assert(history.textContent?.includes('Approved by: You (local operator)')&&history.textContent?.includes('Actor: Ponderosa (system)'),'actual recorded operator and system roles are distinct');
  assert(history.textContent?.includes('Run this workflow job in the reviewed temporary Agent copy.')&&history.textContent?.includes('No active work remained and temporary resource cleanup completed.'),'both recorded reasons are plain');
  assert(history.textContent?.includes('Keep destination restrictions')&&history.textContent?.includes('Copy private/team memory: No'),'the actual choices remain inspectable');
  const details=Array.from(history.querySelectorAll('details')).find(d=>d.querySelector('summary')?.textContent==='Approval details')!;
  const id=details.querySelector('span')??details.querySelector('p');assert(!details.open&&!id!.checkVisibility(),'technical request identity starts behind a disclosure');
  details.querySelector('summary')!.click();await tick();assert(details.open&&id!.checkVisibility()&&details.textContent?.includes(requestId),'the full operator request remains inspectable');
  const bounds=history.getBoundingClientRect();assert(bounds.left>=0&&bounds.right<=window.innerWidth+1,'action facts stay inside the phone/desktop viewport');
  legacy=true;client.clear();render('legacy');await settle();button('Review resource').click();await settle();
  const old=document.querySelector('[aria-label="Copy action history"]')!;
  assert(old.textContent?.includes('Approved by: Not recorded')&&old.textContent?.includes('Recorded: Not recorded')&&old.textContent?.includes('Actor: Not recorded')&&old.textContent?.includes('Reason: Not recorded'),'legacy data is never backfilled with guessed provenance');
  assert(!old.textContent?.includes('You (local operator)')&&!old.textContent?.includes(requestId),'new action provenance is not carried into an older record');
  assert(writes===0,'opening both audit records never approves, applies, releases or replays work');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;}
}
