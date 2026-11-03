// Deferred browser regression; no runner changes or execution.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {BranchExportFileSelections} from '@ponderosa/core';
import {BranchPackageExportDialog} from '../../apps/web/src/components/branches/BranchPackageExportDialog';
import {realApi} from '../../apps/web/src/api/real';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
export async function branchPackageAllFoldersRegression():Promise<void>{
 const original=realApi.listBranchAgents,host=document.createElement('div');document.body.append(host);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}}),exports:BranchExportFileSelections[]=[];
 realApi.listBranchAgents=async()=>[{id:'local-root',title:'Root',chatTitle:'Team'},{id:'local-child',title:'Child',chatTitle:'Team'}] as Awaited<ReturnType<typeof realApi.listBranchAgents>>;
 const flush=async()=>{for(let i=0;i<8;i++)await tick();};
 try{
  root.render(<QueryClientProvider client={client}><BranchPackageExportDialog source={{branchId:'branch',name:'Workflow'}} pending={false} onCancel={()=>{}} onConfirm={async files=>{exports.push(files);}}/></QueryClientProvider>);await flush();
  assert(exports.length===0,'opening export does not publish working files');
  Array.from(document.querySelectorAll('label')).find(label=>label.textContent?.includes('Include all workflow Agent working folders'))!.querySelector<HTMLInputElement>('input')!.click();await flush();
  const button=Array.from(document.querySelectorAll('button')).find(item=>item.textContent==='Export full')!;button.click();await flush();
  assert(JSON.stringify(exports[0])===JSON.stringify({'local-root':{wholeWorkingFolder:true},'local-child':{wholeWorkingFolder:true}}),'all-folders selection covers exact local Agent IDs without subtree duplication');
  Array.from(document.querySelectorAll('label')).find(label=>label.textContent==='Git history, branches and staged files')!.querySelector<HTMLInputElement>('input')!.click();await flush();
  const details=Array.from(document.querySelectorAll('summary')).find(item=>item.textContent==='Mapped Git folders')!;details.click();await flush();
  Array.from(document.querySelectorAll('button')).find(item=>item.textContent==='Add Git folder mapping')!.click();await flush();
  const storage=Array.from(document.querySelectorAll('label')).find(label=>label.textContent?.startsWith('Storage-folder Agent'))!;document.getElementById(storage.htmlFor)!.click();await flush();
  (Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent==='Team · Child') as HTMLElement).click();await flush();
  button.click();await flush();
  const selections=Object.values(exports[1]!);assert(selections.length===2,'global mapping preserves complete workflow root selection');
  const bindings=selections[0]!.gitStorageBindings!;
  assert(bindings.length===1&&bindings[0]!.worktreeAgentId==='local-root'&&bindings[0]!.storageAgentId==='local-child'&&bindings[0]!.role==='common'&&bindings[0]!.relativePath==='.git','friendly selectors produce exact Agent/root storage binding');
  assert(selections.filter(selection=>selection.gitStorageBindings).length===1,'one compact global declaration preserves the complete source root context');

 }finally{root.unmount();client.clear();host.remove();realApi.listBranchAgents=original;}
}
