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

// A rejected note must never become a locked, retained recovery command.
export async function lifecycleNoteValidationRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const originalFetch=globalThis.fetch,origin=window.location.origin,scope=currentProductScope();
 const memoryPath='/api/local-memory/mutation-holds/note-validation',importPath='/api/lifecycle/agent-imports/note-validation';
 const key=(path:string)=>JSON.stringify(['lifecycle-command',origin,scope,path]);
 const keys=[key(memoryPath),key(importPath)],saved=keys.map(k=>localStorage.getItem(k));
 keys.forEach(k=>localStorage.removeItem(k));
 const posts:Array<{url:string;body:any}>=[],json=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(init?.method==='POST'){
   const body=JSON.parse(String(init.body));posts.push({url,body});
   assert(localStorage.getItem(key(memoryPath))?.includes(body.commandKey),'save exact command before dispatch');
   throw new TypeError('Synthetic lost response');
  }
  if(url.includes('/api/local-memory/mutation-holds/'))return json({hold:{id:'note-validation',legacy:false,state:'unsettled',sha256:'a'.repeat(64)},reviewSha256:'b'.repeat(64),canReconcile:true,backendDrainEvidenceRequired:true});
  if(url.includes('/api/lifecycle/agent-imports/'))return json({operationId:'note-validation',reviewSha256:'c'.repeat(64),canRetireMutationFree:true,blockers:[]});
  throw Error('Unexpected request: '+url);
 };
 const render=(kind:'memory'|'import',mount:string)=>root.render(<QueryClientProvider client={client}><LifecycleReview key={mount} kind={kind} id="note-validation"/></QueryClientProvider>);
 const write=async(value:string)=>{
  const field=document.querySelector('textarea:not([aria-hidden="true"])') as HTMLTextAreaElement;
  assert(field,'note field exists');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,value);
  field.dispatchEvent(new Event('input',{bubbles:true}));await settle();
 };
 const approve=async()=>{check();await settle();};
 try{
  render('memory','memory');await settle();button('Review memory hold').click();await settle();
  await write(' 123456789012345 ');await approve();
  assert(button('Reconcile and preserve evidence').disabled,'15 trimmed characters cannot submit memory reconciliation');
  assert(posts.length===0&&!localStorage.getItem(key(memoryPath)),'invalid input creates no retained command');
  await write('1234567890123456');await approve();
  assert(!button('Reconcile and preserve evidence').disabled,'16 characters can proceed');
  await write('  '+ 'x'.repeat(4096) +'  ');await approve();
  assert(!button('Reconcile and preserve evidence').disabled,'4096 trimmed characters can proceed');
  await write('x'.repeat(4097));await approve();
  assert(button('Reconcile and preserve evidence').disabled,'more than 4096 characters cannot submit');
  await write('1234567890123456');await approve();
  button('Reconcile and preserve evidence').click();await settle();
  assert(posts.length===0,'confirmation is required before dispatch');
  button('Confirm exact command').click();await settle();
  assert(posts.length===1&&posts[0].body.backendDrainEvidence==='1234567890123456','send the exact valid note');
  const retained=localStorage.getItem(key(memoryPath));
  assert(retained&&document.body.textContent?.includes('Exact command retained'),'unknown result keeps command locked');
  render('memory','memory-remount');await settle();button('Review memory hold').click();await settle();
  assert(localStorage.getItem(key(memoryPath))===retained&&posts.length===1,'remount never clears or replays an uncertain command');
  button('Retry exact command').click();await settle();button('Confirm exact command').click();await settle();
  assert(posts.length===2&&JSON.stringify(posts[0].body)===JSON.stringify(posts[1].body),'only an explicit retry resends the unchanged command');
  assert(localStorage.getItem(key(memoryPath))===retained,'another lost response retains the original command');

  render('import','import');await settle();button('Review import custody').click();await settle();
  await write('1234567');await approve();
  assert(button('Preserve unresolved operation').disabled,'7 characters cannot submit import reconciliation');
  await write('12345678');await approve();
  assert(!button('Preserve unresolved operation').disabled,'8 characters can proceed for imports');
  await write('x'.repeat(4097));await approve();
  assert(button('Preserve unresolved operation').disabled&&button('Retire mutation-free import').disabled,'oversize notes block both import decisions');
  assert(!localStorage.getItem(key(importPath))&&posts.length===2,'invalid import note creates no retained command');
 }finally{
  root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;
  keys.forEach((k,i)=>{if(saved[i]===null)localStorage.removeItem(k);else localStorage.setItem(k,saved[i]!);});
 }
}
