import {createRoot} from 'react-dom/client';
import {StrictMode} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {MessageDeliveryReceiptDto} from '@ponderosa/core';
import {MessageDeliveryStatus} from '../../apps/web/src/components/MessageDeliveryStatus';

const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const statusKey='ponderosa.reviewed-continuation.v1:dev:project-one:steer-one';
const releaseKey=statusKey+':source-release';
export async function reviewedContinuationRegression():Promise<void>{
 const oldFetch=window.fetch,oldStorage=localStorage.getItem(statusKey),oldRelease=localStorage.getItem(releaseKey),oldSetItem=Storage.prototype.setItem,host=document.createElement('div');document.body.append(host);
 let root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const receipt={activationId:'steer-one',targetAgentId:'agent-one',state:'unconfirmed',injectionKind:'steer',injectionId:'injection-one',updatedAt:'now',attemptCount:1} as MessageDeliveryReceiptDto;
 const review={projectId:'project-one',activationId:'steer-one',agentId:'agent-one',conversationId:'chat-one',runId:'run-one',injectionId:'injection-one',reviewSha256:'a'.repeat(64),originalOutcome:'unknown',replayAuthorized:false,
  originalTask:{communication:{projectId:'project-one',conversationId:'chat-one',sender:{kind:'user',userId:'user'},text:'Finish the complete original task',attachments:[{id:'task-file',name:'task-notes.txt'}]}},
  originalSteer:{communication:{projectId:'project-one',conversationId:'chat-one',sender:{kind:'user',userId:'user'},text:'Also include the correction',attachments:[{id:'steer-file',name:'correction.pdf'}]}},
  effectInventory:{effects:[{kind:'communication',outcome:'host_committed',detail:'already settled'},{kind:'tool_call',outcome:'unknown',detail:'Tool effect is unconfirmed'}],nativeTail:'unknown',sourceWork:'held_unknown',replayAuthorized:false}};
 let strict=false,recorded=false,loseResponse=true,commitOnLoss=true,badReceipt=false,otherCommand=false,unavailable=false,holdRead=false,holdPost=false,retirementNeeded=false,retirementLost=false,retirementFails=false,holdRetire=false,retirePosts=0,releaseRetire:()=>void=()=>{},releaseRead:()=>void=()=>{},releasePost:()=>void=()=>{},posts:Array<Record<string,unknown>>=[],gets=0;
 const result=async()=>{
  const saved=JSON.parse(localStorage.getItem(statusKey)??'null');
  const input=saved?{activationId:saved.activationId,effectsReviewed:true,idempotencyKey:saved.idempotencyKey,projectId:saved.projectId,...(saved.reviewNote!==undefined?{reviewNote:saved.reviewNote}:{}),reviewSha256:saved.reviewSha256}:{};
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(input)));
  const commandSha256=otherCommand?'b'.repeat(64):Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  return {status:'continuation_recorded',receipt:{accepted:true,sourceActivationId:'steer-one',activationId:'successor-one',sourceRunId:'run-one',injectionId:'injection-one',reviewSha256:'a'.repeat(64),commandSha256,originalOutcome:'unknown',replayAuthorized:false,activationState:'pending'}};
 };
 window.fetch=async(input,init)=>{
  assert(String(input).includes('/api/projects/project-one/message-deliveries/steer-one/reviewed-continuation'),'Exact scoped endpoint required');
  if(String(input).endsWith('/retire-source')){
   assert(init?.method==='POST'&&!init.body,'Release requires the scoped POST without user-supplied effects');
   retirePosts++;
   if(holdRetire)await new Promise<void>(resolve=>{releaseRetire=resolve;});
   if(retirementFails)return new Response(JSON.stringify({error:'The earlier session is still active.'}),{status:409,headers:{'content-type':'application/json'}});
   retirementNeeded=false;
   if(retirementLost)throw Error('Controlled lost retirement response');
   return new Response(JSON.stringify({status:'source_retired',originalOutcome:'unknown'}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(init?.method==='POST'){posts.push(JSON.parse(String(init.body)));if(holdPost)await new Promise<void>(resolve=>{releasePost=resolve;});if(loseResponse){recorded=commitOnLoss;throw Error('Controlled lost response');}recorded=true;return new Response(JSON.stringify(await result()),{status:200,headers:{'content-type':'application/json'}});}
  if(holdRead)await new Promise<void>(resolve=>{releaseRead=resolve;});
  gets++;if(unavailable)return new Response(JSON.stringify({error:'The original Run is still active.'}),{status:409,headers:{'content-type':'application/json'}});
  if(retirementNeeded)return new Response(JSON.stringify({status:'source_retirement_required',originalOutcome:'unknown'}),{status:200,headers:{'content-type':'application/json'}});
  const data=recorded?await result():{status:'review_required',review};if(badReceipt&&data.status==='continuation_recorded')data.receipt.sourceActivationId='other-steer';
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 };
 const render=async()=>{const view=<QueryClientProvider client={client}><MessageDeliveryStatus projectId="project-one" receipts={[receipt]} recipientName={()=> 'Worker'}/></QueryClientProvider>;root.render(strict?<StrictMode>{view}</StrictMode>:view);await flush();};
 const button=(label:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent?.trim()===label);
 try{
  localStorage.removeItem(statusKey);localStorage.removeItem(releaseKey);await render();button('Review interrupted work')!.click();await flush();
  assert(document.body.textContent?.includes('Finish the complete original task')&&document.body.textContent?.includes('Also include the correction'),'Original task and instruction must be shown');
  assert(document.body.textContent?.includes('task-notes.txt')&&document.body.textContent?.includes('correction.pdf'),'Original attachment names must remain visible');
  assert(document.body.textContent?.includes('Tool effect is unconfirmed')&&!document.body.textContent?.includes('already settled'),'Only unresolved effects request review');
  const check=document.querySelector<HTMLInputElement>('input[type=checkbox]')!;check.click();await flush();
  const note=document.querySelector<HTMLTextAreaElement>('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(note,'Already checked the deployment');note.dispatchEvent(new Event('input',{bubbles:true}));await flush();
  button('Continue task')!.click();await flush();
  assert(posts.length===1&&gets>=2,'Lost response is reconciled with a read, without replaying the command');
  assert(posts[0].effectsReviewed===true&&posts[0].reviewNote==='Already checked the deployment','Acknowledgement and optional note are preserved');
  const saved=JSON.parse(localStorage.getItem(statusKey)!);
  assert(saved.idempotencyKey===posts[0].idempotencyKey&&saved.reviewNote===posts[0].reviewNote,'Exact submitted command is durable');
  assert(document.body.textContent?.includes('Continuation authorized')&&document.body.textContent?.includes('pending'),'Confirmed receipt is displayed automatically');
  root.unmount();host.replaceChildren();root=createRoot(host);posts=[];recorded=false;loseResponse=false;localStorage.setItem(statusKey,JSON.stringify(saved));
  await render();button('Review interrupted work')!.click();await flush();
  assert(posts.length===0&&button('Retry same request'),'Reopening never resubmits automatically');
  button('Retry same request')!.click();await flush();
  assert(posts.length===1&&posts[0].idempotencyKey===saved.idempotencyKey&&posts[0].reviewNote===saved.reviewNote,'Explicit retry reuses the exact command');
  root.unmount();host.replaceChildren();root=createRoot(host);posts=[];recorded=true;otherCommand=true;
  await render();button('Review interrupted work')!.click();await flush();
  assert(posts.length===0&&document.body.textContent?.includes('A different continuation was authorized')&&document.body.textContent?.includes('Your saved request was not confirmed'),'A different operator command is not presented as this saved request');
  root.unmount();host.replaceChildren();root=createRoot(host);localStorage.setItem(statusKey,'{damaged');posts=[];recorded=false;otherCommand=false;
  await render();button('Review interrupted work')!.click();await flush();
  assert(posts.length===0&&localStorage.getItem(statusKey)==='{damaged'&&!button('Continue task'),'Damaged saved evidence blocks continuation without deletion');
  root.unmount();host.replaceChildren();root=createRoot(host);localStorage.removeItem(statusKey);
  Storage.prototype.setItem=function(key,value){if(key===statusKey)throw Error('Controlled storage denial');return oldSetItem.call(this,key,value);};
  await render();button('Review interrupted work')!.click();await flush();document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();await flush();button('Continue task')!.click();await flush();
  assert(posts.length===0&&document.body.textContent?.includes('Controlled storage denial'),'A command is never sent when its identity cannot be saved');
  Storage.prototype.setItem=oldSetItem;
  root.unmount();host.replaceChildren();root=createRoot(host);localStorage.removeItem(statusKey);recorded=true;badReceipt=true;
  await render();button('Review interrupted work')!.click();await flush();
  assert(posts.length===0&&document.body.textContent?.includes('receipt could not be verified')&&!button('Continue task'),'A receipt for another instruction is not accepted');
  root.unmount();host.replaceChildren();root=createRoot(host);recorded=false;badReceipt=false;unavailable=true;
  await render();button('Review interrupted work')!.click();await flush();
  assert(posts.length===0&&document.body.textContent?.includes('The original Run is still active.'),'Ineligible evidence displays the actual cause without guessing completion');
  root.unmount();host.replaceChildren();root=createRoot(host);unavailable=false;recorded=false;loseResponse=true;commitOnLoss=false;localStorage.removeItem(statusKey);
  await render();button('Review interrupted work')!.click();await flush();document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();await flush();button('Continue task')!.click();await flush();
  assert(posts.length===1&&localStorage.getItem(statusKey)!==null,'Unconfirmed command remains saved');
  recorded=true;await new Promise(resolve=>setTimeout(resolve,3200));await flush();
  assert(posts.length===1&&document.body.textContent?.includes('Continuation authorized')&&!document.body.textContent?.includes('Controlled lost response'),'Later conclusive receipt clears the stale error without resubmitting');
  root.unmount();host.replaceChildren();root=createRoot(host);recorded=false;posts=[];localStorage.removeItem(statusKey);loseResponse=false;
  await render();button('Review interrupted work')!.click();await flush();document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();await flush();
  holdRead=true;button('Continue task')!.click();await flush();assert(!button('Close')?.disabled,'A stalled read does not trap the dialog');
  button('Close')!.click();await flush();holdRead=false;releaseRead();await flush();
  assert(posts.length===0&&localStorage.getItem(statusKey)===null,'Closing during a pre-submit read prevents later dispatch');
  button('Review interrupted work')!.click();await flush();document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();await flush();
  holdPost=true;button('Continue task')!.click();await flush();assert(posts.length===1&&!button('Close')?.disabled&&localStorage.getItem(statusKey)!==null,'In-flight command is saved and dialog can close');
  button('Close')!.click();await flush();holdPost=false;releasePost();await flush();
  button('Review interrupted work')!.click();await flush();
  assert(posts.length===1&&document.body.textContent?.includes('Continuation authorized'),'Reopening checks the in-flight result without another submission');
  root.unmount();host.replaceChildren();root=createRoot(host);recorded=false;posts=[];localStorage.removeItem(statusKey);retirementNeeded=true;retirementLost=true;retirePosts=0;
  await render();assert(document.body.textContent?.includes('Review may close the completed Run’s idle session.'),'Session release is disclosed before opening review');
  button('Review interrupted work')!.click();await flush();
  assert(retirePosts===1&&posts.length===0&&document.body.textContent?.includes('Finish the complete original task'),'A lost release response is read back once without authorizing continuation');
  root.unmount();host.replaceChildren();root=createRoot(host);retirementNeeded=true;retirementLost=false;retirementFails=true;retirePosts=0;localStorage.removeItem(releaseKey);
  await render();button('Review interrupted work')!.click();await flush();
  assert(retirePosts===1&&posts.length===0&&document.body.textContent?.includes('The earlier session is still active.')&&!button('Continue task'),'An unsuccessful release reports its real hold');
  button('Check status')!.click();await flush();assert(retirePosts===1&&document.body.textContent?.includes('The earlier session is still active.'),'Status checks never repeat session release or hide its hold');
  button('Close')!.click();await flush();button('Review interrupted work')!.click();await flush();
  assert(retirePosts===1&&document.body.textContent?.includes('session release is unconfirmed'),'Reopening does not repeat an uncertain release');
  root.unmount();host.replaceChildren();root=createRoot(host);retirementNeeded=true;retirementFails=false;holdRetire=true;retirePosts=0;localStorage.removeItem(releaseKey);
  await render();button('Review interrupted work')!.click();await flush();assert(retirePosts===1&&localStorage.getItem(releaseKey)!==null,'Release identity is saved before dispatch');
  button('Close')!.click();await flush();button('Review interrupted work')!.click();await flush();
  assert(retirePosts===1&&document.body.textContent?.includes('session release is unconfirmed'),'An in-flight release is not repeated on reopening');
  holdRetire=false;releaseRetire();await flush();await new Promise(resolve=>setTimeout(resolve,3200));await flush();
  assert(retirePosts===1&&document.body.textContent?.includes('Finish the complete original task'),'A conclusive later read opens the original review automatically without repeating release');
  root.unmount();host.replaceChildren();root=createRoot(host);retirementNeeded=true;retirePosts=0;localStorage.removeItem(releaseKey);
  Storage.prototype.setItem=function(key,value){if(key===releaseKey)throw Error('Release storage denied');return oldSetItem.call(this,key,value);};
  await render();button('Review interrupted work')!.click();await flush();
  assert(retirePosts===0&&document.body.textContent?.includes('No release was sent'),'No session release occurs without durable intent');
  Storage.prototype.setItem=oldSetItem;
  root.unmount();host.replaceChildren();root=createRoot(host);retirementNeeded=true;holdRetire=true;retirePosts=0;strict=true;localStorage.removeItem(releaseKey);
  await render();button('Review interrupted work')!.click();await flush();
  assert(retirePosts===1,'Repeated effect setup cannot submit source release twice');
  holdRetire=false;releaseRetire();await flush();
  root.unmount();host.replaceChildren();root=createRoot(host);retirementNeeded=false;retirementFails=false;strict=false;
  Object.assign(review.originalTask.communication.attachments[0],{unavailable:true});
  await render();button('Review interrupted work')!.click();await flush();document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();await flush();
  assert(button('Continue task')?.disabled&&document.body.textContent?.includes('original attachment is unavailable')&&posts.length===0,'An explicitly unavailable original attachment holds continuation');
  delete (review.originalTask.communication.attachments[0] as {unavailable?:boolean}).unavailable;
  root.unmount();host.replaceChildren();root=createRoot(host);
  review.originalSteer.communication.projectId='other-project';
  await render();button('Review interrupted work')!.click();await flush();
  assert(posts.length===0&&document.body.textContent?.includes('original task or instruction could not be verified')&&!button('Continue task'),'Wrong-project instruction cannot authorize continuation');
  review.originalSteer.communication.projectId='project-one';
  root.unmount();host.replaceChildren();root=createRoot(host);
  root.render(<QueryClientProvider client={client}><MessageDeliveryStatus projectId="project-one" receipts={[{...receipt,state:'queued'}]} recipientName={()=> 'Worker'}/></QueryClientProvider>);await flush();
  assert(!button('Review interrupted work'),'Automatically queued steering does not ask for review');
 }finally{Storage.prototype.setItem=oldSetItem;root.unmount();client.clear();window.fetch=oldFetch;if(oldStorage===null)localStorage.removeItem(statusKey);else localStorage.setItem(statusKey,oldStorage);if(oldRelease===null)localStorage.removeItem(releaseKey);else localStorage.setItem(releaseKey,oldRelease);host.remove();}
}
