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
 const render=(key:string)=>root.render(<QueryClientProvider client={client}><BranchResourceReview key={key} branchId="branch" executionId="run" stepId="step" enabled onChanged={()=>{}}/></QueryClientProvider>);
 const choose=async()=>{openSelect(document.querySelector('[role=combobox]'));await tick();(Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent==='Apply source restrictions') as HTMLElement).click();await tick();};
 try{
  render('initial');await settle();button('Review resource').click();await settle();
  assert(document.body.textContent?.includes('actual-chat')&&document.body.textContent?.includes('Generation 3'),'show actual destination and generation');
  assert(choices.length===0&&deletes.length===0,'inspection cannot apply or release');
  await choose();button('Confirm restrictions').click();await tick();button('Apply restrictions').click();await settle();
  assert(choices.length===1,'409 cannot retry access choice');assert((button('Confirm restrictions') as HTMLButtonElement).disabled,'fresh policy requires fresh choice');
  await choose();button('Confirm restrictions').click();await tick();button('Apply restrictions').click();await settle();
  assert(choices[1].reviewSha256==='policy-2','fresh choice uses refreshed opaque policy hash');
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
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;if(saved===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,saved);}
}

export async function expertCopyAccessReviewRegression():Promise<void>{
 const originalFetch=globalThis.fetch,host=document.createElement('div');document.body.append(host);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const posts:any[]=[];let hash='copy-policy-1',snapshot='a'.repeat(64),consentCurrent=false,wrongCopy=false;
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(_input,init)=>{
  if(init?.method==='POST'){
   posts.push(JSON.parse(String(init.body)));
   if(posts.length===1){hash='copy-policy-2';snapshot='b'.repeat(64);return json({error:'Source snapshot changed'},409);}
   consentCurrent=true;return json({reviewSha256:hash,source:[],destination:{restrictedCapabilityIds:[]}});
  }
  return json({branchId:'branch',executionId:'run',stepExecutionId:'copy-step',generation:1,state:'reserved',destinationChatId:'copy-chat',destinationChatAvailable:true,accessChoiceCurrent:consentCurrent,
   expertCopyReview:{sourceAgentId:'original-expert',sourceChatId:'original-chat',copyChatId:wrongCopy?'other-chat':'copy-chat',snapshotSha256:snapshot,consentCurrent,copySourceMemory:consentCurrent,allowFindingsWriteback:false},
   currentPolicyReview:{reviewSha256:hash,source:[],destination:{restrictedCapabilityIds:['unchanged-restriction']}}});
 };
 const render=(key:string)=>root.render(<QueryClientProvider client={client}><BranchResourceReview key={key} branchId="branch" executionId="run" stepId="copy-step" enabled onChanged={()=>{}}/></QueryClientProvider>);
 const check=(text:string)=>Array.from(document.querySelectorAll('label')).find(label=>label.textContent?.includes(text))?.querySelector('input') as HTMLInputElement;
 const choose=async()=>{openSelect(document.querySelector('[role=combobox]'));await tick();(Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent==='Keep destination restrictions') as HTMLElement).click();await settle();};
 try{
  render('first');await settle();button('Review resource').click();await settle();
  assert(!check('Copy the original Agent').checked&&!check('Allow this copy').checked,'both memory choices default off');
  assert(document.body.textContent?.includes('do not grant Global Memory, browser access, or other capabilities'),'actual scope is disclosed');
  assert(document.body.textContent?.includes('each later copy needs its own memory-copy approval'),'future copies require separate approval');
  assert(document.body.textContent?.includes('source working-folder files are not copied'),'fresh workspace limitation is disclosed before approval');
  await choose();check('Allow this copy').click();await settle();
  assert(button('Confirm copy access').disabled,'findings approval alone cannot admit an incomplete full-context copy');
  check('Copy the original Agent').click();await settle();button('Confirm copy access').click();await settle();
  assert(posts.length===0,'approval is explicit and separate from selection');button('Approve copy').click();await settle();
  assert(posts.length===1,'stale approval never automatically retries');
  assert(posts[0].copySourceMemory===true&&posts[0].allowFindingsWriteback===true,'independent opt-ins are sent explicitly');
  assert(posts[0].snapshotSha256==='a'.repeat(64)&&posts[0].accessSettingsResolution.reviewSha256==='copy-policy-1','bind exact source snapshot and current policy');
  assert(posts[0].accessSettingsResolution.action==='keep_destination','memory approval does not apply source capabilities');
  assert(!check('Copy the original Agent').checked&&!check('Allow this copy').checked,'changed snapshot requires fresh unchecked choices');
  await choose();check('Copy the original Agent').click();await settle();button('Confirm copy access').click();await settle();button('Approve copy').click();await settle();
  assert(posts.length===2&&posts[1].copySourceMemory===true&&posts[1].allowFindingsWriteback===false,'findings remain independently optional');
  assert(posts[1].snapshotSha256==='b'.repeat(64)&&posts[1].accessSettingsResolution.reviewSha256==='copy-policy-2','fresh approval uses exact refreshed evidence');
  assert(button('Confirm copy access').disabled,'recorded consent cannot be resubmitted as fresh approval');
  assert(check('Copy the original Agent').checked&&!check('Allow this copy').checked,'readback shows actual recorded independent consent');
  wrongCopy=true;client.clear();render('mismatch');await settle();button('Review resource').click();await settle();
  assert(document.body.textContent?.includes('Resource identity changed'),'mismatched temporary Chat cannot be approved');
  assert(posts.length===2,'inspection mismatch has no mutation');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;}
}
