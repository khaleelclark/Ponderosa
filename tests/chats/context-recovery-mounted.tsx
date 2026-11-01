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
 let finish:(value:unknown)=>void=()=>{};
 api.getContextRecovery=async(_agent,key)=>{reads.push(key);return structuredClone(state);};
 api.recoverContext=async(_agent,input)=>{starts.push(input);state={...state,request:{id:'exact-recovery',agentId:'fixture-agent',projectId:'project',scopeKey:'scope',sourceRunId:'source-run',providerSessionId:'session',toolContractHash:'a'.repeat(64),sourceFence:7,state:'unsupported_fenced',code:'provider_context_recovery_source_work_held',createdAt:'now',progress:{phase:'native_started',updatedAt:'now',sourceWork:'held_unknown'}}};return new Promise(resolve=>{finish=resolve;});};
 api.stopContextRecovery=async(_agent,id)=>{stops.push(id);state={...state,request:{...state.request!,progress:{phase:'held',updatedAt:'now',sourceWork:'held_unknown',nativeInvoked:true}}};return {stopRequested:true};};
 api.dismissContextRecovery=async(_agent,id)=>{dismissals.push(id);state={...state,request:null,boundary:null};return {recovered:false};};
 const button=(text:string)=>Array.from(host.querySelectorAll('button')).find(item=>item.textContent===text)!;
 const flush=async()=>{for(let index=0;index<8;index++)await tick();};
 try{
  root.render(<QueryClientProvider client={client}><ContextRecoveryPanel agentId="fixture-agent"/></QueryClientProvider>);await flush();
  assert(reads.length===0&&starts.length===0,'mount performs no inspection or native recovery');
  button('Context recovery').click();await flush();
  assert(button('Request context recovery').disabled,'unknown effects require explicit acknowledgement');
  host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();await flush();button('Request context recovery').click();await flush();
  assert(starts.length===1&&starts[0].expectedSourceRunId==='source-run'&&starts[0].expectedSessionId==='session','request binds the inspected boundary');
  assert(localStorage.getItem(storageKey)===starts[0].idempotencyKey,'exact key retained before native call');
  button('Reload recovery status').click();await flush();
  assert(reads.includes(starts[0].idempotencyKey),'in-flight inspection uses exact key');
  button('Stop exact recovery').click();await flush();
  assert(stops.join()==='exact-recovery','Stop stays available during pending recovery and targets exact operation');
  assert(button('Dismiss settled hold').disabled,'settled hold cannot dismiss while initial request is pending');
  finish({});await flush();
  const acknowledgement=Array.from(host.querySelectorAll('label')).find(item=>item.textContent?.includes('dismissal leaves original work unresolved'))!;
  acknowledgement.querySelector<HTMLInputElement>('input')!.click();await flush();button('Dismiss settled hold').click();await flush();
  assert(dismissals.join()==='exact-recovery','explicit dismissal targets settled operation');
  assert(starts.length===1,'status, Stop and dismissal never replay recovery or original work');
 }finally{finish({});root.unmount();client.clear();host.remove();Object.assign(api,original);if(saved===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,saved);}
}
