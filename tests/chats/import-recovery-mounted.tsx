import {openSelect} from '../shared/mounted-controls';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {ConversationDto,EngineDto} from '@ponderosa/core';
import {ImportAgentForm} from '../../apps/web/src/components/ImportAgentDialog';
import {fingerprintAgentImport} from '../../apps/web/src/components/agentImportFingerprint';
import {agentImportFingerprintHeader,listPendingAgentImports,retainPendingAgentImport,releasePendingAgentImport,type PendingAgentImport} from '../../apps/web/src/components/agentImportRecovery';
import {PendingAgentImportRecovery} from '../../apps/web/src/components/PendingAgentImportRecovery';
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
 const calls:Array<{requestId:string;metadata:string;fingerprint:string;body:string}>=[];let statusChecks=0,lookupFound=false,operation:any;
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
  if(lookupFound)return operation;
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
  operation={...operation,status:'failed',error:'Import stopped after partial work',result:{reviewedMetadataApplications:[]}};lookupFound=true;
  button('Check import status').click();await until(()=>Boolean(host.textContent?.includes('Finish reviewing')),'failed result not shown');
  assert(listPendingAgentImports(product).length===1&&calls.length===2,'failed result stays saved without retry');
  root.render(null);await settle();render('failed-reload');await settle();
  assert(host.textContent?.includes('Import awaiting confirmation'),'failed result remains recoverable after reload');
  button('Check import status').click();await until(()=>Boolean(host.textContent?.includes('Finish reviewing')),'failed result not recovered');
  assert(host.textContent?.includes('Partial files')&&listPendingAgentImports(product).length===1,'partial effects and saved identity remain visible until review');
  button('Finish reviewing').click();await settle();
  assert(listPendingAgentImports(product).length===0&&calls.length===2,'explicit review dismisses the receipt without another import');
 }finally{
  for(const entry of listPendingAgentImports(product))if(entry.projectId===chat.projectId)for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i);if(k?.startsWith('ponderosa-agent-import-v1:')&&k.endsWith(':'+entry.requestId))localStorage.removeItem(k);}
  root.unmount();client.clear();host.remove();window.Worker=OriginalWorker;Object.assign(api,original);
 }
}

export async function heldImportRetirementRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const original={getAgentImportOperationByRequest:api.getAgentImportOperationByRequest,retireHeldAgentImport:api.retireHeldAgentImport};
 const product=currentProductScope(),entry={version:1,requestId:'test-retire-request',projectId:'test-retire-project',conversationId:'test-retire-chat',product,metadata:{conversationId:'test-retire-chat',engineMapping:{}},fingerprint:{algorithm:'sha256-4m-v1',bytes:5,digest:'a'.repeat(64)}} as unknown as PendingAgentImport;
 const status={state:'reserved',operationId:'operation-retire',requestId:entry.requestId,projectId:entry.projectId,conversationId:entry.conversationId,product,requestFingerprint:agentImportFingerprintHeader(entry.fingerprint)};
 let current={...status,requestFingerprint:'sha256-4m-v1:5:'+('b'.repeat(64))},sent=0,dismissed=0;
 api.getAgentImportOperationByRequest=async()=>{throw new ApiRequestError(409,'Held',current);};
 api.retireHeldAgentImport=async(projectId,conversationId,requestId,operationId)=>{
  assert(projectId===entry.projectId&&conversationId===entry.conversationId&&requestId===entry.requestId&&operationId===status.operationId,'retirement uses the exact reviewed scope');
  sent++;current={...status,state:'retired'};throw new TypeError('Synthetic retirement response lost');
 };
 const button=(name:string)=>Array.from(host.querySelectorAll('button')).find(item=>item.textContent===name)!;
 try{
  retainPendingAgentImport(entry);
  root.render(<PendingAgentImportRecovery entry={entry} onAccepted={()=>{throw Error('unexpected import');}} onRetired={value=>{releasePendingAgentImport(value);dismissed++;}} onDeleted={value=>{releasePendingAgentImport(value);dismissed++;}}/>);await settle();
  button('Check import status').click();await settle();
  assert(!button('Retire held request')&&listPendingAgentImports(product).some(item=>item.requestId===entry.requestId),'mismatched status cannot authorize retirement');
  current={...status};button('Check import status').click();await settle();
  assert(Boolean(button('Retire held request')),'exact held request offers an explicit retirement choice');
  button('Retire held request').click();await settle();
  assert(sent===1&&dismissed===0&&listPendingAgentImports(product).some(item=>item.requestId===entry.requestId)&&host.textContent?.includes('Retirement is unconfirmed'),'lost retirement reply retains identity and does not start another import');
  button('Check import status').click();await settle();
  assert(Boolean(button('Dismiss retired request'))&&dismissed===0,'exact retired status is recovered before dismissal');
  button('Dismiss retired request').click();await settle();
  assert(dismissed===1&&!listPendingAgentImports(product).some(item=>item.requestId===entry.requestId)&&sent===1,'confirmed retirement is dismissed without a new upload');
 }finally{try{releasePendingAgentImport(entry);}catch{}root.unmount();host.remove();Object.assign(api,original);}
}

export async function deletedImportNoticeRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),product=currentProductScope();
 const entry={version:1,requestId:'test-deleted-request',projectId:'test-deleted-project',conversationId:'test-deleted-chat',product,metadata:{conversationId:'test-deleted-chat',engineMapping:{}},fingerprint:{algorithm:'sha256-4m-v1',bytes:5,digest:'c'.repeat(64)}} as unknown as PendingAgentImport;
 const identity={projectId:entry.projectId,conversationId:entry.conversationId,product,requestId:entry.requestId,operationId:'deleted-operation',requestFingerprint:agentImportFingerprintHeader(entry.fingerprint)};
 const original={getAgentImportOperationByRequest:api.getAgentImportOperationByRequest,startAgentPackageImport:api.startAgentPackageImport};
 let current:unknown={state:'destination_deleted',...identity,requestFingerprint:'wrong'},dismissed=0,sends=0;
 api.getAgentImportOperationByRequest=async()=>{throw new ApiRequestError(409,'Destination unavailable',current);};
 api.startAgentPackageImport=async()=>{sends++;throw Error('must not retry');};
 const button=(name:string)=>Array.from(host.querySelectorAll('button')).find(item=>item.textContent===name)!;
 try{
  retainPendingAgentImport(entry);
  root.render(<PendingAgentImportRecovery entry={entry} onAccepted={()=>{throw Error('deleted result must not be returned');}} onRetired={()=>{throw Error('not a retired request');}} onDeleted={value=>{releasePendingAgentImport(value);dismissed++;}}/>);await settle();
  button('Check import status').click();await settle();
  assert(!button('Dismiss saved notice')&&listPendingAgentImports(product).some(item=>item.requestId===entry.requestId),'mismatched deleted status cannot clear the request');
  current={state:'destination_deleted',...identity};button('Check import status').click();await settle();
  assert(host.textContent?.includes('outcome and any effects remain unknown')&&Boolean(button('Dismiss saved notice')),'exact deletion receipt shows unresolved outcome and explicit choice');
  assert(dismissed===0&&listPendingAgentImports(product).some(item=>item.requestId===entry.requestId),'the receipt never clears automatically');
  button('Dismiss saved notice').click();await settle();
  assert(dismissed===1&&sends===0&&!listPendingAgentImports(product).some(item=>item.requestId===entry.requestId),'explicit dismissal clears only browser notice without retry');
 }finally{try{releasePendingAgentImport(entry);}catch{}root.unmount();host.remove();Object.assign(api,original);}
}

export async function lostImportPollingRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),product=currentProductScope();
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const entry={version:1,requestId:'test-poll-request',projectId:'test-poll-project',conversationId:'test-poll-chat',product,metadata:{conversationId:'test-poll-chat',engineMapping:{}},fingerprint:{algorithm:'sha256-4m-v1',bytes:5,digest:'e'.repeat(64)}} as unknown as PendingAgentImport;
 const original={getAgentImportOperationByRequest:api.getAgentImportOperationByRequest,getAgentImportOperation:api.getAgentImportOperation};
 const operation={id:'poll-operation',requestId:entry.requestId,payloadHash:'a'.repeat(64),requestFingerprint:agentImportFingerprintHeader(entry.fingerprint),projectId:entry.projectId,conversationId:entry.conversationId,product,sourceLabel:'fixture',phase:'queued',status:'pending',createdAt:'now',updatedAt:'now'} as any;
 let polls=0;
 api.getAgentImportOperationByRequest=async()=>operation;
 api.getAgentImportOperation=async()=>{polls++;throw new ApiRequestError(404,'Owner unavailable');};
 const button=(name:string)=>Array.from(host.querySelectorAll('button')).find(item=>item.textContent===name)!;
 try{
  retainPendingAgentImport(entry);
  root.render(<QueryClientProvider client={client}><MutationNotificationProvider><ImportAgentForm projectId={entry.projectId} engines={[]} conversations={[]} onCancel={()=>{}}/></MutationNotificationProvider></QueryClientProvider>);await settle();
  button('Check import status').click();await until(()=>polls>0&&Boolean(host.textContent?.includes('Import awaiting confirmation')),'poll error did not return to saved request');
  assert(listPendingAgentImports(product).some(item=>item.requestId===entry.requestId),'polling failure retains request for scoped check');
 }finally{try{releasePendingAgentImport(entry);}catch{}root.unmount();client.clear();host.remove();Object.assign(api,original);}
}
