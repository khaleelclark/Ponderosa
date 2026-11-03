import {createRoot} from 'react-dom/client';
import {BranchForeignContinuationReview} from '../../apps/web/src/components/branches/BranchForeignContinuationReview';
import {currentProductScope,productApiPath} from '../../apps/web/src/api/productScope';
import {foreignCommandStorageKey} from '../../apps/web/src/components/branches/branchForeignContinuation';
const assert=(ok:unknown,message:string)=>{if(!ok)throw Error(message)};
const settle=()=>new Promise(resolve=>setTimeout(resolve,50));
/** Mock-API component safety fixture; real backend qualification is a separate lane. */
export async function foreignContinuationRegression(mode:'normal'|'quota'|'security'|'stale'='normal'){
 const host=document.createElement('div');document.body.append(host);let root=createRoot(host);
 const sha='a'.repeat(64),selection={planId:'plan',sourceExecutionId:'source',checkpointKey:'cut',checkpointSha256:sha};
 const saved:any={receipt:{planId:'plan',branchId:'branch'},data:{sha256:sha,owners:[{sourceExecutionId:'source',sha256:sha,facts:[{kind:'checkpoint',key:'cut',sha256:sha,json:'{"restore_supported":true}'}]}]}};
 const key=foreignCommandStorageKey(location.origin,`${currentProductScope()}:${productApiPath('/api/branches')}`,'branch','held');
 const prior=localStorage.getItem(key),transport=window.fetch,setItem=Storage.prototype.setItem;
 localStorage.removeItem(key);let reviews=0,posts=0,gets=0,posted:any;
 const value=()=>({schema:'ponderosa.branch-foreign-review.v1',selection,manifestSha256:sha,ownerSha256:sha,nativeMaps:saved.receipt,branchId:'branch',importedExecutionId:'held',reviewSha256:mode==='stale'&&reviews>1?'b'.repeat(64):sha,custody:'not_applicable',engine:'node',secretChoice:'none',accessChoice:'current_destination'});
 window.fetch=async(input,init)=>{
  const url=String(input);
  if(url.endsWith('/review')){reviews++;return new Response(JSON.stringify(value()))}
  if(init?.method==='POST'){posts++;posted=JSON.parse(String(init.body));assert(localStorage.getItem(key)===JSON.stringify(posted),'durable exact command before POST');throw Error('Controlled lost response')}
  gets++;assert(url.includes('commandKey='+encodeURIComponent(posted.commandKey)),'original-key GET');return new Response(JSON.stringify({schema:'ponderosa.branch-foreign-continuation.v1',branchId:'branch',importedExecutionId:'held',executionId:'fresh',commandKey:posted.commandKey,review:value()}));
 };
 const click=async(name:string)=>{const button=Array.from(host.querySelectorAll('button')).find(item=>item.textContent===name);assert(button&&!button.disabled,name);button!.click();await settle()};
 const mount=async()=>{root.render(<BranchForeignContinuationReview saved={saved} sourceExecutionId="source" executionId="held"/>);await settle()};
 try{
  await mount();const input=host.querySelector('input')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'cut');
  // MUI selects are controlled through their actual option buttons.
  const select=host.querySelector('[role="combobox"]')!;select.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));await settle();(Array.from(document.querySelectorAll('[role="option"]')).find(e=>e.textContent?.startsWith('cut')) as HTMLElement).click();await settle();
  await click('Review current continuation authority');assert(posts===0,'review grants no authority');
  const confirm=()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Accept current authority and continue')!;
  assert(confirm().disabled,'fresh explicit consent required');(host.querySelector('input[type="checkbox"]') as HTMLInputElement).click();await settle();
  if(mode==='quota'||mode==='security')Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('Controlled storage failure',mode==='quota'?'QuotaExceededError':'SecurityError');return setItem.call(this,k,v)};
  await click('Accept current authority and continue');
  if(mode==='normal'){
   assert(posts===1&&localStorage.getItem(key),'one lost-result mutation retained');root.unmount();root=createRoot(host);await mount();assert(reviews===2&&posts===1,'remount cannot review or POST');await click('Look up original continuation result');assert(gets===1&&posts===1&&host.textContent?.includes('Fresh continuation accepted'),'original-key recovery only');
  }else if(mode==='stale')assert(posts===0&&!(host.querySelector('input[type="checkbox"]') as HTMLInputElement|null)?.checked,'authority drift invalidates consent before mutation');
  else assert(posts===0&&localStorage.getItem(key)===null&&host.textContent?.includes('Controlled storage failure'),'storage exception stops mutation');
  return {mode,posts,gets,reviews};
 }finally{Storage.prototype.setItem=setItem;window.fetch=transport;root.unmount();host.remove();if(prior===null)localStorage.removeItem(key);else localStorage.setItem(key,prior)}
}

export async function foreignContinuationQuotaRegression(){await foreignContinuationRegression('quota');}
export async function foreignContinuationSecurityRegression(){await foreignContinuationRegression('security');}
export async function foreignContinuationStaleRegression(){await foreignContinuationRegression('stale');}
