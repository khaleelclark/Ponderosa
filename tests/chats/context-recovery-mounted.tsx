// Deferred mounted regression; execute only during the authorized combined pass.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MutationNotificationProvider} from '../../apps/web/src/components/MutationNotifications';
import {ContextRecoveryPanel} from '../../apps/web/src/components/ContextRecoveryPanel';
import {api} from '../../apps/web/src/api';
const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
export async function contextRecoveryControlsRegression():Promise<void>{
 const original={getContextRecovery:api.getContextRecovery,recoverContext:api.recoverContext,stopContextRecovery:api.stopContextRecovery,dismissContextRecovery:api.dismissContextRecovery};
 const storageKey='ponderosa.context-recovery:fixture-agent',saved=localStorage.getItem(storageKey);localStorage.removeItem(storageKey);
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 let state:Awaited<ReturnType<typeof api.getContextRecovery>>={support:{status:'managed_compaction',crashReconciliation:'hold_without_native_query'},boundary:{providerSessionId:'session',sourceRunId:'source-run',toolContractHash:'a'.repeat(64),sourceFence:7},request:null};
 const reads:Array<string|undefined>=[],starts:Parameters<typeof api.recoverContext>[1][]=[],stops:string[]=[],dismissals:string[]=[];
 const snapshots:Array<{key:string|undefined;requestId:string|undefined;phase:string|undefined}>=[];
 let readFailure=false;
 let finish:(value:unknown)=>void=()=>{};
 api.getContextRecovery=async(_agent,key)=>{reads.push(key);if(readFailure)throw Error('Recovery status read failed');snapshots.push({key,requestId:state.request?.id,phase:state.request?.progress?.phase});return structuredClone(state);};
 api.recoverContext=async(_agent,input)=>{starts.push(input);state={...state,request:{id:starts.length===1?'exact-recovery':'stopped-recovery',agentId:'fixture-agent',projectId:'project',scopeKey:'scope',sourceRunId:'source-run',providerSessionId:'session',toolContractHash:'a'.repeat(64),sourceFence:7,state:'unsupported_fenced',code:'provider_context_recovery_source_work_held',createdAt:'now',...(starts.length===1?{}:{progress:{phase:'native_started' as const,updatedAt:'now',sourceWork:'held_unknown' as const}})}};return new Promise(resolve=>{finish=resolve;});};
 api.stopContextRecovery=async(_agent,id)=>{stops.push(id);state={...state,request:{...state.request!,progress:{phase:'held',updatedAt:'now',sourceWork:'held_unknown',nativeInvoked:true}}};return {stopRequested:true};};
 api.dismissContextRecovery=async(_agent,id)=>{dismissals.push(id);state={...state,request:null,boundary:null};return {recovered:false};};
 const button=(text:string)=>Array.from(host.querySelectorAll('button')).find(item=>item.textContent===text)!;
 const flush=async()=>{for(let index=0;index<8;index++)await tick();};
 const waitFor=async(condition:()=>boolean,message:string)=>{const until=Date.now()+5500;while(!condition()){assert(Date.now()<until,message);await new Promise(resolve=>setTimeout(resolve,25));}await flush();};
 try{
  root.render(<QueryClientProvider client={client}><MutationNotificationProvider><ContextRecoveryPanel agentId="fixture-agent"/></MutationNotificationProvider></QueryClientProvider>);await flush();
  assert(reads.length===0&&starts.length===0,'mount performs no inspection or native recovery');
  button('Context Recovery').click();await flush();
  assert(button('Request Context Recovery').disabled,'unknown effects require explicit acknowledgement');
  host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();await flush();button('Request Context Recovery').click();await flush();
  assert(starts.length===1&&starts[0].expectedSourceRunId==='source-run'&&starts[0].expectedSessionId==='session','request binds the inspected boundary');
  assert(localStorage.getItem(storageKey)===starts[0].idempotencyKey,'exact key retained before native call');
  await waitFor(()=>snapshots.some(row=>row.key===starts[0].idempotencyKey&&row.requestId==='exact-recovery'&&row.phase===undefined),'first exact-key read returns a recorded request before native progress exists');
  assert(host.textContent?.includes('Recovery request pending')&&!host.textContent?.includes('unsupported hold'),'missing progress is pending evidence, not an invented unsupported hold');
  state={...state,request:{...state.request!,progress:{phase:'reserved',updatedAt:'now',sourceWork:'held_unknown'}}};
  await waitFor(()=>Boolean(host.textContent?.includes('Recorded Phase: reserved')),'pending POST automatically refreshes the same operation to reserved');
  state={...state,request:{...state.request!,progress:{phase:'native_started',updatedAt:'now',sourceWork:'held_unknown',nativeInvoked:true}}};
  await waitFor(()=>Boolean(host.textContent?.includes('Recorded Phase: native started')),'same pending operation automatically displays native progress');
  state={...state,request:{...state.request!,progress:{phase:'context_accepted',updatedAt:'now',sourceWork:'held_unknown',nativeInvoked:true}}};
  await waitFor(()=>Boolean(host.textContent?.includes('Context measurement accepted')),'accepted evidence arrives without manual Reload or another POST');
  assert(button('Dismiss Settled Hold').disabled&&starts.length===1,'accepted projection cannot bypass pending response or replay recovery');
  finish({});await flush();
  const acceptedAck=Array.from(host.querySelectorAll('label')).find(item=>item.textContent?.includes('dismissal leaves original work unresolved'))!;
  acceptedAck.querySelector<HTMLInputElement>('input')!.click();await flush();button('Dismiss Settled Hold').click();await flush();
  assert(dismissals.join()==='exact-recovery'&&starts.length===1,'accepted dismissal targets the exact operation without another native call');
  // A separate eligible boundary retains the original Stop/held-control coverage.
  state={...state,request:null,boundary:{providerSessionId:'session',sourceRunId:'source-run',toolContractHash:'a'.repeat(64),sourceFence:7}};
  button('Reload Recovery Status').click();await flush();
  host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();await flush();button('Request Context Recovery').click();await flush();
  assert(starts.length===2&&starts[1].idempotencyKey!==starts[0].idempotencyKey,'only a new acknowledged boundary creates a new exact recovery key');
  button('Reload Recovery Status').click();await flush();
  assert(reads.includes(starts[1].idempotencyKey),'in-flight inspection uses exact key');
  button('Stop Exact Recovery').click();await flush();
  assert(stops.join()==='stopped-recovery','Stop stays available during pending recovery and targets exact operation');
  assert(button('Dismiss Settled Hold').disabled,'settled hold cannot dismiss while initial request is pending');
  finish({});await flush();
  const heldRequest=state.request;
  const acknowledgement=Array.from(host.querySelectorAll('label')).find(item=>item.textContent?.includes('dismissal leaves original work unresolved'))!;
  acknowledgement.querySelector<HTMLInputElement>('input')!.click();await flush();button('Dismiss Settled Hold').click();await flush();
  assert(dismissals.join()==='exact-recovery,stopped-recovery','explicit dismissals target their own settled operations');
  assert(starts.length===2,'status polling, Stop and dismissal never replay either recovery or original work');
  const stale=()=>host.textContent?.includes('Last Loaded Result');
  assert(host.textContent?.includes('No Eligible Retained Context Boundary Is Available.')&&!stale(),'fresh no-boundary evidence is not marked stale');
  readFailure=true;button('Reload Recovery Status').click();await flush();
  assert(host.textContent?.includes('Recovery status read failed')&&stale(),'failed GET labels retained result while preserving its exact error');
  assert(host.textContent?.includes('No Eligible Retained Context Boundary Is Available.')&&host.textContent?.includes('Source Evidence · Last Loaded'),'prior result and source evidence remain clearly historical');
  readFailure=false;button('Reload Recovery Status').click();await flush();
  assert(!stale()&&!host.textContent?.includes('Source Evidence · Last Loaded'),'successful retry restores fresh result labels');
  state={...state,request:heldRequest};button('Reload Recovery Status').click();await flush();
  assert(host.textContent?.includes('Recorded Phase: held')&&button('Dismiss Settled Hold').disabled,'recorded request and dismissal acknowledgement guards remain intact');
  api.stopContextRecovery=async()=>{throw Error('Exact recovery stop failed');};
  button('Stop Exact Recovery').click();await flush();
  assert(host.textContent?.includes('Exact recovery stop failed')&&!stale(),'mutation error alone does not mark the successful status GET stale');

 }finally{finish({});root.unmount();client.clear();host.remove();Object.assign(api,original);if(saved===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,saved);}
}

export async function assistantGuidedRecoveryMountedRegression():Promise<void>{await guidedRecoveryFixture(false);}
export async function assistantRecoveryRetainedKeyMountedRegression():Promise<void>{await guidedRecoveryFixture(true);}
async function guidedRecoveryFixture(retained:boolean):Promise<void>{
 const original={getContextRecovery:api.getContextRecovery,recoverContext:api.recoverContext,stopContextRecovery:api.stopContextRecovery,dismissContextRecovery:api.dismissContextRecovery};
 const storageKey='ponderosa.context-recovery:guided-fixture',saved=localStorage.getItem(storageKey);localStorage.removeItem(storageKey);
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const boundary={providerSessionId:'retained-session',sourceRunId:'unknown-original',toolContractHash:'a'.repeat(64),sourceFence:7};
 if(retained)localStorage.setItem(storageKey,JSON.stringify({key:'retained-before-dispatch',boundary,productPath:'/api/agents/guided-fixture/context-recoveries'}));
 let request:Awaited<ReturnType<typeof api.getContextRecovery>>['request']=null,native=0,readFailure=retained;
 const notifications:Array<{dismiss?:boolean;message?:string}|string>=[];
 const posts:Parameters<typeof api.recoverContext>[1][]=[],reads:Array<string|undefined>=[];
 api.getContextRecovery=async(_agent,key)=>{reads.push(key);if(readFailure)throw Error('Controlled recovery read unavailable');return {support:{status:'managed_compaction',crashReconciliation:'hold_without_native_query'},boundary:request?.state==='dismissed'?null:boundary,request:request&&structuredClone(request),operationState:'idle'};};
 api.recoverContext=async(_agent,input)=>{
  posts.push(input);const persisted=JSON.parse(localStorage.getItem(storageKey)!);
  assert(persisted.key===input.idempotencyKey&&persisted.boundary.sourceFence===7,'exact key and frozen fence are durable before POST');
  if(!request){native++;request={id:'recorded-recovery',agentId:'guided-fixture',projectId:'fixture-project',scopeKey:'scope',...boundary,state:'unsupported_fenced',code:'provider_context_recovery_source_work_held',createdAt:'now',progress:{phase:'context_accepted',updatedAt:'accepted',sourceWork:'held_unknown',nativeInvoked:true}};throw Error('Controlled lost recovery response');}
  assert(input.idempotencyKey===posts[0].idempotencyKey,'reconciliation keeps exact operation identity');request={...request,state:'dismissed'};return {recoveredContext:true,sourceWork:'held_unknown'};
 };
 api.dismissContextRecovery=async()=>{throw Error('Guided recovery must not require a separate dismissal');};
 const waitFor=async(check:()=>boolean,label:string)=>{const end=Date.now()+8000;while(!check()){assert(Date.now()<end,label);await new Promise(resolve=>setTimeout(resolve,20));}await tick();};
 try{
  root.render(<QueryClientProvider client={client}><MutationNotificationProvider notifier={notice=>notifications.push(notice)}><ContextRecoveryPanel agentId="guided-fixture" guided required assistant/></MutationNotificationProvider></QueryClientProvider>);
  if(retained){
   await waitFor(()=>Boolean(host.textContent?.includes('Recovery Status Unavailable')),'failed status read stays actionable');
   Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Review Recovery')!.click();
   await waitFor(()=>Boolean(document.querySelector('[role="dialog"]')),'read retry opens existing recovery details');
   const retry=()=>Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll('button')).find(b=>b.textContent==='Check Recovery Status')!;
   await waitFor(()=>!retry().disabled,'failed read retry available');retry().click();
   await waitFor(()=>notifications.some(n=>typeof n!=='string'&&n.message==='Recovery Check Failed'),'failed explicit read reports its error');
   readFailure=false;await waitFor(()=>!retry().disabled,'successful read retry available');retry().click();
   await waitFor(()=>notifications.some(n=>typeof n!=='string'&&n.dismiss),'successful read retry clears its prior action feedback');
   assert(posts.length===0&&localStorage.getItem(storageKey)?.includes('retained-before-dispatch'),'status retry neither submits recovery nor loses its key');
   Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll('button')).find(b=>b.textContent==='Close')!.click();await tick();
  }
  await waitFor(()=>Boolean(host.textContent?.includes('Assistant Needs Recovery')),'canonical saved-input blocker is reachable in Assistant chat');
  assert(!host.textContent?.includes('Context Handoff Held')&&posts.length===0,'reading the blocker does not compact or render internal hold wording');
  Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Recover Assistant')!.click();
  await waitFor(()=>Boolean(document.querySelector('[role="dialog"]')),'guided consent dialog opens');
  const dialog=document.querySelector('[role="dialog"]')!;assert(dialog.textContent?.includes('without repeating the earlier task'),'one explanation preserves prior uncertainty');
  const action=retained?'Reconcile Exact Recovery':'Recover Assistant';
  await waitFor(()=>!Array.from(dialog.querySelectorAll('button')).find(b=>b.textContent===action)!.disabled,'fresh boundary ready');
  Array.from(dialog.querySelectorAll('button')).find(b=>b.textContent===action)!.click();
  await waitFor(()=>posts.length===2&&localStorage.getItem(storageKey)==='','recorded completion is reconciled and settled automatically after a lost response');
  assert(native===1&&posts.every(p=>p.settleRecoveredContext===true&&p.expectedSourceRunId===boundary.sourceRunId&&p.expectedSourceFence===7),'guided flow compacts once and binds the same source/fence');
  assert(reads.includes(posts[0].idempotencyKey),'lost responses are read back by the retained exact key');
  if(retained)assert(posts.every(p=>p.idempotencyKey==='retained-before-dispatch'),'retained key with no recorded result is reconciled without a new key');
 }finally{root.unmount();client.clear();host.remove();Object.assign(api,original);if(saved===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,saved);}
}

export async function recoveryIdleReservationReviewMountedRegression():Promise<void>{
 const original={getContextRecovery:api.getContextRecovery,recoverContext:api.recoverContext};let posts=0;
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 let phase:'reserved'|'drained'|undefined;
 api.getContextRecovery=async()=>({support:{status:'managed_compaction',crashReconciliation:'hold_without_native_query'},boundary:null,operationState:'idle',request:{id:'recorded-idle',agentId:'idle-fixture',projectId:'project',scopeKey:'scope',providerSessionId:'session',sourceRunId:'source',toolContractHash:'a'.repeat(64),sourceFence:7,state:'unsupported_fenced',code:'provider_context_recovery_source_work_held',createdAt:'now',...(phase?{progress:{phase,updatedAt:'now',sourceWork:'held_unknown'}}:{})}});
 api.recoverContext=async()=>{posts++;return {};};
 try{
  for(phase of [undefined,'reserved','drained']){
   root.render(<QueryClientProvider client={client}><MutationNotificationProvider><ContextRecoveryPanel key={phase??'none'} agentId="idle-fixture" guided required assistant onReview={()=>{}}/></MutationNotificationProvider></QueryClientProvider>);
   await client.invalidateQueries({queryKey:['context-recovery']});for(let i=0;i<12;i++)await tick();
   assert(host.textContent?.includes('Recovery Needs Review'),'idle recorded recovery has a specific review status');
   Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Review Recovery')!.click();for(let i=0;i<8;i++)await tick();
   const dialog=document.querySelector('[role="dialog"]')!;
   assert(dialog.textContent?.includes('Review Agent Activity')&&!dialog.textContent?.includes('Reconcile Exact Recovery'),'reserved/no-progress recovery offers review instead of a no-progress Retry');
   Array.from(dialog.querySelectorAll('button')).find(b=>b.textContent==='Close')!.click();for(let i=0;i<8;i++)await tick();
  }
  assert(posts===0,'idle reservation inspection never dispatches native recovery');
 }finally{root.unmount();client.clear();host.remove();Object.assign(api,original);}
}

export async function recoveryAutomaticReconciliationRetryMountedRegression():Promise<void>{
 const original={getContextRecovery:api.getContextRecovery,recoverContext:api.recoverContext};
 const agentId='auto-recovery-fixture',storageKey=`ponderosa.context-recovery:${agentId}`,saved=localStorage.getItem(storageKey);localStorage.setItem(storageKey,'exact-accepted-key');
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});let release=()=>{},locked=false,reads=0,posts=0,dismissed=false,transient=0;
 const lock=navigator.locks.request(`ponderosa.context-recovery:/api/agents/${agentId}/context-recoveries`,async()=>{locked=true;await new Promise<void>(resolve=>release=resolve);});
 const notifications:Array<{dismiss?:boolean}|string>=[];
 const waitFor=async(check:()=>boolean,label:string)=>{const end=Date.now()+8000;while(!check()){assert(Date.now()<end,label);await new Promise(resolve=>setTimeout(resolve,20));}};
 api.getContextRecovery=async()=>{reads++;if(reads===3){transient++;throw Error('Controlled transient 503 read');}return {support:{status:'managed_compaction',crashReconciliation:'hold_without_native_query'},boundary:null,operationState:'idle',request:{id:'accepted-operation',agentId,projectId:'project',scopeKey:'scope',providerSessionId:'session',sourceRunId:'source',toolContractHash:'a'.repeat(64),sourceFence:7,state:dismissed?'dismissed':'unsupported_fenced',code:'provider_context_recovery_source_work_held',createdAt:'now',progress:{phase:'context_accepted',updatedAt:'accepted',sourceWork:'held_unknown',nativeInvoked:true}}};};
 api.recoverContext=async(_agent,input)=>{assert(input.idempotencyKey==='exact-accepted-key','automatic reconciliation keeps the same key');posts++;dismissed=true;return {recoveredContext:true};};
 try{
  await waitFor(()=>locked,'competing tab owns the same recovery lock');
  root.render(<QueryClientProvider client={client}><MutationNotificationProvider notifier={notice=>notifications.push(notice)}><ContextRecoveryPanel agentId={agentId} guided required assistant/></MutationNotificationProvider></QueryClientProvider>);
  await waitFor(()=>reads>=2,'busy lock caused a read-only refresh instead of dispatch');assert(posts===0,'busy lock dispatches nothing');release();await lock;
  await waitFor(()=>posts===1&&localStorage.getItem(storageKey)==='','bounded safe reconciliation survives lock contention and a transient read failure');assert(transient===1&&reads>=6,'the failed read was retried without native replay');
  assert(notifications.every(notice=>typeof notice!=='string'&&notice.dismiss),'successful automatic reconciliation never emits an attention snackbar');
 }finally{release();await lock;root.unmount();client.clear();host.remove();Object.assign(api,original);if(saved===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,saved);}
}
