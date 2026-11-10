import {startTransition,useRef,useState} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MutationNotificationProvider} from '../../apps/web/src/components/MutationNotifications';
import {useQueuedMessageCommandMutation,type QueuedMessageCommandFailure} from '../../apps/web/src/components/useQueuedMessageCommandMutation';
import {ThemeProvider} from '@mui/material/styles';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ApiRequestError,ApiTransportError} from '../../apps/web/src/api/types';
import {requestJson} from '../../apps/web/src/api/real';
import {availabilityFailure,type WorkspaceReadIssue} from '../../apps/web/src/workspaceAvailability';
import {WorkspaceRefreshProvider,useWorkspaceRefresh} from '../../apps/web/src/components/WorkspaceRefreshContext';
import {WorkspaceQueryErrors,WorkspaceQueryError} from '../../apps/web/src/components/WorkspaceQueryError';
import {WorkspaceConnectionNotice} from '../../apps/web/src/components/WorkspaceConnectionNotice';
import {createPonderosaTheme} from '../../apps/web/src/theme';
import type {WorkspaceConnectionState} from '../../apps/web/src/hooks/useWorkspaceStream';

function assert(value:unknown,message:string):asserts value {if(!value)throw Error(message);}
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));};
function clock(){
 const originalSet=window.setTimeout,originalClear=window.clearTimeout,originalNow=Date.now;
 let now=originalNow(),serial=0;const timers=new Map<number,{at:number;run():void}>();
 window.setTimeout=((run:()=>void,delay=0)=>{const id=++serial;timers.set(id,{at:now+Math.max(0,Number(delay)),run});return id;}) as typeof setTimeout;
 window.clearTimeout=id=>{timers.delete(id)};Date.now=()=>now;
 return {async tick(ms:number){const end=now+ms;for(let steps=0;;steps++){assert(steps<1000,'bounded timers');await settle();const next=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].run();}now=end;await settle();},restore(){window.setTimeout=originalSet;window.clearTimeout=originalClear;Date.now=originalNow;}};
}

export async function workspaceOutageIncidentMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),time=clock();
 const calls=new Map<string,number>();let finishRetry:()=>void=()=>{},held=false;
 let connection={status:'live',phaseEvidenceFresh:true,retrying:false,retry:()=>{calls.set('stream',(calls.get('stream')??0)+1);}} as WorkspaceConnectionState;
 const failure=()=>new ApiRequestError(502,'Proxy unavailable');
 const read=(resource:string,error:unknown=undefined,owner='current'):WorkspaceReadIssue=>({owner,resource,error,hasData:true,success:!error,retry:()=>{calls.set(resource,(calls.get(resource)??0)+1);return held&&resource==='Chat'?new Promise<void>(resolve=>{finishRetry=resolve}):Promise.resolve();}});
 let secondaryReads:WorkspaceReadIssue[]=[];
 let reads=[read('Chat'),read('Agent'),read('Preferences'),read('Unread status'),read('Queued messages')];
 let control!:ReturnType<typeof useWorkspaceRefresh>,initial=false;
 function Probe(){control=useWorkspaceRefresh();return <><WorkspaceConnectionNotice connection={connection} hasSavedData/><WorkspaceQueryErrors reads={reads} reportOnly={initial}/><WorkspaceQueryErrors reads={secondaryReads}/>{initial&&<WorkspaceQueryError initial read={reads[0]!}/>}<div data-transcript style={{height:100,overflow:'auto'}}><div style={{height:500}}>cached transcript</div></div><textarea defaultValue="unsubmitted draft"/></>;}
 const render=async()=>{flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><WorkspaceRefreshProvider connection={connection}><Probe/></WorkspaceRefreshProvider></ThemeProvider>));await settle();};
 const compact=()=>[...host.querySelectorAll('button')].filter(b=>b.textContent==='Reconnecting'||b.textContent==='Offline');
 const click=async(text:string)=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent===text);assert(button,`button ${text}`);button.click();await settle();};
 try{
  await render();const textarea=host.querySelector('textarea')!,transcript=host.querySelector<HTMLElement>('[data-transcript]')!;transcript.scrollTop=73;const height=transcript.getBoundingClientRect().height;
  reads=reads.map(r=>read(r.resource,failure()));await render();const incident=control.incident;
  assert(control.shared,'independent resource failures corroborate backend outage');assert(host.querySelectorAll('[role=alert]').length===0,'no stack of derivative alerts');assert(compact().length===0,'brief failed reads remain quiet');
  await time.tick(8000);assert(compact().length===1,'one compact outage indication');await click('Reconnecting');
  const details=document.querySelector('[aria-label="Workspace update details"]')!;assert(details.textContent?.includes('Queued messages')&&details.textContent?.includes('Preferences'),'details identify affected resources');assert(details.textContent?.split('Proxy unavailable').length===2,'proxy diagnostics deduplicated');
  held=true;control.retry();control.retry();await settle();assert(calls.get('stream')===1&&calls.get('Chat')===1,'coordinated retry latches synchronously');finishRetry();held=false;await settle();
  await click('Close');reads=reads.map(r=>read(r.resource,failure()));await render();await time.tick(9000);
  assert(!document.querySelector('[aria-label="Workspace update details"]'),'failed polling does not reopen dismissed details');assert(control.incident===incident,'changing error objects retain incident');
  reads=[read('Chat'),...reads.slice(1)];await render();assert(control.shared&&host.querySelectorAll('[role=alert]').length===0,'partial recovery never recreates derivative banners');
  reads=reads.map(r=>read(r.resource));connection={...connection,phaseEvidenceFresh:false};await render();assert(control.shared,'socket/reads without canonical catch-up do not close incident');
  connection={...connection,phaseEvidenceFresh:true};await render();assert(!control.shared&&compact().length===0,'verified recovery clears compact warning promptly');
  assert(host.querySelector('textarea')===textarea&&textarea.value==='unsubmitted draft','draft/editor mount retained');assert(host.querySelector('[data-transcript]')===transcript&&transcript.scrollTop===73&&transcript.getBoundingClientRect().height===height,'transcript identity, scroll and height retained');
  reads=[read('Chat',failure())];await render();assert(!control.shared&&host.querySelectorAll('[role=alert]').length===1,'isolated 5xx remains local');await click('Close');assert(host.querySelectorAll('[role=alert]').length===0&&host.querySelector('details'),'local dismissal retains reachable recovery');
  reads=[read('Chat',failure())];await render();assert(host.querySelectorAll('[role=alert]').length===0,'retry/poll cannot undo dismissal');
  reads=[read('Chat',new ApiTransportError('Connection lost'))];await render();assert(host.querySelectorAll('[role=alert]').length===0,'HTTP and transport transitions belong to the same unresolved availability incident');
  reads=[read('Chat',new ApiRequestError(503,'Still unavailable'))];await render();assert(host.querySelectorAll('[role=alert]').length===0,'another availability status cannot reopen dismissed feedback');
  reads=[read('Agent',failure(),'other')];await render();assert(host.querySelectorAll('[role=alert]').length===1,'different owner is not suppressed');reads=[read('Chat',failure())];await render();assert(host.querySelectorAll('[role=alert]').length===0,'returning unresolved owner keeps dismissal');
  reads=[read('Chat')];await render();reads=[read('Chat',failure())];await render();assert(host.querySelectorAll('[role=alert]').length===1,'new incident after verified exact recovery surfaces again');
  reads=[read('Chat'),{...read('Configuration',failure(),'hidden-settings'),active:false}];await render();assert(!control.shared&&compact().length===0,'a retained hidden tab cannot hold the visible view stale');assert(host.querySelectorAll('[role=alert]').length===0,'inactive historical errors stay out of the active view');const hiddenRetries=calls.get('Configuration')??0;control.retry();await settle();assert((calls.get('Configuration')??0)===hiddenRetries,'coordinated Retry excludes inactive historical reads');
  reads=[read('Chat',new ApiRequestError(403,'Access revoked')),read('Agent',failure()),read('Preferences',failure())];await render();assert(host.querySelectorAll('[role=alert]').length===1&&host.textContent?.includes('Access revoked'),'auth remains actionable during outage');await click('Close');reads=[read('Chat',new ApiRequestError(404,'Chat removed')),...reads.slice(1)];await render();assert(host.querySelectorAll('[role=alert]').length===1&&host.textContent?.includes('Chat removed'),'a different definitive blocker is not dismissed with auth');
  reads=[read('Chat')];await render();reads=[read('Chat',new ApiRequestError(403,'New access decision'))];await render();assert(host.querySelectorAll('[role=alert]').length===1,'verified recovery resets independent auth dismissal');
  reads=[read('Chat',new ApiRequestError(507,'Capacity needs attention'))];await render();await click('Close');reads=[read('Chat')];await render();reads=[read('Chat',new ApiRequestError(507,'New capacity incident'))];await render();assert(host.querySelectorAll('[role=alert]').length===1,'proven recovery also resets independent server-error categories');
  connection={...connection,phaseEvidenceFresh:false};reads=[read('Chat',failure(),'priority'),read('Agent',failure(),'priority')];await render();
  startTransition(()=>control.report('synthetic-priority-stream',{detail:'Owned Agent stream is reconnecting.',retry(){}}));
  reads=reads.map(read=>({...read,error:undefined,success:true}));await render();await settle();assert(control.shared&&host.querySelector('textarea')===textarea,'a lower-priority stream report overlapping synchronous successful reads cannot create a recovery render loop');
  control.report('synthetic-priority-stream');connection={...connection,phaseEvidenceFresh:true};await render();assert(!control.shared,'priority replay still requires verified recovery');
  reads=[read('Chat',failure(),'duplicate'),read('Agent',failure(),'duplicate')];secondaryReads=[read('Chat',undefined,'duplicate'),read('Agent',undefined,'duplicate')];await render();const duplicateIncident=control.incident;await time.tick(1000);assert(control.shared&&control.incident===duplicateIncident,'successful duplicate readers cannot clear failed claims or create a recovery render loop');
  reads=reads.map(read=>({...read,error:undefined,success:true}));await render();assert(!control.shared,'all active duplicate claims must verify recovery');secondaryReads=[];
  initial=true;reads=[{...read('Assistant',failure()),hasData:false},read('Preferences',failure())];await render();assert(host.textContent?.includes('Assistant could not be loaded.')&&host.querySelectorAll('[role=alert]').length===0,'no-cache view has one contained unavailable state');
  await time.tick(8000);await click('Reconnecting');assert(!document.body.textContent?.includes('never synced'),'a remounted hook does not claim browser has never loaded');
 }finally{flushSync(()=>root.unmount());time.restore();host.remove();}
}

export async function workspaceTransportEvidenceMountedRegression():Promise<void>{
 const saved=globalThis.fetch;let caught:unknown;
 const capture=async()=>{caught=undefined;try{await requestJson('/api/synthetic-outage',{method:'POST'});}catch(error){caught=error;}};
 try{
  globalThis.fetch=async()=>{throw new TypeError('socket lost')};await capture();assert(caught instanceof ApiTransportError&&availabilityFailure(caught)&&!(caught instanceof ApiRequestError),'network loss retains non-HTTP mutation uncertainty');
  globalThis.fetch=async()=>({ok:true,status:200,headers:new Headers(),text:async()=>{throw new TypeError('body lost')}} as unknown as Response);await capture();assert(caught instanceof ApiTransportError&&availabilityFailure(caught),'body stream loss is transport evidence');
  globalThis.fetch=async()=>new Response('{invalid json',{status:200});await capture();assert(caught instanceof SyntaxError&&!availabilityFailure(caught),'parse error is not a shared outage');
  globalThis.fetch=async()=>{throw new DOMException('cancelled','AbortError')};await capture();assert(caught instanceof DOMException&&caught.name==='AbortError'&&!availabilityFailure(caught),'cancellation remains cancellation');
  for(const status of [400,401,403,404,410,429])assert(!availabilityFailure(new ApiRequestError(status,'Proxy unavailable')),'HTTP authority does not depend on error prose');
 }finally{globalThis.fetch=saved;}
}

export async function workspaceActionFeedbackMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{mutations:{retry:false}}});
 const requests:Array<{idempotencyKey:string;canonicalText?:string}>=[];let failed:QueuedMessageCommandFailure|undefined,accept=false,command!:ReturnType<typeof useQueuedMessageCommandMutation<string,{saved:boolean}>>;
 function Probe(){const attempts=useRef(new Map());const [failure,setFailure]=useState<QueuedMessageCommandFailure>();failed=failure;
  command=useQueuedMessageCommandMutation({attempts,input:deliveryId=>({command:'edit',deliveryId,text:'Exact retained edit'}),dispatch:async(_id,request)=>{requests.push(request);if(!accept)throw new ApiTransportError('Response lost');return {saved:true};},invalidate:()=>{},onFailure:setFailure});
  return failure?<details><summary>Queue action needs attention</summary>{failure.error.message}</details>:null;
 }
 try{
  flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><MutationNotificationProvider><Probe/></MutationNotificationProvider></QueryClientProvider></ThemeProvider>));await settle();
  await command.mutateAsync('owned-delivery').catch(()=>{});await settle();assert(failed&&document.querySelector('.MuiSnackbar-root [role=alert]'),'explicit failure uses shared snackbar and retains recovery');
  const close=document.querySelector<HTMLButtonElement>('.MuiSnackbar-root button[aria-label="Close"]');assert(close,'snackbar is dismissible');close.click();await new Promise(resolve=>setTimeout(resolve,300));await settle();assert(failed&&requests.length===1,'Close neither clears retained action nor dispatches another request');
  failed.retry();await settle();assert(requests.length===2&&failed,'explicit failed retry remains the same owned action');assert(document.querySelector('.MuiSnackbar-root [role=alert]'),'explicit new failed attempt can report again');
  accept=true;await command.mutateAsync('owned-delivery');await new Promise(resolve=>setTimeout(resolve,300));await settle();assert(requests.length===3&&requests.every(request=>request.idempotencyKey===requests[0]!.idempotencyKey&&request.canonicalText==='Exact retained edit'),'retry preserves exact key and canonical input');assert(!document.querySelector('.MuiSnackbar-root [role=alert]'),'confirmed success retires obsolete error feedback');
 }finally{flushSync(()=>root.unmount());client.clear();host.remove();}
}
