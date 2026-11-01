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
  (document.querySelector('input[type=checkbox]') as HTMLInputElement).click();await settle();button('Record Preserve unknown').click();await settle();
  assert(posts.length===0,'separate confirmation before effect');button('Confirm Preserve unknown').click();await settle();
 };
 try{
  render('legacy');await settle();button('Preserve unknown').click();await settle();await stage();
  assert(posts.length===1&&localStorage.getItem(key)&&getReviews===0,'legacy inventory works independently; lost response held');
  render('remount');await settle();button('Preserve unknown').click();await settle();
  assert(posts.length===1,'remount never repeats mutation');
  const exact=receipt;receipt={...exact,commandKey:'substituted'};
  button('Inspect original disposition').click();await settle();assert(localStorage.getItem(key)&&posts.length===1,'wrong receipt cannot clear original');
  receipt=exact;button('Inspect original disposition').click();await settle();assert(!localStorage.getItem(key)&&posts.length===1,'exact GET clears without replay');
  assert(document.body.textContent?.includes('hold unsettled'),'receipt never releases hold');
  // Known effect + unavailable backend: Preserve unknown still reads inventory only.
  hold.legacy=false;hold.effect={scope:'collection',operation:'upsert',log:false};receipt=undefined;posts=[];conflict=true;
  render('known');await settle();button('Preserve unknown').click();await settle();await stage();
  const original=localStorage.getItem(key);assert(original&&posts.length===1,'409 original retained');
  hold.sha256='d'.repeat(64);hold.preserveUnknownReviewSha256='e'.repeat(64);
  button('Inspect original disposition').click();await settle();assert(localStorage.getItem(key)===original&&posts.length===1,'changed hash cannot replace pending input');
  button('Repeat exact Preserve unknown command').click();await settle();assert(posts.length===1,'explicit repeat still requires separate confirmation');
  button('Confirm Preserve unknown').click();await settle();assert(posts.length===2&&JSON.stringify(posts[0])===JSON.stringify(posts[1]),'explicit repeat sends unchanged command only');
  root.render(<QueryClientProvider client={client}><LifecycleReview kind="memory" id={id}/></QueryClientProvider>);await settle();button('Review memory hold').click();await settle();assert(button('Reconcile and preserve evidence').disabled,'preserve action does not enable Reconcile');
  assert(getReviews===1,'no ordinary review needed by preserve path');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;if(saved===null)localStorage.removeItem(key);else localStorage.setItem(key,saved);}
}
