import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {AgentDto,ConversationDto,ProjectDto} from '@ponderosa/core';
import {AddAgentsFlow} from '../../apps/web/src/components/AddAgentsFlow';
import {MutationNotificationProvider} from '../../apps/web/src/components/MutationNotifications';
import {api} from '../../apps/web/src/api';
import {openSelect} from '../shared/mounted-controls';

const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const flush=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0));};

export async function duplicateIntoCurrentChatRegression():Promise<void>{
 const original={listProjects:api.listProjects,listAgents:api.listAgents,listConversations:api.listConversations,copyAgent:api.copyAgent};
 const originalSubtle=Object.getOwnPropertyDescriptor(window.crypto,'subtle');
 const destination={id:'target-chat',projectId:'target-project',title:'Destination Chat',instructions:'Destination rules'} as ConversationDto;
 const sourceChat={id:'source-chat',projectId:'source-project',title:'Source Chat',instructions:'Source rules'} as ConversationDto;
 const source={id:'source-agent',projectId:'source-project',conversationId:'source-chat',title:'Original',activeEngine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}} as AgentDto;
 const projects=[{id:'target-project',label:'Destination Chat'},{id:'source-project',label:'Source Chat'}] as ProjectDto[];
 const copies:Array<{projectId:string;body:Parameters<typeof api.copyAgent>[1]}>=[];
 let created:{projectId:string;agentId:string}|undefined;
 api.listProjects=async()=>projects;
 api.listAgents=async projectId=>projectId==='source-project'?[source]:[];
 api.listConversations=async projectId=>projectId==='source-project'?[sourceChat]:[destination];
 api.copyAgent=async(projectId,body)=>{copies.push({projectId,body});return {rootAgentId:'copy',agentIds:['copy']} as Awaited<ReturnType<typeof api.copyAgent>>;};
 const host=document.createElement('div');document.body.append(host);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const button=(label:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent?.trim()===label);
 const clickOption=async(label:string)=>{await flush();const option=Array.from(document.querySelectorAll<HTMLElement>('[role=option]')).find(item=>item.textContent?.trim()===label);assert(option,'Missing option '+label);option!.click();await flush();};
 try{
  root.render(<QueryClientProvider client={client}><MutationNotificationProvider><AddAgentsFlow open fixedProjectId="target-project" initialConversation={destination} conversations={[destination]} engines={[]} onCreate={()=>{}} onClose={()=>{}} onCreated={(projectId,agentId)=>{created={projectId,agentId};}}/></MutationNotificationProvider></QueryClientProvider>);
  await flush();button('Duplicate existing Agent')!.click();await flush();
  const projectSelect=document.querySelector('[role=combobox][aria-labelledby*="duplicate-source-project-label"]');
  assert(projectSelect,'Source Chat selector was not offered');openSelect(projectSelect);await clickOption('Source Chat');
  const sourceInput=document.querySelector<HTMLInputElement>('input[role=combobox]');assert(sourceInput,'Source Agent selector missing');
  sourceInput!.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(sourceInput,'Original');
  sourceInput!.dispatchEvent(new Event('input',{bubbles:true}));await clickOption('Original · Source Chat');
  button('Continue')!.click();await flush();
  assert(document.body.textContent?.includes('Destination Chat'),'Current destination Chat is not shown');
  const contents=document.querySelector('[role=combobox][aria-labelledby*="agent-package-contents-label"]');openSelect(contents);
  await clickOption('Setup, private history, and managed artifacts');
  assert(document.body.textContent?.includes('Chat instructions differ'),'Source and destination instructions must be reviewed');
  const instructionSelect=document.querySelector('[role=combobox][aria-labelledby*="import-chat-instructions-choice"]');openSelect(instructionSelect);
  await clickOption('Keep existing Chat instructions');
  Object.defineProperty(window.crypto,'subtle',{value:undefined,configurable:true});
  const confirm=button('Duplicate Agent');assert(confirm&&!confirm.disabled,'Duplicate confirmation unavailable');confirm!.click();await flush();
  assert(copies.length===1,'Expected one copy request');
  assert(copies[0]?.projectId==='target-project'&&copies[0]?.body.conversationId==='target-chat'&&copies[0]?.body.sourceAgentId==='source-agent','Copy must bind exact source and destination');
  assert(copies[0]?.body.chatInstructionsResolution?.action==='keep_destination','Instruction choice must reach server');
  assert(copies[0]?.body.chatInstructionsResolution?.expectedDestinationSha256==='4fe6e5cd2f5b7f21244d0fb46fb3d4f29115eeb7de66d9c99e3b1dbc37f5b04b','Instruction digest matches exact destination even without Web Crypto');
  assert(created?.projectId==='target-project'&&created?.agentId==='copy','Completion reports actual destination');
 }finally{if(originalSubtle)Object.defineProperty(window.crypto,'subtle',originalSubtle);else Reflect.deleteProperty(window.crypto,'subtle');root.unmount();client.clear();Object.assign(api,original);host.remove();}
}
