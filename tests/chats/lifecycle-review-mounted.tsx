// Deferred mounted regression; run only in the existing browser harness when authorized.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {LifecycleReview} from '../../apps/web/src/components/lifecycle/LifecycleReview';
import {currentProductScope} from '../../apps/web/src/api/productScope';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(item=>item.textContent===text)!;
const check=()=>{(Array.from(document.querySelectorAll('input[type=checkbox]')).find(item=>!item.closest('label')?.textContent?.includes('Release source pins')) as HTMLInputElement).click();};
export async function lifecycleReviewRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const originalFetch=globalThis.fetch,path='/api/lifecycle/destinations/admission';
 const storageKey=JSON.stringify(['lifecycle-command',window.location.origin,currentProductScope(),path]),saved=localStorage.getItem(storageKey);localStorage.removeItem(storageKey);
 const posts:{url:string;body:any}[]=[];let phase='destination',retired=false,reviewHash='review-1';
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{
  const url=String(input),method=init?.method??'GET';
  if(method==='POST'){
   const body=JSON.parse(String(init?.body));posts.push({url,body});
   if(phase==='custody'){reviewHash='review-2';return json({error:'Current custody proof changed'},409);}
   assert(localStorage.getItem(storageKey)?.includes(body.commandKey),'persist original command before mutation');
   if(url.endsWith('/approve'))return json({admissionId:'admission',reviewHash:'review-1',operatorId:'local-operator',choice:body});
   assert(url.endsWith('/retire'),'only exact supported retirement mutation');retired=true;throw new TypeError('Response lost');
  }
  if(url.endsWith('/receipt'))return retired?json({admissionId:'admission',commandKey:posts[0].body.commandKey,reviewHash:'review-1',releasedSourcePins:false,retiredAt:'now'}):json({error:'No receipt'},404);
  if(phase==='memory')return json({hold:{id:'legacy',legacy:true,state:'unsettled',sha256:'hold'},reviewSha256:'memory',canReconcile:false,backendDrainEvidenceRequired:true,reason:'Legacy effect metadata absent'});
  if(phase==='custody')return json({custodyId:'custody',state:'retained',sourceAgentIds:[],references:reviewHash==='review-2'?['new pin']:[],blockers:[],files:[{name:'original',byteLength:3,sha256:'bytes'}],reviewSha256:reviewHash});
  return json({admissionId:'admission',reviewHash:'review-1',state:'staged',stage:null,evidenceRevision:'evidence',references:['checkpoint pin'],canReleaseSourcePins:false,preserveOnlyPermanent:true,globalRuntimeQuiescenceRequired:true,reservation:{custody:{checkpointId:'cut',sourceChatId:'chat',agentIds:['agent'],custodyId:'custody',intent:{executionId:'run',resourceStepId:'step',resourceGeneration:0}}}});
 };
 const render=(key:string,kind:'destination'|'custody'|'memory',id:string)=>root.render(<QueryClientProvider client={client}><LifecycleReview key={key} kind={kind} id={id}/></QueryClientProvider>);
 try{
  render('first','destination','admission');await settle();button('Review destination retirement').click();await settle();
  assert(posts.length===0,'review cannot approve or retire');assert(document.body.textContent?.includes('permanent'),'show permanent preserve-only disposition');
  assert((Array.from(document.querySelectorAll('input[type=checkbox]')).find(item=>item.closest('label')?.textContent?.includes('Release source pins')) as HTMLInputElement).disabled,'referenced source pins cannot release');
  check();await settle();button('Approve retirement choice').click();await settle();button('Confirm exact command').click();await settle();
  assert(posts.length===1&&posts[0].url.endsWith('/approve'),'approval cannot retire automatically');
  button('Confirm retirement').click();await settle();button('Retire destination').click();await settle();assert(posts.length===2&&localStorage.getItem(storageKey),'lost response retains exact choice');
  assert(JSON.stringify(posts[0].body)===JSON.stringify(posts[1].body),'approval and retirement use identical body and key');
  render('remount','destination','admission');await settle();button('Review destination retirement').click();await settle();button('Inspect retirement receipt').click();await settle();
  assert(posts.length===2&&!localStorage.getItem(storageKey),'pure exact receipt lookup clears without replay');
  phase='memory';render('legacy','memory','legacy');await settle();button('Review memory hold').click();await settle();assert((button('Reconcile and preserve evidence') as HTMLButtonElement).disabled,'legacy unknown effects stay held');
  phase='custody';render('stale','custody','custody');await settle();button('Review checkpoint evidence').click();await settle();check();await settle();button('Reconcile and preserve evidence').click();await settle();button('Confirm exact command').click();await settle();
  assert(posts.length===3,'stale response cannot retry automatically');assert(document.body.textContent?.includes('Exact command retained'),'stale outcome retains original command');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;localStorage.removeItem(JSON.stringify(['lifecycle-command',window.location.origin,currentProductScope(),'/api/lifecycle/checkpoint-custody/custody']));if(saved===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,saved);}
}
