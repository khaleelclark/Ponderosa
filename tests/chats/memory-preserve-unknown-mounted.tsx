// Deferred browser-harness fixture. No execution/preparation authorized.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryPreserveUnknown} from '../../apps/web/src/components/lifecycle/MemoryPreserveUnknown';
import {LifecycleReview} from '../../apps/web/src/components/lifecycle/LifecycleReview';
import {currentProductScope} from '../../apps/web/src/api/productScope';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(item=>item.textContent===text)!;
export async function memoryPreserveUnknownRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const originalFetch=globalThis.fetch,id='original',key=JSON.stringify(['memory-preserve-unknown',window.location.origin,currentProductScope(),id]),saved=localStorage.getItem(key);
 localStorage.removeItem(key);
 const hold:any={id,sha256:'a'.repeat(64),preserveUnknownReviewSha256:'b'.repeat(64),legacy:true,state:'unsettled'};
 let receipt:any,posts:any[]=[],getReviews=0,conflict=false;
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(init?.method==='POST'){
   assert(url.endsWith('/mutation-holds/original/preserve-unknown'),'only separate preserve endpoint');
   const body=JSON.parse(String(init.body));posts.push(body);
   assert(JSON.stringify(JSON.parse(localStorage.getItem(key)!).body)===JSON.stringify(body),'save complete original before effect');
   assert(body.reviewSha256==='b'.repeat(64)&&body.preserveUnknown===true&&!('backendDrainEvidence' in body),'distinct original hash, no invented drain');
   if(conflict)return json({error:'stale review'},409);
   receipt={version:1,id,holdSha256:hold.sha256,commandKey:body.commandKey,reviewSha256:body.reviewSha256,reason:body.reason,operatorId:'local-operator',disposition:'preserve_unknown',outcome:'unknown',held:true,replayed:false,backendModified:false};
   throw new TypeError('Response lost');
  }
  if(url.endsWith('/mutation-holds'))return json([{...hold,...(receipt?{disposition:receipt}:{})}]);
  getReviews++;return json({hold,reviewSha256:'c'.repeat(64),canReconcile:false,backendDrainEvidenceRequired:true});
 };
 const render=(mount:string)=>root.render(<QueryClientProvider client={client}><MemoryPreserveUnknown key={mount} id={id}/></QueryClientProvider>);
 const stage=async()=>{
  const field=document.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,'Completion cannot be verified');field.dispatchEvent(new Event('input',{bubbles:true}));await settle();
  (document.querySelector('input[type=checkbox]') as HTMLInputElement).click();await settle();button('Record Preserve Unknown').click();await settle();
  assert(posts.length===0,'separate confirmation before effect');button('Confirm Preserve Unknown').click();await settle();
 };
 try{
  render('legacy');await settle();button('Preserve Unknown').click();await settle();await stage();
  assert(posts.length===1&&localStorage.getItem(key)&&getReviews===0,'legacy inventory works independently; lost response held');
  render('remount');await settle();button('Preserve Unknown').click();await settle();
  assert(posts.length===1,'remount never repeats mutation');
  const exact=receipt;receipt={...exact,commandKey:'substituted'};
  button('Inspect Original Disposition').click();await settle();assert(localStorage.getItem(key)&&posts.length===1,'wrong receipt cannot clear original');
  receipt=exact;button('Inspect Original Disposition').click();await settle();assert(!localStorage.getItem(key)&&posts.length===1,'exact GET clears without replay');
  assert(document.body.textContent?.includes('hold unsettled'),'receipt never releases hold');
  // Known effect + unavailable backend: Preserve unknown still reads inventory only.
  hold.legacy=false;hold.effect={scope:'collection',operation:'upsert',log:false};receipt=undefined;posts=[];conflict=true;
  render('known');await settle();button('Preserve Unknown').click();await settle();await stage();
  const original=localStorage.getItem(key);assert(original&&posts.length===1,'409 original retained');
  hold.sha256='d'.repeat(64);hold.preserveUnknownReviewSha256='e'.repeat(64);
  button('Inspect Original Disposition').click();await settle();assert(localStorage.getItem(key)===original&&posts.length===1,'changed hash cannot replace pending input');
  button('Repeat Exact Preserve Unknown Command').click();await settle();assert(posts.length===1,'explicit repeat still requires separate confirmation');
  button('Confirm Preserve Unknown').click();await settle();assert(posts.length===2&&JSON.stringify(posts[0])===JSON.stringify(posts[1]),'explicit repeat sends unchanged command only');
  root.render(<QueryClientProvider client={client}><LifecycleReview kind="memory" id={id}/></QueryClientProvider>);await settle();button('Review Memory Hold').click();await settle();assert(button('Reconcile And Preserve Evidence').disabled,'preserve action does not enable Reconcile');
  assert(getReviews===1,'no ordinary review needed by preserve path');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;if(saved===null)localStorage.removeItem(key);else localStorage.setItem(key,saved);}
}

// Storage failures must distinguish an unsent decision from a verified
// preservation receipt, without claiming the original memory outcome is known.
export async function memoryPreserveStorageFeedbackRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const originalFetch=globalThis.fetch,originalSetItem=Storage.prototype.setItem,originalRemoveItem=Storage.prototype.removeItem;
 const id='storage-preserve',key=JSON.stringify(['memory-preserve-unknown',window.location.origin,currentProductScope(),id]),saved=localStorage.getItem(key);
 localStorage.removeItem(key);
 let failSave=false,failRemove=false,remoteReceipt:any,returnedReceipt:any;
 const posts:any[]=[],hold:any={id,sha256:'a'.repeat(64),preserveUnknownReviewSha256:'b'.repeat(64),legacy:true,state:'unsettled'};
 const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
 Storage.prototype.setItem=function(k:string,value:string){
  if(k===key&&failSave)throw new DOMException('Synthetic quota exceeded','QuotaExceededError');
  return originalSetItem.call(this,k,value);
 };
 Storage.prototype.removeItem=function(k:string){
  if(k===key&&failRemove)throw new DOMException('Synthetic storage failure','SecurityError');
  return originalRemoveItem.call(this,k);
 };
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(init?.method==='POST'){
   assert(url.endsWith('/mutation-holds/storage-preserve/preserve-unknown'),'only the preserve endpoint may be called');
   const body=JSON.parse(String(init.body));posts.push(body);
   assert(localStorage.getItem(key)?.includes(body.commandKey),'save original decision before dispatch');
   remoteReceipt={version:1,id,holdSha256:hold.sha256,commandKey:body.commandKey,reviewSha256:body.reviewSha256,reason:body.reason,operatorId:'local-operator',disposition:'preserve_unknown',outcome:'unknown',held:true,replayed:false,backendModified:false};
   returnedReceipt=remoteReceipt;
   return json(remoteReceipt);
  }
  if(url.endsWith('/mutation-holds'))return json([{...hold,...(returnedReceipt?{disposition:returnedReceipt}:{})}]);
  throw Error('Unexpected request: '+url);
 };
 const render=(mount:string)=>root.render(<QueryClientProvider client={client}><MemoryPreserveUnknown key={mount} id={id}/></QueryClientProvider>);
 const stage=async()=>{
  const field=document.querySelector('textarea:not([aria-hidden="true"])') as HTMLTextAreaElement;
  assert(field,'reason field exists');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,'Completion cannot be verified');
  field.dispatchEvent(new Event('input',{bubbles:true}));await settle();
  (document.querySelector('input[type=checkbox]') as HTMLInputElement).click();await settle();
  button('Record Preserve Unknown').click();await settle();
 };
 try{
  render('pre-dispatch');await settle();button('Preserve Unknown').click();await settle();await stage();
  failSave=true;button('Confirm Preserve Unknown').click();await settle();
  assert(posts.length===0&&!localStorage.getItem(key),'a failed initial save sends no request and retains no new command');
  assert(document.body.textContent?.includes('No request was sent this time'),'unsent decision is explained');
  assert(!document.body.textContent?.includes('Outcome unconfirmed · exact command held'),'unsent attempt is not misreported as dispatched');

  failSave=false;render('post-response');await settle();button('Preserve Unknown').click();await settle();await stage();
  failRemove=true;button('Confirm Preserve Unknown').click();await settle();
  const retained=localStorage.getItem(key);
  assert(posts.length===1&&retained,'verified receipt with failed local removal retains original input');
  assert(document.body.textContent?.includes('The preserve decision was confirmed'),'only the preservation decision is confirmed');
  assert(document.body.textContent?.includes('original memory outcome is still unknown')&&document.body.textContent?.includes('hold remains'),'original uncertainty and hold remain visible');
  assert(document.body.textContent?.includes('Exact command retained'),'new decisions stay locked');

  returnedReceipt={...remoteReceipt,commandKey:'different'};
  button('Inspect Original Disposition').click();await settle();
  assert(localStorage.getItem(key)===retained&&document.body.textContent?.includes('Disposition unconfirmed'),'a mismatched receipt remains unconfirmed');
  returnedReceipt=remoteReceipt;
  button('Inspect Original Disposition').click();await settle();
  assert(localStorage.getItem(key)===retained&&document.body.textContent?.includes('The preserve decision was confirmed'),'matching lookup reports local cleanup failure');
  assert(posts.length===1,'receipt inspection never repeats the mutation');
  failRemove=false;button('Inspect Original Disposition').click();await settle();
  assert(!localStorage.getItem(key)&&posts.length===1,'matching lookup clears after storage recovers without replay');
  assert(document.body.textContent?.includes('hold unsettled'),'verified disposition never clears the original memory hold');
 }finally{
  Storage.prototype.setItem=originalSetItem;Storage.prototype.removeItem=originalRemoveItem;
  root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;
  if(saved===null)localStorage.removeItem(key);else localStorage.setItem(key,saved);
 }
}
