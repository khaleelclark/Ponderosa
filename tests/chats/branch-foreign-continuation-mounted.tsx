import {createRoot} from 'react-dom/client';
import {BranchForeignContinuationReview} from '../../apps/web/src/components/branches/BranchForeignContinuationReview';
import {currentProductScope,productApiPath} from '../../apps/web/src/api/productScope';
import {foreignCommandStorageKey} from '../../apps/web/src/components/branches/branchForeignContinuation';
const assert=(ok:unknown,message:string)=>{if(!ok)throw Error(message)};
const settle=()=>new Promise(resolve=>setTimeout(resolve,50));
async function until(read:()=>boolean,label:string){const end=performance.now()+5000;while(!read()){if(performance.now()>end)throw Error(label);await settle();}}
/** Mock-API component safety fixture; real backend qualification is a separate lane. */
export async function foreignContinuationRegression(mode:'normal'|'quota'|'security'|'stale'|'before_entry'|'before_entry_missing'|'before_entry_tampered'='normal'){
 const host=document.createElement('div');document.body.append(host);let root=createRoot(host);
 const beforeEntry=mode.startsWith('before_entry'),sha='a'.repeat(64),selection={planId:'plan',sourceExecutionId:'source',checkpointKey:beforeEntry?'current':'cut',checkpointSha256:sha};
 const frontier={execution:[{id:'source',branch_id:'original-branch',state:'canceled',admission_source:'manual',input_text:'Synthetic original task'}],paths:[],steps:[]};
 const saved:any={receipt:{planId:'plan',branchId:'branch'},data:{sha256:sha,owners:[{sourceExecutionId:'source',sourceBranchId:'original-branch',sha256:sha,facts:[{kind:'provenance',json:'{"source":"manual"}'},beforeEntry?{kind:'frontier',key:'current',sha256:sha,json:JSON.stringify(frontier)}:{kind:'checkpoint',key:'cut',sha256:sha,json:'{"restore_supported":true}'}]}]}};
 const key=foreignCommandStorageKey(location.origin,`${currentProductScope()}:${productApiPath('/api/branches')}`,'branch','held');
 const prior=localStorage.getItem(key),transport=window.fetch,setItem=Storage.prototype.setItem;
 localStorage.removeItem(key);let reviews=0,posts=0,gets=0,posted:any;
 const value=()=>({schema:'ponderosa.branch-foreign-review.v1',selection,manifestSha256:sha,ownerSha256:sha,nativeMaps:saved.receipt,branchId:'branch',importedExecutionId:'held',reviewSha256:mode==='stale'&&reviews>1?'b'.repeat(64):sha,custody:'not_applicable',engine:beforeEntry?'current_destination':'node',secretChoice:'none',accessChoice:'current_destination',...(beforeEntry?{beforeEntry:{sourceBranchId:'original-branch',sourceExecutionId:'source',sourceFrontierSha256:sha},checkpoint:mode==='before_entry_tampered'?{...frontier,execution:[{...frontier.execution[0],input_text:'Changed task'}]}:frontier}:{})});
 window.fetch=async(input,init)=>{
  const url=String(input);
  if(url.endsWith('/review')){reviews++;return mode==='before_entry_missing'?new Response(JSON.stringify({error:'Original source unavailable; held'}),{status:409}):new Response(JSON.stringify(value()))}
  if(init?.method==='POST'){posts++;posted=JSON.parse(String(init.body));assert(localStorage.getItem(key)===JSON.stringify(posted),'durable exact command before POST');throw Error('Controlled lost response')}
  gets++;assert(url.includes('commandKey='+encodeURIComponent(posted.commandKey)),'original-key GET');return new Response(JSON.stringify({schema:'ponderosa.branch-foreign-continuation.v1',branchId:'branch',importedExecutionId:'held',executionId:'fresh',commandKey:posted.commandKey,review:value()}));
 };
 const click=async(name:string)=>{await until(()=>Boolean(Array.from(host.querySelectorAll('button')).find(item=>item.textContent===name&&!item.disabled)),name+' is ready');Array.from(host.querySelectorAll('button')).find(item=>item.textContent===name)!.click();await settle()};
 const mount=async()=>{root.render(<BranchForeignContinuationReview saved={saved} sourceExecutionId="source" executionId="held"/>);await settle()};
 try{
  await mount();const input=host.querySelector('input')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,beforeEntry?'frontier:current':'checkpoint:cut');
  // MUI selects are controlled through their actual option buttons.
  const select=host.querySelector('[role="combobox"]')!;select.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));await settle();(Array.from(document.querySelectorAll('[role="option"]')).find(e=>e.textContent?.startsWith(beforeEntry?'Check Whether Source Never Started':'cut')) as HTMLElement).click();await settle();
  assert(reviews===0&&posts===0&&!host.querySelector('input[type="checkbox"]'),'unverified source offers no authority');
  await click('Review Current Continuation Authority');await until(()=>mode==='before_entry_missing'||mode==='before_entry_tampered'?Boolean(host.textContent?.includes(mode==='before_entry_missing'?'Original source unavailable; held':'Current review differs; held')):Boolean(host.querySelector('input[type="checkbox"]')),'Exact review result commits before its authority is inspected');assert(posts===0,'review grants no authority');
  if(mode==='before_entry_missing'||mode==='before_entry_tampered'){
   assert(!host.querySelector('input[type="checkbox"]'),'unavailable or changed source cannot be confirmed');
   assert(host.textContent?.includes(mode==='before_entry_missing'?'Original source unavailable; held':'Current review differs; held'),'specific refusal remains visible');
   return {mode,posts,gets,reviews};
  }
  const confirm=()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Accept Current Authority And Continue')!;
  assert(confirm().disabled,'fresh explicit consent required');(host.querySelector('input[type="checkbox"]') as HTMLInputElement).click();await settle();
  if(mode==='quota'||mode==='security')Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('Controlled storage failure',mode==='quota'?'QuotaExceededError':'SecurityError');return setItem.call(this,k,v)};
  await click('Accept Current Authority And Continue');await until(()=>Boolean(host.textContent?.includes(mode==='quota'||mode==='security'?'Controlled storage failure':mode==='stale'?'Current authority changed':'Controlled lost response')),'Exact confirmation outcome commits before side effects are inspected');
  if(mode==='normal'||mode==='before_entry'){
   assert(posts===1&&localStorage.getItem(key),'one lost-result mutation retained');root.unmount();root=createRoot(host);await mount();await until(()=>gets===1&&Boolean(host.textContent?.includes('Fresh continuation accepted')),'Original-key receipt read commits after remount');assert(reviews===2&&posts===1,'remount cannot review or POST');assert(gets===1&&host.textContent?.includes('Fresh continuation accepted'),'remount uses only the original-key read');await click('Refresh Saved Result');assert(gets===2&&posts===1&&host.textContent?.includes('Fresh continuation accepted'),'manual refresh only reads the original-key receipt');
  }else if(mode==='stale')assert(posts===0&&!(host.querySelector('input[type="checkbox"]') as HTMLInputElement|null)?.checked,'authority drift invalidates consent before mutation');
  else assert(posts===0&&localStorage.getItem(key)===null&&host.textContent?.includes('Controlled storage failure'),'storage exception stops mutation');
  return {mode,posts,gets,reviews};
 }finally{Storage.prototype.setItem=setItem;window.fetch=transport;root.unmount();host.remove();if(prior===null)localStorage.removeItem(key);else localStorage.setItem(key,prior)}
}

export async function foreignContinuationQuotaRegression(){await foreignContinuationRegression('quota');}
export async function foreignContinuationSecurityRegression(){await foreignContinuationRegression('security');}
export async function foreignContinuationStaleRegression(){await foreignContinuationRegression('stale');}

export async function foreignBeforeEntryRegression(){await foreignContinuationRegression('before_entry');}
export async function foreignBeforeEntryMissingRegression(){await foreignContinuationRegression('before_entry_missing');}
export async function foreignBeforeEntryTamperedRegression(){await foreignContinuationRegression('before_entry_tampered');}
