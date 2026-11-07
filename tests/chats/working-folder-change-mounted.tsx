import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {AgentDto} from '@ponderosa/core';
import {AgentWorkingCopySettings} from '../../apps/web/src/components/AgentDetail.settings';
import {MutationNotificationProvider} from '../../apps/web/src/components/MutationNotifications';
import {api} from '../../apps/web/src/api';
import {openSelect} from '../shared/mounted-controls';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const settle=async()=>{for(let n=0;n<8;n++)await tick();};
const base={id:'folder-agent',projectId:'folder-project',conversationId:'folder-chat',workingCopy:{id:'old-copy',mode:'shared',rootPath:'/synthetic/shared',state:'ready'}} as AgentDto;
const choice=(phase:NonNullable<AgentDto['workingCopyChange']>['phase'],extra:Partial<NonNullable<AgentDto['workingCopyChange']>>={}):AgentDto=>({...base,workingCopyChange:{rolloverId:'intent-one',mode:'separate_git',phase,retryable:false,canKeepCurrent:false,...extra}});
function assertActionLayout(button:HTMLButtonElement){
 const alert=button.closest('[role=alert]'),message=alert?.querySelector('.MuiAlert-message'),actions=alert?.querySelector('.MuiAlert-action');
 assert(alert&&message&&actions,'the visible recovery controls belong to their warning');
 const warning=alert!.getBoundingClientRect(),text=message!.getBoundingClientRect(),action=actions!.getBoundingClientRect();
 assert(text.width>=warning.width/2,'warning text keeps usable line width beside its controls');
 if(window.innerWidth<600)assert(action.top>=text.bottom-1,'phone recovery actions occupy a row below the warning');
 for(const target of actions!.querySelectorAll('button')){
  const rect=target.getBoundingClientRect();assert(rect.width>=43.5&&rect.height>=43.5,'recovery actions retain coarse pointer targets');
  assert(rect.left>=warning.left-1&&rect.right<=warning.right+1,'every recovery action stays inside its warning');
  const walker=document.createTreeWalker(target,NodeFilter.SHOW_TEXT),tops:number[]=[];
  for(let node=walker.nextNode();node;node=walker.nextNode())if(node.textContent?.trim()){
   const range=document.createRange();range.selectNodeContents(node);for(const line of range.getClientRects())if(line.width>1&&line.height>1)tops.push(Math.round(line.top));
  }
  assert(new Set(tops).size===1,'recovery action labels remain readable on one line');
 }
}
async function fixture(run:(args:{host:HTMLDivElement;client:QueryClient;button(text:string):HTMLButtonElement;setRead(value:AgentDto|Error):void})=>Promise<void>){
 const original={updateAgent:api.updateAgent,agentWorkingCopyChange:api.agentWorkingCopyChange,keepCurrentWorkingCopy:api.keepCurrentWorkingCopy};
 let read:AgentDto|Error=base;api.agentWorkingCopyChange=async()=>{if(read instanceof Error)throw read;return read;};
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 try{root.render(<QueryClientProvider client={client}><MutationNotificationProvider><AgentWorkingCopySettings agent={base}/></MutationNotificationProvider></QueryClientProvider>);await settle();
  await run({host,client,button(text){const found=Array.from(host.querySelectorAll('button')).find(x=>x.textContent===text);if(!found)throw Error('Missing button '+text+' in '+host.textContent);return found;},setRead(value){read=value;}});
 }finally{root.unmount();client.clear();host.remove();Object.assign(api,original);}
}
export async function workingFolderPendingCompletionRegression(){await fixture(async({host,button,setRead})=>{
 let writes=0;const pending=choice('handoff');api.updateAgent=async(_id,input)=>{writes++;assert(input.workingCopyMode==='separate_git','selected mode is the explicit request');setRead(pending);return pending;};
 openSelect(host.querySelector('[role=combobox]'));await tick();(Array.from(document.querySelectorAll('[role=option]')).find(x=>x.textContent==='Separate Git copy') as HTMLElement).click();await settle();
 assert(writes===1&&host.textContent?.includes('preserving this Agent’s context'),'202 projection displays genuine pending Save');
  assertActionLayout(button('Check status'));
 assert(host.querySelector('[role=combobox]')?.getAttribute('aria-disabled')==='true','pending mode cannot be edited');
 assert(host.textContent?.includes('/synthetic/shared')&&!document.body.textContent?.includes('Agent working folder updated.'),'pending mode retains actual folder and never announces saved');
 setRead({...choice('completed'),workingCopy:{id:'new-copy',mode:'separate_git',rootPath:'/synthetic/new-copy',state:'ready'}} as AgentDto);button('Check status').click();await settle();
 assert(host.textContent?.includes('Separate Git copy · Ready')&&host.textContent.includes('/synthetic/new-copy'),'verified completion displays the actual canonical folder');
 assert(host.querySelector('[role=combobox]')?.getAttribute('aria-disabled')!=='true'&&!host.textContent?.includes('Saving…'),'only completed Save re-enables mode selection');
});}
export async function workingFolderHeldRetryAndKeepRegression(){await fixture(async({host,button,setRead,client})=>{
 const held=choice('held',{retryable:true,canKeepCurrent:true,message:'Untracked owned-untracked.txt prevents removing this managed copy.'});setRead(held);await client.invalidateQueries({queryKey:['agent-working-folder-change',base.id]});await settle();
 assert(host.textContent?.includes('Untracked owned-untracked.txt')&&host.querySelector('[role=combobox]')?.getAttribute('aria-disabled')==='true','held Save shows concrete refusal and disables a different choice');
  assertActionLayout(button('Retry'));
 let retries=0;api.updateAgent=async(_id,input)=>{retries++;assert(input.workingCopyMode==='separate_git','Retry uses the retained exact target');setRead(choice('preparing'));return choice('preparing');};button('Retry').click();await settle();
 assert(retries===1&&host.textContent?.includes('preparing the selected working folder')&&!document.body.textContent?.includes('Agent working folder updated.'),'Retry is pending, never a claimed completed change');
 setRead(held);await client.invalidateQueries({queryKey:['agent-working-folder-change',base.id]});await settle();
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let kept=0;
 api.keepCurrentWorkingCopy=async(id,intent)=>{assert(id===base.id&&intent==='intent-one','Keep binds exact Agent and intent');kept++;await gate;const value=choice('kept_current');setRead(value);return value;};
 button('Keep current folder').click();await settle();assert(button('Keep current folder').disabled&&button('Retry').disabled,'pending Keep cannot conflict with Retry');release();await settle();
 assert(kept===1&&host.textContent?.includes('Kept the current working folder and existing context.')&&host.textContent.includes('/synthetic/shared'),'explicit Keep shows unchanged canonical folder');
 assert(host.querySelector('[role=combobox]')?.getAttribute('aria-disabled')!=='true','safe Keep restores normal folder controls');
});}
export async function workingFolderStatusErrorsAndUnknownHoldRegression(){await fixture(async({host,button,setRead,client})=>{
 setRead(choice('held',{message:'Provider input delivery is unconfirmed; inspect Activity before retrying.'}));await client.invalidateQueries({queryKey:['agent-working-folder-change',base.id]});await settle();
 assert(!Array.from(host.querySelectorAll('button')).some(x=>['Retry','Keep current folder'].includes(x.textContent??'')),'unknown/applied intent exposes no unsafe Retry or Keep');
 setRead(Error('Status unavailable: synthetic response failed. Try Check status.'));button('Check status').click();await settle();
 assert(host.textContent?.includes('Status unavailable: synthetic response failed.')&&host.textContent.includes('delivery is unconfirmed'),'real status failure remains visible beside retained hold');
  assertActionLayout(button('Check status'));
 assert(host.querySelector('[role=combobox]')?.getAttribute('aria-disabled')==='true'&&!document.body.textContent?.includes('Agent working folder updated.'),'status failure never releases or claims Save');
});}
