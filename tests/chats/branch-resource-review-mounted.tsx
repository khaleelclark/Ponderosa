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
