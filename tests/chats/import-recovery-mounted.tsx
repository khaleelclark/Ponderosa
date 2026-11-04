import {openSelect} from '../shared/mounted-controls';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {ConversationDto,EngineDto} from '@ponderosa/core';
import {ImportAgentForm} from '../../apps/web/src/components/ImportAgentDialog';
import {fingerprintAgentImport} from '../../apps/web/src/components/agentImportFingerprint';
import {agentImportFingerprintHeader,listPendingAgentImports} from '../../apps/web/src/components/agentImportRecovery';
import {MutationNotificationProvider} from '../../apps/web/src/components/MutationNotifications';
import {ApiRequestError} from '../../apps/web/src/api/types';
import {api} from '../../apps/web/src/api';
import {currentProductScope} from '../../apps/web/src/api/productScope';
const assert=(v:unknown,message:string)=>{if(!v)throw Error(message);};
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const until=async(predicate:()=>boolean,message:string)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error(message);};
export async function importRequestRecoveryRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const original={listAgents:api.listAgents,previewAgentAccess:api.previewAgentAccess,startAgentPackageImport:api.startAgentPackageImport,getAgentImportOperation:api.getAgentImportOperation,getAgentImportOperationByRequest:api.getAgentImportOperationByRequest};
 const OriginalWorker=window.Worker,product=currentProductScope();
 const cryptoDescriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 const engine:EngineDto={id:'codex',displayName:'Codex',models:[],efforts:[],configured:true,authentication:'authenticated',intakeReady:true,reachability:'reachable',servingBuildRevision:'fixture',servingInstanceId:'fixture'};
 const chat={id:'import-recovery-chat',projectId:'import-recovery-project',title:'Recovery Chat',createdAt:'now',updatedAt:'now'} as ConversationDto;
 const calls:Array<{requestId:string;metadata:string;fingerprint:string;body:string}>=[];let statusChecks=0,operation:any;
 window.Worker=class {
  onmessage?: (event:MessageEvent)=>void;
  postMessage({id}:{id:number}){queueMicrotask(()=>this.onmessage?.({data:{id,preview:{sourceLabel:'fixture',hasOutputRoles:false,hasWorkingFiles:false,mode:'template',kind:'agent',agentCount:1,artifactCount:0,historyMessageCount:0,agentTitles:['Imported'],sourceEngines:['codex'],elevatedAgentRefs:[],invalidPermissionShape:false}}} as MessageEvent));}
  terminate(){}
 } as unknown as typeof Worker;
 api.listAgents=async()=>[];
 api.previewAgentAccess=async()=>({reviewSha256:'a'.repeat(64),source:[],destination:{restrictedCapabilityIds:[],restrictionSources:{},layers:[]}});
 api.startAgentPackageImport=async(projectId,blob,metadata,requestId,fingerprint)=>{
  const body=new Blob([JSON.stringify(metadata)+'\n',blob],{type:'application/vnd.ponderosa.agent-import'});
  const expected=agentImportFingerprintHeader(await fingerprintAgentImport(body));
  assert(fingerprint===expected,'client fingerprint covers the exact metadata newline and package');
  calls.push({requestId,metadata:JSON.stringify(metadata),fingerprint:fingerprint!,body:await body.text()});
  operation={id:'import-recovery-operation',requestId,payloadHash:'c'.repeat(64),requestFingerprint:fingerprint,projectId,conversationId:chat.id,product,sourceLabel:'fixture',phase:'queued',status:'pending',createdAt:'now',updatedAt:'now'};
  if(calls.length===1)throw new TypeError('Synthetic response lost after enqueue');
  return operation;
 };
 api.getAgentImportOperationByRequest=async(projectId,conversationId,requestId)=>{
  statusChecks++;assert(projectId===chat.projectId&&conversationId===chat.id&&requestId===calls[0].requestId,'lookup uses the exact saved owner and request');
  throw new ApiRequestError(404,'Not found');
 };
 api.getAgentImportOperation=async()=>operation;
 const render=(mount:string)=>root.render(<QueryClientProvider client={client}><MutationNotificationProvider><ImportAgentForm key={mount} projectId={chat.projectId} engines={[engine]} conversations={[chat]} fixedConversationId={chat.id} onCancel={()=>{}}/></MutationNotificationProvider></QueryClientProvider>);
 const button=(name:string)=>Array.from(host.querySelectorAll('button')).find(item=>item.textContent===name)!;
 const choose=(content:string,name:string)=>{
  const transfer=new DataTransfer();transfer.items.add(new File([content],name,{type:'application/json'}));
  const input=host.querySelector<HTMLInputElement>('input[type=file]')!;assert(input,'file chooser exists');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
 };
 const packageText='{"private-synthetic":"original package bytes"}';
 try{
  const vector=await fingerprintAgentImport(new Blob(['example-body\n']));
  assert(agentImportFingerprintHeader(vector)==='sha256-4m-v1:13:65d50099f3e2c881631fb432966279d6b61380c6fa551815b4e69690100138b1','browser fingerprint matches the fixed server algorithm vector');
  try{
   Object.defineProperty(globalThis,'crypto',{configurable:true,value:{}});
   const httpVector=await fingerprintAgentImport(new Blob(['example-body\n']));
   assert(agentImportFingerprintHeader(httpVector)===agentImportFingerprintHeader(vector),'HTTP fallback matches native SHA and the server fingerprint');
  }finally{
   if(cryptoDescriptor)Object.defineProperty(globalThis,'crypto',cryptoDescriptor);
   else Reflect.deleteProperty(globalThis,'crypto');
  }
  assert(listPendingAgentImports(product).length===0,'fresh browser context has no retained import');
  render('first');await settle();choose(packageText,'original.json');await settle();
  button('Review access settings').click();await settle();
  const label=Array.from(host.querySelectorAll('label')).find(item=>item.textContent?.startsWith('Restrictions for imported Agents'))!;
  openSelect(document.getElementById(label.htmlFor));await settle();
  (Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent==='Keep destination restrictions') as HTMLElement).click();await settle();
  button('Import').click();await until(()=>calls.length===1,'original import not sent');await settle();
  assert(calls.length===1,'original import sent once');
  let saved=listPendingAgentImports(product);assert(saved.length===1&&saved[0].requestId===calls[0].requestId,'uncertain import retains its exact request ID');
  const savedBytes=localStorage.getItem(localStorage.key(Array.from({length:localStorage.length},(_,i)=>i).find(i=>localStorage.key(i)?.startsWith('ponderosa-agent-import-v1:'))!)!)!;
  assert(!savedBytes.includes('private-synthetic')&&!savedBytes.includes(packageText),'package contents are not stored in browser storage');

  root.render(null);await settle();render('reload');await settle();
  assert(host.textContent?.includes('Import awaiting confirmation'),'pending request is recovered after reload');
  button('Check import status').click();await settle();
  assert(statusChecks===1&&calls.length===1&&listPendingAgentImports(product).length===1,'404 neither clears nor retries an uncertain request');
  choose('{"private-synthetic":"different bytes"}','wrong.json');await settle();button('Retry exact import').click();await until(()=>Boolean(host.textContent?.includes('not the original package')),'changed file not rejected');await settle();
  assert(calls.length===1&&host.textContent?.includes('not the original package'),'changed file never reaches the server');
  choose(packageText,'original.json');await settle();button('Retry exact import').click();await until(()=>calls.length===2,'exact import not retried');await settle();
  assert(calls.length===2&&calls[1].requestId===calls[0].requestId&&calls[1].metadata===calls[0].metadata&&calls[1].fingerprint===calls[0].fingerprint&&calls[1].body===calls[0].body,'explicit retry sends the exact original request and identity');
  saved=listPendingAgentImports(product);assert(saved.length===1&&saved[0].requestId===calls[0].requestId,'pending 202 keeps recovery identity through reload');
  assert(host.textContent?.includes('Import in progress'),'accepted pending import is visible');
  operation={...operation,status:'completed'};
  await until(()=>Boolean(host.textContent?.includes('Import awaiting confirmation')),'missing result was not retained for recovery');
  assert(listPendingAgentImports(product).length===1,'completed status without a result does not discard the saved identity');
 }finally{
  for(const entry of listPendingAgentImports(product))if(entry.projectId===chat.projectId)for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i);if(k?.startsWith('ponderosa-agent-import-v1:')&&k.endsWith(':'+entry.requestId))localStorage.removeItem(k);}
  root.unmount();client.clear();host.remove();window.Worker=OriginalWorker;Object.assign(api,original);
 }
}
