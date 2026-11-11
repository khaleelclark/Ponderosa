import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {ConversationWorkspaceFiles} from '../../apps/web/src/components/files/ConversationWorkspaceFiles';
import {api} from '../../apps/web/src/api';
const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
async function until(read:()=>boolean,label:string){const end=performance.now()+2500;while(!read()){if(performance.now()>end)throw Error(label);await frame();}}
function visibleOpacity(element:HTMLElement){let opacity=1;for(let node:HTMLElement|null=element;node;node=node.parentElement)opacity*=Number(getComputedStyle(node).opacity);return element.getClientRects().length?opacity:0;}

export async function workspaceFileExitRetentionRegression():Promise<void>{
 const original={directory:api.getConversationFiles,preview:api.getWorkspaceFileView};
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const reads:string[]=[];
 const names=['first.txt','second.txt','missing.txt','binary.bin','loading.txt'];let resolveLoading:(value:Awaited<ReturnType<typeof api.getWorkspaceFileView>>)=>void=()=>{};
 const value=(name:string)=>({name,path:name,size:10,mediaType:name==='binary.bin'?'application/octet-stream':'text/plain',...(name==='binary.bin'?{downloadUrl:'/owned-binary-download'}:{text:'Actual content of '+name})}) as Awaited<ReturnType<typeof api.getWorkspaceFileView>>;
 api.getConversationFiles=async(conversationId,path)=>{assert(conversationId==='chat'&&path==='','only the existing owned directory is read');return {kind:'dir',path:'',entries:names.map(name=>({kind:'file',path:name,name}))} as Awaited<ReturnType<typeof api.getConversationFiles>>;};
 api.getWorkspaceFileView=async(projectId,path,agentId,conversationId)=>{assert(projectId==='project'&&conversationId==='chat'&&agentId===undefined,'preview scope is unchanged');assert(names.includes(path),'clearing selection never fetches an undefined or foreign path');reads.push(path);if(path==='missing.txt')throw Error('Owned original no longer exists');if(path==='loading.txt')return new Promise(resolve=>{resolveLoading=resolve;});return value(path);};
 const dialog=()=>document.querySelector<HTMLElement>('[role="dialog"]');
 const open=(name:string)=>{const entry=Array.from(host.querySelectorAll<HTMLAnchorElement>('a')).find(a=>a.textContent===name);assert(entry,'actual file link exists: '+name);entry!.click();};
 async function loaded(name:string,text:string){open(name);await until(()=>Boolean(dialog()?.textContent?.includes(text)),'preview ready: '+name);}
 async function closeRetaining(name:string,text:string){const d=dialog()!;await until(()=>dialog()===d&&visibleOpacity(d)>.99&&Boolean(d.textContent?.includes(name)&&d.textContent?.includes(text)),'preview is visibly ready before Close');const button=Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='Close');assert(button,'normal Close is available');button!.click();let visibleFrames=0;const end=performance.now()+2500;while(dialog()){assert(performance.now()<end,'normal dialog exit finishes');const current=dialog()!,content=current.textContent??'';if(visibleOpacity(current)>.01){visibleFrames++;assert(content.includes(name)&&content.includes(text),'selected filename and actual preview stay intact through visible exit: '+name);if(name!=='binary.bin')assert(!content.includes('This file type cannot be displayed safely'),'closing a known preview never flashes the generic unsupported fallback');}await frame();}(window as Window&{workspaceFileExitEvidence?:unknown[]}).workspaceFileExitEvidence??=[];(window as Window&{workspaceFileExitEvidence:unknown[]}).workspaceFileExitEvidence.push({name,visibleSamples:visibleFrames});}
 try{
  root.render(<QueryClientProvider client={client}><ConversationWorkspaceFiles projectId="project" conversationId="chat"/></QueryClientProvider>);
  await until(()=>host.querySelectorAll('a').length===names.length,'directory ready');
  await loaded('first.txt','Actual content of first.txt');await closeRetaining('first.txt','Actual content of first.txt');
  await loaded('second.txt','Actual content of second.txt');await closeRetaining('second.txt','Actual content of second.txt');
  await loaded('missing.txt','Preview is unavailable: Owned original no longer exists');await closeRetaining('missing.txt','Preview is unavailable: Owned original no longer exists');
  const unsupported='This file type cannot be displayed safely in Ponderosa. Download it to open it with a compatible application.';
  await loaded('binary.bin',unsupported);assert(Array.from(dialog()!.querySelectorAll('a')).some(a=>a.textContent?.includes('Download')),'the real unsupported-file Download remains');await closeRetaining('binary.bin',unsupported);
  await loaded('loading.txt','Loading preview…');await closeRetaining('loading.txt','Loading preview…');
  await loaded('second.txt','Actual content of second.txt');resolveLoading?.(value('loading.txt'));await frame();assert(dialog()?.textContent?.includes('Actual content of second.txt')&&!dialog()?.textContent?.includes('Actual content of loading.txt'),'a late old read cannot replace the reopened file');
  const close=Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='Close')!;close.click();await frame();open('first.txt');await until(()=>Boolean(dialog()?.textContent?.includes('Actual content of first.txt')),'new file opens during exit');for(let n=0;n<20;n++)await frame();assert(dialog()?.textContent?.includes('Actual content of first.txt'),'a prior exit never clears a newer open selection');await closeRetaining('first.txt','Actual content of first.txt');
  assert(reads.length>=names.length,'all actual preview paths were exercised');
 }finally{resolveLoading?.(value('loading.txt'));root.unmount();client.clear();host.remove();api.getConversationFiles=original.directory;api.getWorkspaceFileView=original.preview;}
}

export async function visualizationReferenceGuardsMountedRegression():Promise<void>{
 const {ChatMessageBody}=await import('../../apps/web/src/components/chat/ChatMessages');
 const {MutationNotificationProvider}=await import('../../apps/web/src/components/MutationNotifications');
 const original=api.getProjectArtifact,reads:Array<{project:string;id:string;reference:unknown}>=[];
 const host=document.createElement('div');host.style.cssText='position:fixed;inset:0;overflow:auto';document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const text='```ponderosa\n'+JSON.stringify({version:1,type:'visualization',title:'Owned Panel',artifactId:'captured-html'})+'\n```';
 let ids:string[]=[],message='message';
 api.getProjectArtifact=async(project,id,reference)=>{reads.push({project,id,reference});if(reference?.communicationEventId==='denied')throw Error('Denied');return {id,agentId:'agent',projectId:project,kind:'generated_file',path:'panel.html',createdAt:'now',sha256:'a'.repeat(64),size:3*1024*1024,mediaType:'text/html',previewUrl:`/api/projects/${project}/artifacts/${id}/preview`,downloadUrl:`/api/projects/${project}/artifacts/${id}/download`};};
 const render=()=>root.render(<QueryClientProvider client={client}><MutationNotificationProvider><ChatMessageBody text={text} projectId="project" artifactSource={{communicationEventId:message,conversationId:'chat',artifactIds:ids}} collapseLongMessage={false}/></MutationNotificationProvider></QueryClientProvider>);
 try{
  render();await until(()=>Boolean(host.textContent?.includes('not attached to this published message')),'unpublished reference stays inert');assert(reads.length===0&&!host.querySelector('iframe'),'Authored reference alone has no read or executable runtime');
  ids=['captured-html'];render();await until(()=>Boolean(host.textContent?.includes('visualization is unavailable')),'oversized panel has one compact fallback');
  assert(reads.length===1&&JSON.stringify(reads[0].reference)===JSON.stringify({conversationId:'chat',communicationEventId:'message'}),'Metadata binds canonical publication and exact Chat');assert(!host.querySelector('iframe'),'Oversized/truncated HTML never starts executing');assert(!host.querySelector('a[download]')&&!host.textContent?.includes('Download'),'Inline visualization fallback keeps the approved compact Retry surface without a backing-file action');assert([...host.querySelectorAll('button')].some(button=>button.textContent==='Retry'),'Authorized unavailable visualization retains its existing Retry');
  message='denied';render();await until(()=>reads.length===2&&Boolean(host.textContent?.includes('visualization is unavailable')),'Denied reference remains local fallback');
  assert(!host.querySelector('iframe')&&!host.querySelector('a[download]'),'Denied publication never exposes another owner preview/download');
 }finally{root.unmount();client.clear();host.remove();api.getProjectArtifact=original;}
}
