// Deferred mounted regression; execute only during the authorized combined pass.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
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
  root.render(<QueryClientProvider client={client}><ContextRecoveryPanel agentId="fixture-agent"/></QueryClientProvider>);await flush();
  assert(reads.length===0&&starts.length===0,'mount performs no inspection or native recovery');
  button('Context recovery').click();await flush();
  assert(button('Request context recovery').disabled,'unknown effects require explicit acknowledgement');
  host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();await flush();button('Request context recovery').click();await flush();
  assert(starts.length===1&&starts[0].expectedSourceRunId==='source-run'&&starts[0].expectedSessionId==='session','request binds the inspected boundary');
  assert(localStorage.getItem(storageKey)===starts[0].idempotencyKey,'exact key retained before native call');
  await waitFor(()=>snapshots.some(row=>row.key===starts[0].idempotencyKey&&row.requestId==='exact-recovery'&&row.phase===undefined),'first exact-key read returns a recorded request before native progress exists');
  assert(host.textContent?.includes('Recovery request pending')&&!host.textContent?.includes('unsupported hold'),'missing progress is pending evidence, not an invented unsupported hold');
  state={...state,request:{...state.request!,progress:{phase:'reserved',updatedAt:'now',sourceWork:'held_unknown'}}};
  await waitFor(()=>Boolean(host.textContent?.includes('Recorded phase: reserved')),'pending POST automatically refreshes the same operation to reserved');
  state={...state,request:{...state.request!,progress:{phase:'native_started',updatedAt:'now',sourceWork:'held_unknown',nativeInvoked:true}}};
  await waitFor(()=>Boolean(host.textContent?.includes('Recorded phase: native started')),'same pending operation automatically displays native progress');
  state={...state,request:{...state.request!,progress:{phase:'context_accepted',updatedAt:'now',sourceWork:'held_unknown',nativeInvoked:true}}};
  await waitFor(()=>Boolean(host.textContent?.includes('Context measurement accepted')),'accepted evidence arrives without manual Reload or another POST');
  assert(button('Dismiss settled hold').disabled&&starts.length===1,'accepted projection cannot bypass pending response or replay recovery');
  finish({});await flush();
  const acceptedAck=Array.from(host.querySelectorAll('label')).find(item=>item.textContent?.includes('dismissal leaves original work unresolved'))!;
  acceptedAck.querySelector<HTMLInputElement>('input')!.click();await flush();button('Dismiss settled hold').click();await flush();
  assert(dismissals.join()==='exact-recovery'&&starts.length===1,'accepted dismissal targets the exact operation without another native call');
  // A separate eligible boundary retains the original Stop/held-control coverage.
  state={...state,request:null,boundary:{providerSessionId:'session',sourceRunId:'source-run',toolContractHash:'a'.repeat(64),sourceFence:7}};
  button('Reload recovery status').click();await flush();
  host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();await flush();button('Request context recovery').click();await flush();
  assert(starts.length===2&&starts[1].idempotencyKey!==starts[0].idempotencyKey,'only a new acknowledged boundary creates a new exact recovery key');
  button('Reload recovery status').click();await flush();
  assert(reads.includes(starts[1].idempotencyKey),'in-flight inspection uses exact key');
  button('Stop exact recovery').click();await flush();
  assert(stops.join()==='stopped-recovery','Stop stays available during pending recovery and targets exact operation');
  assert(button('Dismiss settled hold').disabled,'settled hold cannot dismiss while initial request is pending');
  finish({});await flush();
  const heldRequest=state.request;
  const acknowledgement=Array.from(host.querySelectorAll('label')).find(item=>item.textContent?.includes('dismissal leaves original work unresolved'))!;
  acknowledgement.querySelector<HTMLInputElement>('input')!.click();await flush();button('Dismiss settled hold').click();await flush();
  assert(dismissals.join()==='exact-recovery,stopped-recovery','explicit dismissals target their own settled operations');
  assert(starts.length===2,'status polling, Stop and dismissal never replay either recovery or original work');
  const stale=()=>host.textContent?.includes('Last loaded result');
  assert(host.textContent?.includes('No eligible retained context boundary is available.')&&!stale(),'fresh no-boundary evidence is not marked stale');
  readFailure=true;button('Reload recovery status').click();await flush();
  assert(host.textContent?.includes('Recovery status read failed')&&stale(),'failed GET labels retained result while preserving its exact error');
  assert(host.textContent?.includes('No eligible retained context boundary is available.')&&host.textContent?.includes('Source evidence · last loaded'),'prior result and source evidence remain clearly historical');
  readFailure=false;button('Reload recovery status').click();await flush();
  assert(!stale()&&!host.textContent?.includes('Source evidence · last loaded'),'successful retry restores fresh result labels');
  state={...state,request:heldRequest};button('Reload recovery status').click();await flush();
  assert(host.textContent?.includes('Recorded phase: held')&&button('Dismiss settled hold').disabled,'recorded request and dismissal acknowledgement guards remain intact');
  api.stopContextRecovery=async()=>{throw Error('Exact recovery stop failed');};
  button('Stop exact recovery').click();await flush();
  assert(host.textContent?.includes('Exact recovery stop failed')&&!stale(),'mutation error alone does not mark the successful status GET stale');

 }finally{finish({});root.unmount();client.clear();host.remove();Object.assign(api,original);if(saved===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,saved);}
}
