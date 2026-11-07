import {openSelect} from '../shared/mounted-controls';
// Deferred browser regression source; no new runner or execution.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {PostImportAccessReview} from '../../apps/web/src/components/PostImportAccessReview';
import {api} from '../../apps/web/src/api';
const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
export async function postImportBrowserReviewRegression():Promise<void>{
 const original={getAgent:api.getAgent,getConversation:api.getConversation,getSavedBrowserAccess:api.getSavedBrowserAccess,getBrowserAgentPreference:api.getBrowserAgentPreference,listBrowserProfiles:api.listBrowserProfiles,setSavedBrowserAccess:api.setSavedBrowserAccess,updateBrowserAgentPreference:api.updateBrowserAgentPreference};
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 api.getAgent=async()=>({agent:{id:'imported',title:'Imported Agent'}} as Awaited<ReturnType<typeof api.getAgent>>);
 api.getConversation=async()=>({conversation:{id:'new-chat',title:'New Chat'}} as Awaited<ReturnType<typeof api.getConversation>>);
 const writes:unknown[]=[];let allowed=false,done=0;let releaseAccess!:()=>void;const accessGate=new Promise<void>(resolve=>releaseAccess=resolve);
 const profileName='Destination profile with a deliberately long readable name that must wrap in the selected field';
 api.getSavedBrowserAccess=async()=>({agentIds:allowed?['imported']:[]});
 api.getBrowserAgentPreference=async()=>({projectId:'destination',agentId:'imported',mode:'disposable',updatedAt:'now'});
 api.listBrowserProfiles=async()=>[{id:'local-profile',projectId:'destination',name:profileName,createdAt:'now',updatedAt:'now'}];
 api.setSavedBrowserAccess=async(owner,agentId,value)=>{writes.push({owner,agentId,allowed:value});await accessGate;allowed=value;return {agentIds:value?[agentId]:[]};};
 api.updateBrowserAgentPreference=async(owner,agentId,input)=>{writes.push({owner,agentId,...input});return {projectId:owner,agentId,...input,updatedAt:'now'};};
 try{
  root.render(<QueryClientProvider client={client}><PostImportAccessReview result={{rootAgentId:'imported',agentIds:['imported'],accessSettingsToReview:[{agentId:'imported',conversationId:'new-chat',source:{restrictedCapabilityIds:[],savedBrowserAllowed:true,browserMode:'trusted',sourceProfileName:'Foreign source profile'}}]}} onDone={()=>{done++;}}/></QueryClientProvider>);
  for(let index=0;index<6;index++)await tick();
  assert(writes.length===0,'imported suggestions must not mutate destination grants or profiles');
  const doneButton=Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Done')!;
  assert(Array.from(host.querySelectorAll('button')).filter(button=>button.textContent==='Done').length===1&&Boolean(doneButton.compareDocumentPosition(host.querySelector('.MuiPaper-root')!)&Node.DOCUMENT_POSITION_FOLLOWING),'one completion action precedes the optional settings cards');
  const apply=Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Apply saved-browser choice')!;
  assert(apply.disabled,'applying access requires an explicit choice');
  openSelect(host.querySelector('[role=combobox]'));await tick();
  const allow=Array.from(document.querySelectorAll('[role=option]')).find(option=>option.textContent==='Allow') as HTMLElement;
  allow.click();for(let index=0;index<3;index++)await tick();doneButton.click();await tick();
  assert(document.body.textContent?.includes('Unapplied settings')&&done===0&&writes.length===0,'top Done preserves dirty confirmation without applying choices');
  (Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Keep editing')!).click();await tick();
  apply.click();for(let index=0;index<3;index++)await tick();assert(doneButton.disabled,'top Done stays disabled during a manual permission write');releaseAccess();for(let index=0;index<4;index++)await tick();
  assert(writes.length===1&&JSON.stringify(writes[0]).includes('"agentId":"imported"'),'explicit access choice targets the mapped imported Agent');
  assert(!writes.some(write=>JSON.stringify(write).includes('Foreign source profile')),'foreign profile labels never become destination IDs');
  const profileSelect=host.querySelectorAll<HTMLElement>('[role=combobox]')[1];openSelect(profileSelect);await tick();
  (Array.from(document.querySelectorAll('[role=option]')).find(option=>option.textContent===profileName) as HTMLElement).click();for(let index=0;index<3;index++)await tick();
  assert(profileSelect.textContent?.includes(profileName)&&getComputedStyle(profileSelect).whiteSpace==='normal'&&getComputedStyle(profileSelect).overflowWrap==='anywhere','the full selected destination profile can wrap: '+JSON.stringify({text:profileSelect.textContent,connected:profileSelect.isConnected,whiteSpace:getComputedStyle(profileSelect).whiteSpace,overflowWrap:getComputedStyle(profileSelect).overflowWrap}));
  doneButton.click();await tick();(Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Discard choices')!).click();await tick();
  assert(done===1&&writes.length===1,'explicit discard finishes without applying the selected destination profile');
 }finally{releaseAccess();root.unmount();client.clear();host.remove();Object.assign(api,original);}
}
