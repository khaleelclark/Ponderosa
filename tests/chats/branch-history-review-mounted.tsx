import {openSelect} from '../shared/mounted-controls';
// Deferred browser regression source; use the existing mounted harness.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BranchHistoryReview} from '../../apps/web/src/components/branches/BranchHistoryReview';
const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const settle=async()=>{for(let i=0;i<6;i++)await tick();};
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(item=>item.textContent===text)!;
export async function branchHistoryReviewRegression():Promise<void>{
 const originalFetch=globalThis.fetch,host=document.createElement('div');document.body.append(host);
 const storageKey='branch-history-submission:branch:execution',originalStorage=localStorage.getItem(storageKey);localStorage.removeItem(storageKey);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const sent:Record<string,unknown>[]= [];let reviewCount=0;
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url.endsWith('/historical-checkpoints'))return json([{id:4,branchId:'branch',executionId:'execution',contentHash:'cut',restoreSupported:true,eligibility:'script_control_frontier'}]);
  if(url.endsWith('/host-graph-review'))return json({checkpointId:4,checkpointHash:'cut',reviewHash:`opaque-${++reviewCount}`,requests:[],joins:[]});
  if(url.endsWith('/restore-host-graph')){sent.push(JSON.parse(String(init?.body)));if(sent.length===1)return json({error:'Review changed'},409);if(sent.length===2)throw new TypeError('Response lost');return json({restorationId:'restored',requestMap:{},joinMap:{},updateMap:{}});}
  throw new Error(`Unexpected call ${url}`);
 };
 try{
  root.render(<QueryClientProvider client={client}><BranchHistoryReview branchId="branch" executionId="execution" enabled onChanged={()=>{}}/></QueryClientProvider>);await settle();
  button('Review saved work').click();await settle();
  openSelect(document.querySelectorAll('[role=combobox]')[0]);await tick();
  (Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent?.startsWith('4 ·')) as HTMLElement).click();await tick();
  openSelect(document.querySelectorAll('[role=combobox]')[1]);await tick();
  (Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent==='Restore Request graph') as HTMLElement).click();await tick();
  button('Review current scope').click();await settle();assert(sent.length===0,'review cannot restore or activate a graph');
  (document.querySelector('input[type=checkbox]') as HTMLInputElement).click();await tick();button('Continue').click();await tick();button('Apply reviewed action').click();await settle();
  assert(reviewCount===2,'409 refreshes review once');assert(sent.length===1,'409 does not resubmit');
  assert((button('Continue') as HTMLButtonElement).disabled,'fresh review requires renewed acknowledgement');
  (document.querySelector('input[type=checkbox]') as HTMLInputElement).click();await tick();button('Continue').click();await tick();button('Apply reviewed action').click();await settle();
  assert(localStorage.getItem(storageKey),'uncertain outcome retains the exact command');
  button('Reconcile submission').click();await settle();
  assert(JSON.stringify(sent[1])===JSON.stringify(sent[2]),'reconciliation reuses the exact input and command key');
  assert(sent[1].reviewHash==='opaque-2'&&sent[1].reconcileEffects===true,'only the fresh opaque review authorizes restoration');
  assert(localStorage.getItem(storageKey)===null,'confirmed receipt clears the retained command');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;if(originalStorage===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,originalStorage);}
}
