// Deferred browser regression source; no new runner or execution.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {PostImportAccessReview} from '../../apps/web/src/components/PostImportAccessReview';
import {api} from '../../apps/web/src/api';
const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
export async function postImportBrowserReviewRegression():Promise<void>{
 const original={getSavedBrowserAccess:api.getSavedBrowserAccess,getBrowserAgentPreference:api.getBrowserAgentPreference,listBrowserProfiles:api.listBrowserProfiles,setSavedBrowserAccess:api.setSavedBrowserAccess,updateBrowserAgentPreference:api.updateBrowserAgentPreference};
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const writes:unknown[]=[];let allowed=false;
 api.getSavedBrowserAccess=async()=>({agentIds:allowed?['imported']:[]});
 api.getBrowserAgentPreference=async()=>({projectId:'destination',agentId:'imported',mode:'disposable',updatedAt:'now'});
 api.listBrowserProfiles=async()=>[{id:'local-profile',projectId:'destination',name:'Local destination profile',createdAt:'now',updatedAt:'now'}];
 api.setSavedBrowserAccess=async(owner,agentId,value)=>{writes.push({owner,agentId,allowed:value});allowed=value;return {agentIds:value?[agentId]:[]};};
 api.updateBrowserAgentPreference=async(owner,agentId,input)=>{writes.push({owner,agentId,...input});return {projectId:owner,agentId,...input,updatedAt:'now'};};
 try{
  root.render(<QueryClientProvider client={client}><PostImportAccessReview result={{rootAgentId:'imported',agentIds:['imported'],accessSettingsToReview:[{agentId:'imported',conversationId:'new-chat',source:{restrictedCapabilityIds:[],savedBrowserAllowed:true,browserMode:'trusted',sourceProfileName:'Foreign source profile'}}]}} onDone={()=>{}}/></QueryClientProvider>);
  for(let index=0;index<6;index++)await tick();
  assert(writes.length===0,'imported suggestions must not mutate destination grants or profiles');
  const apply=Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Apply saved-browser choice')!;
  assert(apply.disabled,'applying access requires an explicit choice');
  (host.querySelector('[role=combobox]') as HTMLElement).click();await tick();
  const allow=Array.from(document.querySelectorAll('[role=option]')).find(option=>option.textContent==='Allow') as HTMLElement;
  allow.click();await tick();apply.click();for(let index=0;index<4;index++)await tick();
  assert(writes.length===1&&JSON.stringify(writes[0]).includes('"agentId":"imported"'),'explicit access choice targets the mapped imported Agent');
  assert(!writes.some(write=>JSON.stringify(write).includes('Foreign source profile')),'foreign profile labels never become destination IDs');
 }finally{root.unmount();client.clear();host.remove();Object.assign(api,original);}
}
