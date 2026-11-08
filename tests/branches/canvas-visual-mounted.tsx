import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {AgentCreateForm} from '../../apps/web/src/components/AgentCreateDialog';
import {queryKeys} from '../../apps/web/src/queryKeys';
import {PublishingEffects} from '../../apps/web/src/components/branches/deployment-effects';
import {createRef} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Button,CssBaseline,ThemeProvider} from '@mui/material';
import type {BranchDefinition} from '@ponderosa/core';
import {WorkflowCanvas} from '../../apps/web/src/components/branches/WorkflowCanvas';
import {createPonderosaTheme} from '../../apps/web/src/theme';

const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
async function until(read:()=>boolean,message:string){const end=performance.now()+8000;while(performance.now()<end){if(read())return;await tick();}throw Error(message);}
export async function workflowVisibleConnectionsRegression():Promise<void>{
 await import('../../apps/web/src/global.css');
 const host=document.createElement('main');host.id='main-content';host.style.cssText='position:fixed;inset:0';document.body.append(host);const root=createRoot(host);
 const script=(id:string,label:string)=>({id,label,kind:'script' as const,runtime:'node' as const,source:'process.stdout.write("done")',cwdRef:'workspace',timeoutMs:1000});
 const definition:BranchDefinition={schema:'ponderosa.branch.v1',name:'Visual regression',trigger:{kind:'manual'},entry:'inserted',steps:[script('existing','Existing Script'),script('inserted','Inserted Script')],controls:[],edges:[{id:'next',from:'inserted',to:'existing',on:'success'}],policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}};
 const checkpoint=async(name:string)=>{await (window as Window&{phase2UiCheckpoint?:(name:string)=>Promise<void>}).phase2UiCheckpoint?.(name);};
 try{
  flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline/><div style={{height:44}}>Guided workflow</div><div style={{height:'calc(100vh - 44px)'}}><WorkflowCanvas branchId="visual" definition={definition} bindings={{agents:{},directories:{workspace:'/unused'}}} agents={[]} selected="inserted" onSelect={()=>{}} focusRequest={0} revealRequest={0} issues={[]} onInsert={()=>{}} onDelete={()=>{}} undoRedo={{canUndo:true,canRedo:false,onUndo(){},onRedo(){}}} canvasViews={new Map()} entryButtonRef={createRef<HTMLButtonElement>()} startControl={<Button variant="outlined">Start Manually</Button>} saveControl={<Button variant="contained">Save Workflow</Button>} active/></div></ThemeProvider>));
  await until(()=>host.querySelectorAll('.react-flow__edge-path').length===2&&!host.querySelector('[aria-busy="true"]'),'Both actual graph connections finish layout');
  let previous='',stable=0;await until(()=>{const signature=Array.from(host.querySelectorAll('.react-flow__edge-path')).map(path=>path.getAttribute('d')).join('|')+Array.from(host.querySelectorAll('.react-flow__edgelabel-renderer > div')).map(label=>label.getAttribute('style')).join('|');stable=signature===previous&&!host.querySelector('[aria-busy="true"]')?stable+1:0;previous=signature;return stable>=8;},'Measured graph finishes its visible layout');
  const paths=Array.from(host.querySelectorAll<SVGPathElement>('.react-flow__edge-path'));
  const geometry=paths.map(path=>({path:path.getAttribute('d'),rect:path.getBoundingClientRect().toJSON(),svg:path.ownerSVGElement?.getBoundingClientRect().toJSON(),style:path.ownerSVGElement?{maxWidth:getComputedStyle(path.ownerSVGElement).maxWidth,overflow:getComputedStyle(path.ownerSVGElement).overflow}:null}));
  await checkpoint('workflow-connections');
  console.log('WORKFLOW_GEOMETRY',JSON.stringify(geometry));
  assert(paths.every(path=>path.getBoundingClientRect().height>1&&path.ownerSVGElement!.getBoundingClientRect().width>0),'Phone and desktop connections retain a visible coordinate SVG');
  const outline=host.querySelector<HTMLButtonElement>('[aria-label="Workflow Outline"]')!;outline.click();
  await until(()=>{const dialog=document.querySelector<HTMLElement>('[role="dialog"]');return Boolean(dialog&&getComputedStyle(dialog.parentElement!).opacity==='1'&&getComputedStyle(dialog).opacity==='1');},'Outline opens fully');
  const rows=Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll('button')).filter(button=>button.textContent?.includes(' · Script'));
  assert(rows[0]?.textContent?.startsWith('Inserted Script')&&rows[1]?.textContent?.startsWith('Existing Script'),'Outline follows the displayed connected path after insertion');
  await checkpoint('workflow-outline');
  Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll('button')).find(button=>button.textContent==='Close')!.click();
  await until(()=>!document.querySelector('[role="dialog"]'),'Outline closes');
  const fit=host.querySelector<HTMLButtonElement>('button[aria-label="Fit Workflow"]');
  if(fit){fit.click();try{await until(()=>{const terminal=host.querySelector<HTMLElement>('.react-flow__node-terminal'),canvas=host.querySelector<HTMLElement>('.react-flow');if(!terminal||!canvas)return false;const node=terminal.getBoundingClientRect(),view=canvas.getBoundingClientRect();return node.top>=view.top&&node.bottom<=view.bottom;},'Fit reveals the entire terminal above the toolbar');}catch(error){console.log('FIT_DIAGNOSTIC',JSON.stringify(Array.from(host.querySelectorAll('.react-flow,.react-flow__viewport,.react-flow__node-terminal')).map(node=>({classes:node.className,rect:node.getBoundingClientRect().toJSON(),style:node.getAttribute('style')}))));await checkpoint('workflow-fit-failure');throw error;}}
  await checkpoint('workflow-fit');
 }finally{root.unmount();host.remove();}
}


export async function agentCreationStableLabelsRegression():Promise<void>{
 const host=document.createElement('div');host.style.cssText='position:fixed;inset:0;overflow:auto;padding:16px';document.body.append(host);const root=createRoot(host),nativeFetch=globalThis.fetch;
 const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity},mutations:{retry:false}}});
 const project={id:'label-project',label:'Label regression',defaultEngine:'codex'} as any;
 const chat={id:'label-chat',projectId:project.id,title:'Context Chat',defaultEngine:'codex'} as any;
 const manager={id:'label-manager',projectId:project.id,conversationId:chat.id,title:'Manager'} as any;
 const engine={id:'codex',displayName:'Codex',authentication:'authenticated',intakeReady:true,enabled:true,installed:true,models:[],efforts:[]} as any;
 client.setQueryData(queryKeys.workspacePreferences.all,{engineDefaults:{}});
 client.setQueryData(queryKeys.agents.project(project.id),[manager]);
 client.setQueryData(queryKeys.conversations.project(project.id),[chat]);
 client.setQueryData(queryKeys.agents.presets(project.id),[]);
 globalThis.fetch=async()=>{throw Error('Creation initialization must use only controlled reads and never submit');};
 try{
  root.render(<QueryClientProvider client={client}><ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline/><AgentCreateForm projects={[project]} engines={[engine]} fixedProjectId={project.id} initialManagerAgentId={manager.id} initialName="Named Agent" onCancel={()=>{}} onCreated={()=>{throw Error('No creation allowed');}}/></ThemeProvider></QueryClientProvider>);
  await until(()=>host.textContent?.includes('Manager')===true&&host.textContent?.includes('Codex')===true,'Creation values initialize');
  for(let frame=0;frame<12;frame++){
   await new Promise(resolve=>requestAnimationFrame(resolve));
   for(const label of host.querySelectorAll<HTMLElement>('.MuiInputLabel-root')){
    assert(getComputedStyle(label).transitionDuration==='0s','Populated labels cannot animate through their field values');
   }
  }
  await (window as Window&{phase2UiCheckpoint?:(name:string)=>Promise<void>}).phase2UiCheckpoint?.('creation-labels');
 }finally{root.unmount();client.clear();globalThis.fetch=nativeFetch;host.remove();}
}

export async function publishingEffectsFactsRegression():Promise<void>{
 const host=document.createElement('div');host.style.cssText='position:fixed;inset:0;overflow:auto;padding:16px';document.body.append(host);const root=createRoot(host);
 const notes=['Traversal preflight: estimated baseline 3 visits. Conditions or loops make the full count uncertain; check the configured 100 traversal limit before running.','Accepted executions keep their version and binding revision.','Persistent Agents belong to this Branch through their Chat. Their living history is preserved.','Detached bindings preserve Agents and user folders. Template Agents are created per invocation and deleted after cleanup.','Agents and Scripts use the host account’s authority. A human gate controls workflow order, not other host activity.'];
 try{
  root.render(<ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline/><PublishingEffects notes={notes}/></ThemeProvider>);
  await until(()=>Boolean(host.querySelector('button')),'Publishing effects summary renders');
  host.querySelector<HTMLButtonElement>('button')!.click();
  await until(()=>Boolean(host.querySelector('.MuiCollapse-entered')),'Effects disclosure opens fully');
  assert(host.querySelectorAll('dt').length===9&&host.querySelectorAll('dd').length===9,'Each consequential effect is a labeled fact');
  assert(!host.querySelector('p'),'Expanded publishing effects contain no informational paragraphs');
  assert(host.textContent?.includes('100 · check before running')&&host.textContent.includes('Host account authority')&&host.textContent.includes('other host activity unaffected'),'Traversal and authority limits remain disclosed');
  for(const row of host.querySelectorAll('dt,dd')){const rect=row.getBoundingClientRect();assert(rect.left>=0&&rect.right<=innerWidth,'Effect rows stay inside the phone and desktop width');}
  await (window as Window&{phase2UiCheckpoint?:(name:string)=>Promise<void>}).phase2UiCheckpoint?.('publishing-effects-expanded');
 }finally{root.unmount();host.remove();}
}
