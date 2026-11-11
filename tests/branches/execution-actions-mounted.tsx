// Actual ExecutionPanel, React Query and MUI; controlled reads only, no provider.
import {MutationNotificationProvider} from '../../apps/web/src/components/MutationNotifications';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {DEFAULT_ASSET_LIMITS} from '@ponderosa/core';
import {ExecutionPanel} from '../../apps/web/src/components/branches/ExecutionPanel';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const until=async(test:()=>boolean,label:string)=>{const end=performance.now()+3000;while(!test()){if(performance.now()>end)throw Error(label);await new Promise(resolve=>setTimeout(resolve,10));}};
const input=(element:HTMLTextAreaElement,value:string)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));};
export async function executionActionsRevisionSyncRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),original=globalThis.fetch;
 const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false,gcTime:Infinity},mutations:{retry:false}}}),viewStates=new Map();
 const actionsKey=['branch-execution-actions','race-run'],posts:string[]=[],gets:string[]=[];
 let detail:any={execution:{id:'race-run',branchId:'race-branch',versionId:'version',bindingRevisionId:'binding',state:'waiting',revision:1,input:'Input',inputHash:'hash',createdAt:'2026-11-06T12:00:00Z',updatedAt:'2026-11-06T12:00:00Z'},steps:[],attempts:[],gates:[],paths:[],resources:[],decisions:[],waits:[]};
 const gateStep={id:'gate-step',executionId:'race-run',stepId:'review',pathId:'gate-path',invocation:1,state:'waiting',input:'Original gate input'};
 const failedStep={id:'failed-step',executionId:'race-run',stepId:'work',pathId:'failed-path',invocation:1,state:'failed',input:'Original failed input'};
 const gate={id:'race-gate',executionId:'race-run',stepExecutionId:gateStep.id,revision:3,state:'waiting',purpose:'approval',prompt:'Review the result',proposal:'Original proposal',editable:true};
 const decision={id:'race-decision',projectId:'race-project',agentId:'race-agent',mode:'text',question:'Keep this separate Agent answer',options:[],allowOther:true,status:'pending'};
 const items=[{kind:'decision',decision},{kind:'gate',step:gateStep,gate},{kind:'attempt',step:failedStep,current:true,attempt:{id:'failed-attempt',stepExecutionId:failedStep.id,number:1,state:'failed',fence:1,error:'Original step failure'}}];
 let terminal=false;
 let revision=1,mode:'ok'|'delay'|'503'|'wrong-id'|'malformed'='ok',release:(()=>void)|undefined;
 let draft={conversationId:'agent:race-agent',ownerId:decision.id,text:'',attachmentIds:[],attachments:[],revision:0};
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(raw,init)=>{
  const url=new URL(String(raw),location.origin),method=init?.method??'GET';
  if(method==='POST'){posts.push(url.pathname);throw Error('This regression must never submit or replay an action');}
  if(url.pathname.includes('draft')){
   assert(url.href.includes('race-agent'),'Only this Decision owns draft reads/writes');
   if(method==='PUT'){const body=JSON.parse(String(init?.body));assert(body.ownerId===decision.id,'Exact Decision draft owner');draft={...draft,text:body.text,revision:draft.revision+1};}
   return json(draft);
  }
  assert(method==='GET','Only controlled projection reads are allowed');gets.push(url.pathname);
  if(url.pathname==='/api/decisions'){assert(url.searchParams.get('id')===decision.id,'Exact canonical Decision read');return json([decision]);}
  if(url.pathname.includes('limits'))return json(DEFAULT_ASSET_LIMITS);
  if(url.pathname.endsWith('/operations'))return json({executionId:'race-run',state:terminal?'completed':'waiting_human',label:terminal?'Completed':'Waiting on a person',observedAt:detail.execution.updatedAt,counts:{completed:terminal?1:0,running:0,retrying:0,failed:terminal?0:1,waitingAgent:0,waitingHuman:terminal?0:1,needsReconciliation:0,mapItems:0,mapSettled:0},agentWaits:[],additionalAgentWaits:0});
  if(url.pathname.endsWith('/actions')){
   const response={executionId:mode==='wrong-id'?'foreign-run':'race-run',revision,generation:'generation-'+revision,items:terminal?[]:items};
   if(mode==='503')return json({error:'Actions service temporarily unavailable'},503);
   if(mode==='malformed')return new Response('{not JSON',{headers:{'content-type':'application/json'}});
   if(mode==='delay')await new Promise<void>(resolve=>{release=resolve;});
   return json(response);
  }
  throw Error('Unexpected projection read '+url.pathname);
 };
 const render=()=>root.render(<QueryClientProvider client={client}><MutationNotificationProvider><ExecutionPanel detail={detail} viewStates={viewStates}/></MutationNotificationProvider></QueryClientProvider>);
 const button=(text:string)=>Array.from(host.querySelectorAll('button')).find(node=>node.textContent===text)!;
 const gateInput=()=>host.querySelector('textarea:not([aria-hidden="true"])') as HTMLTextAreaElement;
 const refresh=()=>client.invalidateQueries({queryKey:actionsKey,exact:true});
 try{
  render();await until(()=>Boolean(button('Approve')&&button('Retry Step')&&!button('Retry Step').disabled&&host.textContent?.includes('1 waiting for review')),'Initial actions did not load');
  assert(host.textContent?.includes('Approval Requested')&&host.textContent.includes('1 waiting for review'),'Fresh Gate shows its actual pending state');
  const proposal=gateInput();input(proposal,'Gate draft retained Ω');await until(()=>Boolean(button('Approve Edited Text')),'Gate edit not applied');
  button('Answer').click();await until(()=>Boolean(document.querySelector('[role="dialog"] textarea:not([aria-hidden="true"])')),'Decision dialog missing');
  const answer=document.querySelector('[role="dialog"] textarea:not([aria-hidden="true"])') as HTMLTextAreaElement;
  await until(()=>!answer.disabled,'Decision draft did not load');input(answer,'Separate Decision draft retained 🙂');
  revision=2;mode='delay';const delayed=refresh();await until(()=>Boolean(release),'Delayed action request did not start');
  release!();await delayed;
  await until(()=>Boolean(host.textContent?.includes('Refreshing Run actions')),'Revision synchronization was not shown neutrally');
  assert(!host.textContent?.includes('Decisions and failures could not refresh'),'Successful revision drift must not be a fetch warning');
  assert(proposal===gateInput()&&proposal.value==='Gate draft retained Ω','Gate draft node and value retained');
  assert(answer.isConnected&&answer.value==='Separate Decision draft retained 🙂','Open shared Decision draft retained');
  assert(button('Approve Edited Text').disabled&&button('Retry Step').disabled,'Known stale Branch actions remain disabled');
  assert(host.textContent?.includes('Refreshing Review…')&&!host.textContent.includes('Approval Requested'),'Stale Gate stays mounted with a neutral heading');
  assert(host.textContent?.includes('Review status refreshing')&&!host.textContent.includes('1 waiting for review'),'Stale action status never presents a current waiting count');
  assert(button('Refresh Run'),'Manual refresh remains available during synchronization');
  mode='ok';detail={...detail,execution:{...detail.execution,revision:2}};render();
  await until(()=>Boolean(!button('Retry Step').disabled&&!host.textContent?.includes('Refreshing Run actions')),'Matching revisions did not converge');
  assert(gateInput()===proposal&&proposal.value==='Gate draft retained Ω'&&answer.value==='Separate Decision draft retained 🙂','Convergence cannot replace dirty forms');
  assert(host.textContent?.includes('Approval Requested')&&host.textContent.includes('1 waiting for review'),'Fresh convergence restores the actual approval heading and count');
  for(const failure of ['503','wrong-id','malformed'] as const){
   mode=failure;await refresh();await until(()=>Boolean(host.textContent?.includes('Decisions and failures could not refresh')),'Real '+failure+' failure must remain visible');
   assert(button('Refresh Run'),'Real failure keeps manual recovery');
   assert(button('Retry Step').disabled&&button('Approve Edited Text').disabled,'Real failure never authorizes stale actions');
   assert(proposal.isConnected&&proposal.value==='Gate draft retained Ω'&&answer.isConnected&&answer.value==='Separate Decision draft retained 🙂','Real failure retains both dirty forms');
   if(failure==='503')assert(host.textContent?.includes('Actions service temporarily unavailable'),'Actual HTTP cause remains readable');
  }
  const cancel=Array.from(document.querySelectorAll('[role="dialog"] button')).find(node=>node.textContent==='Cancel') as HTMLButtonElement;assert(cancel,'Decision can be closed without submission');cancel.click();
  mode='ok';button('Refresh Run').click();await until(()=>!button('Retry Step').disabled,'Explicit recovery did not converge');
  // Terminal execution/operations can update before the current action page.
  // Preserve the mounted dirty Gate, but do not ask for stale approval or show0 waiting.
  terminal=true;revision=3;mode='delay';release=undefined;
  detail={...detail,execution:{...detail.execution,state:'completed',revision:3}};render();
  await until(()=>Boolean(release),'Terminal action refresh did not start');
  await client.invalidateQueries({queryKey:['branch-execution-operations','race-run'],exact:true});
  await until(()=>Boolean(host.textContent?.includes('Completed')),'Terminal operations header did not arrive');
  assert(gateInput()===proposal&&proposal.value==='Gate draft retained Ω'&&proposal.disabled,'Terminal refresh retains the same disabled dirty Gate');
  assert(host.textContent?.includes('Refreshing Review…')&&!host.textContent.includes('Approval Requested'),'Terminal header never coexists with a stale approval request');
  assert(host.textContent?.includes('Review status refreshing')&&!host.textContent.includes('0 waiting for review'),'Terminal action mismatch uses a neutral review-count cue');
  mode='ok';release!();await until(()=>!host.textContent?.includes('Refreshing Run actions'),'Terminal actions did not converge');
  assert(!gateInput()&&!host.textContent?.includes('Approval Requested'),'Only the fresh empty action page removes the settled Gate');
  assert(posts.length===0,'Read synchronization and recovery cannot replay any POST');
  assert(gets.filter(url=>url.endsWith('/actions')).length>=6,'Exercise actual action reads across success, delay and real failures');
 }finally{
  release?.();root.unmount();await client.cancelQueries();client.clear();host.remove();globalThis.fetch=original;
 }
}
