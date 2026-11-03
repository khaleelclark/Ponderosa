import {openSelect} from '../shared/mounted-controls';
// Deferred browser regression source. Run only with the later combined verification.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {EngineDto} from '@ponderosa/core';
import {ImportAgentForm} from '../../apps/web/src/components/ImportAgentDialog';
import {MutationNotificationProvider} from '../../apps/web/src/components/MutationNotifications';
import {api} from '../../apps/web/src/api';
const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
export async function importLiveRootRegression():Promise<void>{
 const original={createChat:api.createChat,listAgents:api.listAgents,previewAgentAccess:api.previewAgentAccess,startAgentPackageImport:api.startAgentPackageImport};
 const imports:Array<{projectId:string;metadata:Parameters<typeof api.startAgentPackageImport>[2]}>=[];
 const OriginalWorker=window.Worker;
 const host=document.createElement('div');document.body.append(host);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const creates:unknown[]=[],reviews:Array<{projectId:string;metadata:Parameters<typeof api.previewAgentAccess>[2]}>=[];
 const engine:EngineDto={id:'codex',displayName:'Codex',models:[],efforts:[],configured:true,authentication:'authenticated',intakeReady:true,reachability:'reachable',servingBuildRevision:'fixture',servingInstanceId:'fixture'};
 // Isolate the form from package parsing, covered by the package codec regressions.
 window.Worker=class {
  onmessage?: (event:MessageEvent)=>void;
  postMessage({id}:{id:number}){queueMicrotask(()=>this.onmessage?.({data:{id,preview:{sourceLabel:'fixture',hasOutputRoles:false,hasWorkingFiles:true,mode:'full',kind:'agent',agentCount:1,artifactCount:0,historyMessageCount:0,agentTitles:['Imported'],sourceEngines:['codex'],elevatedAgentRefs:[],invalidPermissionShape:false,workingRoots:[{ref:'root',agents:['Imported']}]}}} as MessageEvent));}
  terminate(){}
 } as unknown as typeof Worker;
 api.listAgents=async()=>[];
 api.createChat=async(request,key)=>{creates.push({request,key});return {id:'new-chat',projectId:'new-project',title:'Restored',workingDirectory:'/managed/restored',createdAt:'now',updatedAt:'now'};};
 api.previewAgentAccess=async(projectId,_blob,metadata)=>{reviews.push({projectId,metadata});return {reviewSha256:'fixture-review',source:[],destination:{restrictedCapabilityIds:[],restrictionSources:{},layers:[]}};};
 api.startAgentPackageImport=async(projectId,_blob,metadata)=>{imports.push({projectId,metadata});return {
  id:'failed-direct-import',requestId:'original-import',payloadHash:'f'.repeat(64),projectId,conversationId:'new-chat',product:'dev',sourceLabel:'fixture',phase:'failed',status:'failed',createdAt:'2026-11-03T00:00:00.000Z',updatedAt:'2026-11-03T00:00:00.000Z',error:'Fixture native apply failed',
  result:{rootAgentId:'imported-root',agentIds:['imported-root'],reviewedUserDataApplications:[{ref:'root',path:'/recovery/restored',originalSha256:'f'.repeat(64),selection:{git:true,harness:false},state:'incomplete',error:{code:'ERR_NATIVE_PARTIAL_FIXTURE',partialStatePossible:true,observed:{path:'/recovery/restored/.git'}}}]}
 } as Awaited<ReturnType<typeof api.startAgentPackageImport>>;};
 const button=(text:string)=>Array.from(host.querySelectorAll('button')).find(item=>item.textContent===text)!;
 const input=(label:string)=>host.querySelector<HTMLInputElement>(`#${CSS.escape(Array.from(host.querySelectorAll('label')).find(item=>item.textContent?.startsWith(label))!.htmlFor)}`)!;
 const change=(element:HTMLInputElement,value:string)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));};
 const flush=async()=>{for(let i=0;i<8;i++)await tick();};
 try{
  root.render(<QueryClientProvider client={client}><MutationNotificationProvider><ImportAgentForm projectId="old-project" engines={[engine]} conversations={[]} onCancel={()=>{}}/></MutationNotificationProvider></QueryClientProvider>);await flush();
  assert(creates.length===0,'opening import never creates a Chat');
  change(input('New Chat name'),'Restored');change(input('New managed folder name'),'restored');await flush();
  const combo=host.querySelector('[role=combobox]') as HTMLElement;openSelect(combo);await flush();
  (Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent==='Codex') as HTMLElement).click();await flush();
  button('Create new destination').click();await flush();
  assert(creates.length===1,'explicit creation uses exactly one request');
  assert(JSON.stringify(creates[0]).includes('"createFolderName":"restored"')&&!JSON.stringify(creates[0]).includes('hostPath'),'new destination creates managed folder rather than registering user content');
  const files=new DataTransfer();files.items.add(new File(['{}'],'fixture.json',{type:'application/json'}));
  const file=host.querySelector<HTMLInputElement>('input[type=file]')!;file.files=files.files;file.dispatchEvent(new Event('change',{bubbles:true}));await flush();
  change(input('New folder: Imported'),'/recovery/restored');await flush();
  button('Review access settings').click();await flush();
  assert(reviews[0]?.projectId==='new-project'&&reviews[0].metadata.conversationId==='new-chat','access review uses actual created destination');
  assert(reviews[0].metadata.workingFilesActivation===undefined,'content-only import does not activate');
  const activation=Array.from(host.querySelectorAll('label')).find(item=>item.textContent?.includes('Use restored files in live'))!.querySelector('input')!;
  activation.click();await flush();assert(button('Review access settings').disabled,'Shared activation needs a separate confirmation');
  Array.from(host.querySelectorAll('label')).find(item=>item.textContent?.includes('Confirm new workspace folder: /managed/restored'))!.querySelector('input')!.click();await flush();
  button('Review access settings').click();await flush();
  assert(reviews[1]?.metadata.workingFilesActivation?.sharedRoot==='/managed/restored','activation confirms canonical returned path');
  assert(reviews[1]?.metadata.workingRootDestinations?.root==='/recovery/restored','live activation retains recovery mapping');
  const restrictions=Array.from(host.querySelectorAll('label')).find(item=>item.textContent?.startsWith('Restrictions for imported Agents'))!;
  openSelect(document.getElementById(restrictions.htmlFor));await flush();
  (Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent==='Keep destination restrictions') as HTMLElement).click();await flush();
  button('Import').click();await flush();
  assert(imports[0]?.projectId==='new-project'&&imports[0].metadata.conversationId==='new-chat','import uses actual created destination');
  assert(imports[0]?.metadata.workingFilesActivation?.sharedRoot==='/managed/restored'&&imports[0].metadata.workingRootDestinations?.root==='/recovery/restored','import preserves reviewed live activation and recovery paths');
  assert(host.textContent?.includes('Git and provider settings: incomplete'),'direct failed operation retains native partial receipt');
  assert(host.textContent?.includes('ERR_NATIVE_PARTIAL_FIXTURE')&&host.textContent?.includes('/recovery/restored/.git'),'partial code and observed native evidence remain visible');
  await flush();assert(imports.length===1,'direct failed result never automatically replays import');

 }finally{root.unmount();client.clear();host.remove();window.Worker=OriginalWorker;Object.assign(api,original);}
}
