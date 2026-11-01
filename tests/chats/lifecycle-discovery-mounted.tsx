// Deferred source for the existing mounted browser harness; never executed here.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {LifecycleDiscovery} from '../../apps/web/src/components/lifecycle/LifecycleDiscovery';
import {currentProductScope} from '../../apps/web/src/api/productScope';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(item=>item.textContent===text)!;
const choose=async(index:number,text:string)=>{(document.querySelectorAll('[role=combobox]')[index] as HTMLElement).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));await settle();(Array.from(document.querySelectorAll('[role=option]')).find(item=>item.textContent?.includes(text)) as HTMLElement).click();await settle();};
export async function lifecycleDiscoveryRegression():Promise<void>{
 const originalFetch=globalThis.fetch,host=document.createElement('div');document.body.append(host);let root=createRoot(host);
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}}),gets:string[]=[],posts:{url:string;body:any}[]= [];
 const path='/api/lifecycle/destination-groups/group',storageKey=JSON.stringify(['lifecycle-command',window.location.origin,currentProductScope(),path]),saved=localStorage.getItem(storageKey);localStorage.removeItem(storageKey);
 const hash='a'.repeat(64),source={checkpointId:'package',sourceChatId:'old-chat',agentIds:['old-agent'],intent:{executionId:'old-run',resourceStepId:'source-step',resourceGeneration:0,frontierSha256:hash,bindingSha256:hash,configurationSha256:hash,hostCutSha256:hash}};
 const owner={projectId:'old-project',conversationId:'old-chat',project:'retained_only',conversation:'deletion_receipt'};
 const resources=[0,1].map(i=>({custody:{...source,sourceChatId:`source${i}`,custodyId:`custody${i}`},destination:{projectId:'destination-project',conversationId:`destination${i}`,executionId:'new-run',resourceStepId:`mapped${i}`,resourceGeneration:0}}));
 let staleImports=false,destinationRefuses=true,retired=false;
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{
  const url=String(input),method=init?.method??'GET';
  if(method==='POST'){
   const body=JSON.parse(String(init?.body));posts.push({url,body});
   if(url.endsWith('/branch-custody/review'))return json({source,custodyId:'custody',revision:'branch-revision',references:[],blockers:['retained owner evidence'],abandonmentBlockers:[]});
   assert(localStorage.getItem(storageKey)?.includes(body.commandKey),'save exact group command before mutation');
   if(url.endsWith('/approve'))return json({admissionId:'group',choice:body,reviewHash:'group-review',operatorId:'local-operator'});
   if(url.endsWith('/retire')){retired=true;throw new TypeError('Group response lost');}
   throw Error('Unexpected mutation '+url);
  }
  gets.push(url);
  if(url.includes('/agent-imports?')){
   if(url.includes('cursor='))return staleImports?json({error:'Inventory changed'},409):json({items:[{operationId:'operation-50',owner,product:'dev',status:'failed',phase:'retained',evidenceOrigin:'retained_lifecycle',evidenceSha256:hash}],revision:'imports'});
   return json({items:Array.from({length:50},(_,i)=>({operationId:`operation-${i}`,owner,product:'dev',status:'failed',phase:'retained',evidenceOrigin:'journal',evidenceSha256:hash})),revision:'imports',nextCursor:'opaque & cursor',unverifiedEvidenceCount:2});
  }
  if(url.includes('/destinations?'))return json({items:[{admissionId:'group',group:true,state:'staged',branchId:'branch',sourceExecutionId:'source',sourceOwner:'retained_only',checkpointId:7,checkpointHash:hash,destinations:resources.map((r,i)=>({...owner,conversationId:r.destination.conversationId,executionId:'new-run',resourceStepId:`mapped${i}`,sourceChatId:r.custody.sourceChatId})),evidenceSha256:hash}],revision:'destinations'});
  if(url.includes('/checkpoint-capture-groups?'))return json({items:[],revision:'group-captures'});
  if(url.includes('/checkpoint-captures?'))return json({items:[{captureKey:'original capture key',source,sourceOwner:'retained_only',state:'capturing',evidenceSha256:hash}],revision:'captures'});
  if(/\/agent-imports\/operation-\d+$/.test(url))return json({operationId:url.split('/').at(-1),canRetireMutationFree:false,blockers:['Unresolved evidence stays held'],reviewSha256:hash});
  if(url.endsWith('/review'))return destinationRefuses?json({error:'Second destination deletion proof missing'},409):json({admissionId:'group',reviewHash:'group-review',reservation:{resources},groupChats:[{conversation_id:'destination0'},{conversation_id:'destination1'}],references:[],state:'staged',stage:null,evidenceRevision:'evidence',canReleaseSourcePins:false,preserveOnlyPermanent:true,globalRuntimeQuiescenceRequired:true});
  if(url.endsWith('/receipt'))return retired?json({admissionId:'group',commandKey:posts.find(p=>p.url.endsWith('/approve'))!.body.commandKey,reviewHash:'group-review',releasedSourcePins:false,retiredAt:'now',resources,groupChats:[],evidenceSha256:hash}):json({error:'Missing receipt'},404);
  throw Error('Unexpected read '+url);
 };
 const render=()=>root.render(<QueryClientProvider client={client}><LifecycleDiscovery/></QueryClientProvider>);
 try{
  render();await settle();assert(gets.some(url=>url.includes('/checkpoint-captures?')),'source collection loads independently');
  button('Load more import operations').click();await settle();assert(gets.some(url=>url.includes('cursor=opaque%20%26%20cursor')),'cursor encoded exactly');
  await choose(0,'operation-50');assert(document.body.textContent?.includes('retained_lifecycle'),'historical import origin visible');
  await choose(1,'Group group');button('Review group retirement').click();await settle();assert(document.body.textContent?.includes('Second destination deletion proof missing'),'group review refusal shown');
  button('Close').click();await settle();await choose(2,'original capture key');button('Review Branch evidence').click();await settle();
  assert(document.body.textContent?.includes('Canonical discovered capture key: original capture key'),'full source and actual key reach independent Branch review');
  button('Close').click();await settle();destinationRefuses=false;button('Review group retirement').click();await settle();button('Refresh current review').click();await settle();
  assert(document.body.textContent?.includes('destination1'),'every group slot is reviewable');
  const acknowledge=Array.from(document.querySelectorAll('label')).find(l=>l.textContent==='I reviewed this exact scope and evidence')!.querySelector('input')!;acknowledge.click();await settle();
  button('Approve retirement choice').click();await settle();button('Confirm exact command').click();await settle();
  assert(posts.filter(p=>p.url.endsWith('/retire')).length===0,'group approval never auto-retires');
  button('Confirm retirement').click();await settle();button('Retire destination').click();await settle();
  const mutations=posts.filter(p=>p.url.endsWith('/approve')||p.url.endsWith('/retire'));assert(JSON.stringify(mutations[0].body)===JSON.stringify(mutations[1].body),'group approval/retire same stable choice');
  root.unmount();root=createRoot(host);render();await settle();await choose(1,'Group group');button('Review group retirement').click();await settle();button('Inspect retirement receipt').click();await settle();
  assert(posts.filter(p=>p.url.endsWith('/retire')).length===1&&!localStorage.getItem(storageKey),'remount receipt is pure GET');
  button('Close').click();await settle();button('Restart import operations').click();await settle();await choose(0,'operation-0');button('Review import custody').click();await settle();
  button('Close').click();await settle();staleImports=true;button('Load more import operations').click();await settle();assert(!button('Review import custody'),'paging409 removes stale selection and dialogs');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;if(saved===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,saved);}
}
