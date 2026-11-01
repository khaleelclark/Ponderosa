// Deferred DOM harness fixture; no browser/Node execution or preparation authorized.
import {createRoot} from 'react-dom/client';
import {BrowserObservations} from '../../apps/web/src/components/browser/BrowserObservations';
import {currentProductScope} from '../../apps/web/src/api/productScope';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(item=>item.textContent===text)!;
export async function browserObservationRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const queryKey=['private-browser','project','agent','run'],key=`browser-recording:${JSON.stringify([window.location.origin,currentProductScope(),queryKey])}`,saved=localStorage.getItem(key),fetch=globalThis.fetch;
 localStorage.removeItem(key);
 const session:any={id:'session',controlEpoch:7,status:'ready',controlOwner:'operator',activePageId:'page',pages:[{id:'page'}]};
 const recording={id:'original-recording',pageId:'page',startedAt:'2026-11-01T00:00:00Z'};
 const artifact={artifactId:'managed',artifactRef:'ponderosa://artifact/managed',path:'browser/managed.recording.json',mediaType:'application/json',frames:1,reason:'explicit_stop',downloadUrl:'/api/projects/project/artifacts/managed/download'};
 let state:any={},starts=0,stops=0,queries:any[]=[];
 const exact=(input:any)=>assert(input.sessionId==='session'&&input.expectedControlEpoch===7,'exact inspected session/epoch');
 const adapter:any={queryKey,recordingProjectId:'project',observations:{
  console:async(input:any)=>{exact(input);queries.push(input.query);return {entries:[{sequence:1,at:recording.startedAt,pageId:'page',level:'error',text:'Actual console text'}],next:1,truncated:true};},
  recordingStatus:async(input:any)=>{exact(input);return state;},
  startRecording:async(input:any)=>{exact(input);assert(input.pageId==='page','exact active page');assert(JSON.parse(localStorage.getItem(key)!).operation==='start','save before start');starts++;state={recording};throw Error('Lost start response');},
  stopRecording:async(input:any)=>{exact(input);assert(input.recordingId===recording.id,'stop original ID');assert(JSON.parse(localStorage.getItem(key)!).operation==='stop','save before stop');stops++;state={recording,artifact};throw Error('Lost stop response');},
 }};
 const render=async(mount:string,current=session,a=adapter)=>{root.render(<BrowserObservations key={mount} adapter={a} session={current} pageId="page"/>);await settle();button('Console & recording').click();await settle();};
 try{
  await render('first');assert((button('Start recording') as HTMLButtonElement).disabled,'inspect status before start');
  button('Query console').click();await settle();assert(queries[0].pageId==='page'&&queries[0].limit===50,'bounded exact console query');assert(document.body.textContent?.includes('Earlier console entries evicted'),'visible eviction');
  button('Inspect recording status').click();await settle();button('Start recording').click();await settle();assert(starts===0,'explicit confirmation');button('Confirm recording').click();await settle();assert(starts===1&&localStorage.getItem(key),'lost start retained');
  await render('remount');assert(starts===1,'no start replay on mount');button('Inspect recording status').click();await settle();assert(!localStorage.getItem(key)&&document.body.textContent?.includes(recording.id),'recover exact start without replay');
  button('Stop & publish JSON').click();await settle();assert(stops===1&&localStorage.getItem(key),'lost stop retained');
  await render('stop-remount');state={recording:{...recording,id:'substitute'},artifact};button('Inspect recording status').click();await settle();assert(localStorage.getItem(key),'substituted recording stays held');
  state={recording,artifact};button('Inspect recording status').click();await settle();assert(stops===1&&!localStorage.getItem(key),'status recovers managed receipt without stop replay');
  const link=Array.from(document.querySelectorAll('a')).find(item=>item.textContent==='Download frame JSON');assert(link?.getAttribute('href')?.endsWith(artifact.downloadUrl),'actual managed download');
  globalThis.fetch=async()=>new Response(JSON.stringify({...recording,format:'ponderosa.browser-recording.v1',endedAt:'2026-11-01T00:00:01Z',reason:artifact.reason,frames:[{atMs:0,jpeg:'/9j/AAAA'}]}),{status:200});
  button('Load playback').click();await settle();assert(document.querySelector('img')?.getAttribute('src')==='data:image/jpeg;base64,/9j/AAAA','actual JPEG frame playback');
  localStorage.setItem(key,JSON.stringify({context:{sessionId:'session',expectedControlEpoch:7},operation:'start',pageId:'page',previousRecordingId:'old'}));
  state={};await render('missing-receipt');button('Inspect recording status').click();await settle();assert(localStorage.getItem(key)&&(button('Start recording') as HTMLButtonElement).disabled,'missing receipt never proves failed start');
  await render('epoch-drift',{...session,controlEpoch:8});button('Inspect recording status').click();await settle();assert(localStorage.getItem(key)&&starts===1,'epoch drift never replaces or replays saved command');
  localStorage.setItem(key,'{broken');await render('corrupt-storage');assert((button('Start recording') as HTMLButtonElement).disabled,'corrupt saved command holds new mutations');localStorage.removeItem(key);
  await render('shared',session,{...adapter,queryKey:['shared'],recordingProjectId:undefined});assert(document.body.textContent?.includes('Recording destination unavailable'),'missing canonical destination boundary');assert(!button('Start recording'),'no shared recording mutation');
  await render('agent-control',{...session,controlOwner:'agent'});assert((button('Query console') as HTMLButtonElement).disabled,'Agent control cannot imply operator authority');
  assert(starts===1&&stops===1,'no automatic mutation replay');
 }finally{root.unmount();host.remove();globalThis.fetch=fetch;if(saved===null)localStorage.removeItem(key);else localStorage.setItem(key,saved);}
}

export async function sharedRecordingRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);let root=createRoot(host);
 const queryKey=['shared-recording-fixture'],key=`browser-recording:${JSON.stringify([window.location.origin,currentProductScope(),queryKey])}`,destinationKey=`${key}:destination`;
 const prior=localStorage.getItem(key),priorDestination=localStorage.getItem(destinationKey);localStorage.removeItem(key);localStorage.removeItem(destinationKey);
 const destination={projectId:'project',conversationId:'actual-chat'},session:any={id:'shared-session',controlEpoch:3,status:'ready',controlOwner:'operator',activePageId:'page',pages:[{id:'page'}]};
 const recording={id:'recording-id',pageId:'page',startedAt:'2026-11-01T00:00:00Z'},artifact={destination,artifactId:'independent-artifact',artifactRef:'ponderosa://artifact/independent-artifact',path:'browser/independent-artifact.recording.json',mediaType:'application/json',frames:1,reason:'explicit_stop',downloadUrl:'/api/projects/project/artifacts/independent-artifact/download'};
 let state:any={},starts=0,stops=0;
 const exact=(input:any)=>assert(input.sessionId===session.id&&input.expectedControlEpoch===3&&input.destination?.conversationId===destination.conversationId,'exact immutable canonical destination/session/epoch');
 const adapter:any={queryKey,recordingProjectId:'project',sharedRecording:destination,observations:{recordingStatus:async(input:any)=>{exact(input);return state;},startRecording:async(input:any)=>{exact(input);const command=JSON.parse(localStorage.getItem(key)!);assert(command.destinationEvidence.projectId==='project'&&command.context.destination.conversationId===destination.conversationId,'whole destination saved before effect');assert(localStorage.getItem(destinationKey),'binding saved');starts++;state={recording,destination};throw Error('Lost start');},stopRecording:async(input:any)=>{exact(input);assert(input.recordingId===recording.id,'original recording ID independent from artifact');stops++;state={recording,destination,artifact};throw Error('Lost stop');}}};
 const render=async()=>{root.render(<BrowserObservations adapter={adapter} session={session} pageId="page"/>);await settle();button('Console & recording').click();await settle();};
 try{
  await render();assert(!document.querySelector('[aria-label="Recording destination Chat"]'),'Chat owner cannot be switched');button('Inspect recording status').click();await settle();button('Start recording').click();await settle();button('Confirm recording').click();await settle();
  root.unmount();root=createRoot(host);await render();button('Inspect recording status').click();await settle();assert(starts===1&&!localStorage.getItem(key),'same destination remount recovery no start replay');
  button('Stop & publish JSON').click();await settle();state={...state,artifact:{...artifact,destination:{...destination,conversationId:'wrong-chat'}}};button('Inspect recording status').click();await settle();assert(localStorage.getItem(key),'foreign destination receipt held');
  state={recording,destination,artifact};button('Inspect recording status').click();await settle();assert(stops===1&&!localStorage.getItem(key),'same destination exact managed artifact recovered');assert(document.body.textContent?.includes('Producer · Operator'),'operator attribution');
  root.unmount();root=createRoot(host);adapter.sharedRecording={projectId:'project'};await render();assert(!document.querySelector('[aria-label="Recording destination Chat"]'),'saved browser retains immutable bound destination after remount');assert(starts===1&&stops===1,'no retry');
 }finally{root.unmount();host.remove();for(const [name,value] of [[key,prior],[destinationKey,priorDestination]]){if(value===null)localStorage.removeItem(name);else localStorage.setItem(name,value);}}
}
