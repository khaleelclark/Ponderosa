// Deferred DOM harness fixture; no browser/Node execution or preparation authorized.
import {createRoot} from 'react-dom/client';
import {api} from '../../apps/web/src/api';
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
 const queryKey=['shared-recording-fixture'],key=`browser-recording:${JSON.stringify([window.location.origin,currentProductScope(),queryKey,'project','actual-chat'])}`,destinationKey=`${key}:destination`;
 const otherKeys=[`browser-recording:${JSON.stringify([window.location.origin,currentProductScope(),queryKey,'project',null])}`,`browser-recording:${JSON.stringify([window.location.origin,currentProductScope(),queryKey])}`].flatMap(name=>[name,`${name}:destination`]);
 const otherPrior=otherKeys.map(name=>[name,localStorage.getItem(name)] as const);otherKeys.forEach(name=>localStorage.removeItem(name));
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
  root.unmount();root=createRoot(host);adapter.sharedRecording={projectId:'project'};await render();assert(document.querySelector('[aria-label="Recording destination Chat"]'),'different saved-browser scope requires explicit destination');assert(localStorage.getItem(destinationKey),'original Chat binding retained');assert(starts===1&&stops===1,'no retry');
 }finally{root.unmount();host.remove();for(const [name,value] of [[key,prior],[destinationKey,priorDestination],...otherPrior]){if(value===null)localStorage.removeItem(name);else localStorage.setItem(name,value);}}
}


// Deferred: same mounted saved-browser adapter key and session across Project changes.
export async function savedRecordingProjectSwitchRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const queryKey=['project-browser','saved-browser'],base=[window.location.origin,currentProductScope(),queryKey];
 const key=(project:string)=>`browser-recording:${JSON.stringify([...base,project,null])}`;
 const names=['A','B'].flatMap(project=>[key(project),`${key(project)}:destination`]);
 const legacy=`browser-recording:${JSON.stringify(base)}`;names.push(legacy,`${legacy}:destination`);
 const prior=names.map(name=>[name,localStorage.getItem(name)] as const),list=api.listConversations;
 names.forEach(name=>localStorage.removeItem(name));
 const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(done=>{resolve=done;});return {promise,resolve};};
 const session:any={id:'same-session',controlEpoch:3,status:'ready',controlOwner:'operator',activePageId:'page',pages:[{id:'page'}]};
 const destination={projectId:'A',conversationId:'chat-A'},recording={id:'recording-A',pageId:'page',startedAt:'2026-11-01T00:00:00Z'};
 const artifact={destination,artifactId:'artifact-A',artifactRef:'ponderosa://artifact/artifact-A',path:'browser/artifact-A.recording.json',mediaType:'application/json',frames:1,reason:'explicit_stop',downloadUrl:'/api/projects/A/artifacts/artifact-A/download'};
 let listing=deferred(),status=deferred(),start=deferred(),stop=deferred(),starts=0,stops=0;
 api.listConversations=async project=>project==='A'?listing.promise:[];
 const adapter=(projectId:string):any=>({queryKey,recordingProjectId:projectId,sharedRecording:{projectId},observations:{
  recordingStatus:async()=>status.promise,
  startRecording:async()=>{starts++;assert(localStorage.getItem(key('A')),'original scope saved before start');return start.promise;},
  stopRecording:async()=>{stops++;assert(localStorage.getItem(key('A')),'original scope saved before stop');return stop.promise;},
 }});
 const render=async(project:string)=>{root.render(<BrowserObservations adapter={adapter(project)} session={session} pageId="page"/>);await settle();button('Console & recording').click();await settle();};
 const selectA=async()=>{
  button('Load destination Chats').click();await settle();listing.resolve([{id:'chat-A',projectId:'A',title:'Chat A'}]);await settle();
  (document.querySelector('[role="combobox"][aria-label="Recording destination Chat"]') as HTMLElement).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));await settle();
  (Array.from(document.querySelectorAll('[role="option"]')).find(item=>item.textContent?.includes('Chat A')) as HTMLElement).click();await settle();
 };
 const noA=()=>{assert(!document.body.textContent?.includes('chat-A')&&!document.body.textContent?.includes('recording-A')&&!document.body.textContent?.includes('artifact-A'),'old Project evidence excluded');assert((button('Start recording') as HTMLButtonElement).disabled,'new Project requires own selection and status');};
 try{
  await render('A');button('Load destination Chats').click();await settle();await render('B');listing.resolve([{id:'chat-A',projectId:'A',title:'Chat A'}]);await settle();noA();
  listing=deferred();await render('A');await selectA();button('Inspect recording status').click();await settle();await render('B');status.resolve({recording,destination});await settle();noA();assert(!localStorage.getItem(`${key('A')}:destination`),'late status cannot bind destination');
  status=deferred();listing=deferred();await render('A');await selectA();button('Inspect recording status').click();await settle();status.resolve({});await settle();button('Start recording').click();await settle();button('Confirm recording').click();await settle();
  const original=localStorage.getItem(key('A'));assert(original,'start command retained');await render('B');start.resolve(recording);await settle();noA();assert(localStorage.getItem(key('A'))===original&&!localStorage.getItem(key('B')),'late start cannot clear or move original command');
  status=deferred();await render('A');assert(document.body.textContent?.includes('Original start'),'original scope restores unknown command');button('Inspect recording status').click();await settle();status.resolve({recording,destination});await settle();assert(!localStorage.getItem(key('A'))&&starts===1,'explicit original scope recovery without replay');
  button('Stop & publish JSON').click();await settle();const originalStop=localStorage.getItem(key('A'));await render('B');stop.resolve(artifact);await settle();noA();assert(localStorage.getItem(key('A'))===originalStop,'late stop retains original command');
  status=deferred();await render('A');button('Inspect recording status').click();await settle();status.resolve({recording,destination,artifact});await settle();assert(!localStorage.getItem(key('A'))&&starts===1&&stops===1,'original stop recovered only in A without replay');
  // Pre-isolation storage is retained, never silently migrated or discarded in B.
  localStorage.removeItem(`${key('A')}:destination`);localStorage.setItem(legacy,original!);localStorage.setItem(`${legacy}:destination`,JSON.stringify(destination));
  await render('B');noA();assert(localStorage.getItem(legacy)===original,'foreign legacy command untouched');await render('A');assert(document.body.textContent?.includes('Original start'),'legacy original scope recovery remains available');assert(starts===1&&stops===1,'switches never replay effects');
 }finally{root.unmount();host.remove();api.listConversations=list;for(const [name,value] of prior){if(value===null)localStorage.removeItem(name);else localStorage.setItem(name,value);}}
}
