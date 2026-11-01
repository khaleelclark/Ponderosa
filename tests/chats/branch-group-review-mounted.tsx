// Deferred source for the existing mounted browser harness; not executed.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BranchGroupReview} from '../../apps/web/src/components/branches/BranchGroupReview';
import {currentProductScope} from '../../apps/web/src/api/productScope';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text)!;
const check=(label:string)=>{const input=Array.from(document.querySelectorAll('label')).find(l=>l.textContent===label)?.querySelector('input');assert(input,label);input!.click();};
export async function branchGroupReviewRegression():Promise<void>{
 const originalFetch=globalThis.fetch,host=document.createElement('div');document.body.append(host);
 const storageKey=JSON.stringify(['branch-group',window.location.origin,currentProductScope(),'branch','source']),saved=localStorage.getItem(storageKey);localStorage.removeItem(storageKey);
 let root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const hash='a'.repeat(64),changed='b'.repeat(64),sent:{url:string;body:Record<string,unknown>}[]=[],gets:string[]=[];
 const sources=[0,1,2].map(i=>({checkpointId:`package${i}`,resourceStepId:`step${i}`,sourceChatId:`chat${i}`,sealed:true}));
 const resources=sources.map((s,i)=>({custody:{checkpointId:s.checkpointId,custodyId:`custody${i}`,sourceChatId:s.sourceChatId,sha256:hash,agentIds:[`original${i}`],intent:{executionId:'source',resourceStepId:s.resourceStepId,resourceGeneration:0,frontierSha256:hash,hostCutSha256:hash,bindingSha256:hash,configurationSha256:hash}},destination:{projectId:'fresh-project',conversationId:`fresh-chat${i}`,executionId:'fresh-run',resourceStepId:`fresh-step${i}`,resourceGeneration:0}}));
 let key='',state='awaiting_disclosure',revision=0,choiceState='unreviewed',reviewHash=hash,sourceState='waiting',stale=true,captureUnavailable=false,previewUnavailable=false,capturePreviewStale=true;
 const target=()=>({commandKey:key,admissionId:'admission',checkpointId:4,checkpointHash:hash,resources,state,restoreSupported:state==='admitted',disclosure:{revision,state:choiceState,reviewHash:choiceState==='unreviewed'?undefined:reviewHash}});
 const preview=()=>({admissionId:'admission',reviewHash,hostCutSha256:hash,policyRevision:hash,revision,state:choiceState,active:choiceState==='approved',review:{admissionId:'admission',reservation:{branchId:'branch',sourceExecutionId:'source',commandKey:key,checkpointId:4,checkpointHash:hash,resources},stage:{agentMap:{original0:'fresh0',original1:'fresh1'},artifactMap:{}}},policy:sources.map(s=>({sourceChatId:s.sourceChatId,policy:{revision:'current'}})),facts:[{kind:'communication',id:'private',sha256:hash,originalAgentIds:['original0','original1'],destinationAgentIds:['fresh0','fresh1'],originalActor:{agentId:'original0'},originalAudience:{agentIds:['original0','original1']},content:{text:'Exact whole-group private fact'}}]});
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{
  const url=String(input),method=init?.method??'GET';
  if(method==='POST'){
   const body=JSON.parse(String(init?.body));sent.push({url,body});assert(localStorage.getItem(storageKey)?.includes(String(body.commandKey)),'entire command key persisted before POST');
   if(url.endsWith('/capture')){assert(Object.keys(body).sort().join(',')==='commandKey,reviewHash,versionId','exact prospective CAS fields');assert(body.reviewHash===hash&&body.versionId==='version','original preview retained');throw new TypeError('Capture response lost after exact seals');}
   if(url.endsWith('/admit')){state='admitted';throw new TypeError('Admission response lost');}
   if(body.checkpointId){key=String(body.commandKey);throw new TypeError('Prepare response lost');}
   if(body.action==='approve'&&stale){stale=false;reviewHash=changed;return json({error:'Second Chat policy changed'},409);}
   choiceState=body.action==='approve'?'approved':'revoked';revision++;throw new TypeError('Choice response lost');
  }
  gets.push(url);
  if(url.endsWith('/capture-preview')&&capturePreviewStale){capturePreviewStale=false;return json({error:'cut changed'},409);}
  if(url.endsWith('/capture-preview'))return json({reviewHash:hash,versionId:'version',bindingRevisionId:'binding',frontierHash:hash,hostCutHash:hash,resources:sources.map((s,i)=>({resourceStepId:s.resourceStepId,sourceChatId:s.sourceChatId,generation:0,agentIds:[`original${i}`]}))});
  if(url.includes('/capture?'))return captureUnavailable?json({error:'Source checkpoint unavailable'},409):json({state:'retained',cleanupHeld:false,abandonment:'unsupported',checkpointId:4,checkpointHash:hash,sources});
  if(url.includes('/disclosure?')){
   const choice=[...sent].reverse().find(s=>s.body.action)!.body;
   return json({admissionId:'admission',commandKey:choice.commandKey,action:choice.action,reviewHash:choice.reviewHash,revision:Number(choice.expectedRevision)+1,state:choice.action==='approve'?'approved':'revoked',active:choiceState==='approved'});
  }
  if(url.endsWith('/disclosure'))return previewUnavailable?json({error:'Package unavailable'},409):json(preview());
  if(url.includes('/destination-groups?'))return json(target());
  throw Error('Unexpected route '+url);
 };
 const detail=()=>({execution:{id:'source',branchId:'branch',state:sourceState},resources:sources.map(s=>({stepExecutionId:s.resourceStepId,state:'active',agentIds:[]})),paths:[{id:'parallel0'},{id:'parallel1'}],attempts:[],steps:[],gates:[]});
 const definition={controls:[],steps:[]};
 const render=()=>root.render(<QueryClientProvider client={client}><BranchGroupReview detail={detail() as never} definition={definition as never} enabled onChanged={()=>{}}/></QueryClientProvider>);
 const open=async()=>{render();await settle();button('Review resource group').click();await settle();};
 const confirm=async()=>{await settle();button('Confirm exact group action').click();await settle();};
 const acknowledge=async()=>{check('I reviewed every original fact, actor, audience, mapped recipient, every resource identity and current policy');await settle();};
 try{
  await open();assert(document.body.textContent?.includes('no separate workspace'),'directory reuse warning');
  button('Preview authoritative capture cut').click();await settle();assert(button('Capture exact resource cut').disabled,'stale preview cannot capture');
  button('Preview authoritative capture cut').click();await settle();check('I reviewed the complete server capture inventory and exact cut hashes');await settle();check('I reconciled original external effects; unknown effects remain held');await settle();button('Capture exact resource cut').click();await confirm();
  assert(sent.length===1,'one capture attempt');assert(localStorage.getItem(storageKey)?.includes('pending'),'lost capture retained');
  root.unmount();root=createRoot(host);await open();button('Read retained group commands').click();await settle();assert(sent.length===1,'remount GET does not recapture');
  sourceState='completed';render();await settle();check('I reconciled original external effects; unknown effects remain held');await settle();button('Prepare held group').click();await confirm();
  assert(sent.length===2,'one prepare attempt');button('Read retained group commands').click();await settle();assert(sent.length===2,'pure prepare lookup');
  button('Review whole-group disclosure').click();await settle();assert(document.body.textContent?.includes('Exact whole-group private fact'),'whole private inventory shown');
  await acknowledge();button('Approve whole-group disclosure').click();await confirm();
  assert(!button('Admit whole group')||button('Admit whole group').disabled,'stale policy clears approval');
  button('Read retained group commands').click();await settle();button('Review whole-group disclosure').click();await settle();await acknowledge();button('Approve whole-group disclosure').click();await confirm();
  const count=sent.length;button('Read retained group commands').click();await settle();assert(sent.length===count,'choice recovery uses GET only');
  button('Review whole-group disclosure').click();await settle();await acknowledge();button('Admit whole group').click();await confirm();
  button('Read retained group commands').click();await settle();assert(sent.filter(s=>s.url.endsWith('/admit')).length===1,'lost admission never replayed');
  // Source status/preview refusal cannot suppress current persisted-choice revocation.
  state='awaiting_disclosure';captureUnavailable=true;previewUnavailable=true;button('Read retained group commands').click();await settle();
  assert(!button('Revoke whole-group disclosure').disabled,'independent destination read permits revoke without capture proof');
  button('Revoke whole-group disclosure').click();await confirm();button('Read retained group commands').click();await settle();
  assert(gets.some(url=>url.includes('/disclosure?commandKey=')),'exact choice readback');
  assert(sent.filter(s=>s.body.action==='revoke').length===1,'no revocation replay');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;if(saved===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,saved);}
}

// Canonical discovery recovery on an empty browser journal, including cursor invalidation.
export async function branchGroupDiscoveryRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{mutations:{retry:false}}}),originalFetch=globalThis.fetch;
 const key=JSON.stringify(['branch-group',window.location.origin,currentProductScope(),'branch','source']),saved=localStorage.getItem(key);localStorage.removeItem(key);
 const hash='a'.repeat(64),gets:string[]=[],sources=Array.from({length:32},(_,i)=>({resourceStepId:`step${i}`,sourceChatId:`chat${i}`,checkpointId:`package${i}`,sealed:true}));let invalid=false;
 const row={kind:'captures',branchId:'branch',executionId:'source',commandKey:'server-original',reviewHash:hash,versionId:'server-version',discovery:'exact',state:'retained',ownerPresent:true,resourceCount:32,checkpointId:4,checkpointHash:hash};
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{
  assert(!init?.method||init.method==='GET','canonical recovery must never POST');const url=String(input);gets.push(url);
  if(url.includes('/discovery?')){
   if(url.includes('cursor='))return invalid?json({error:'cursor stale'},409):json({items:[row]});
   return json({items:Array.from({length:50},()=>({...row,commandKey:undefined,discovery:'unsupported_legacy_key',ownerPresent:false})),nextCursor:'opaque-current-revision'});
  }
  if(url.includes('/capture?commandKey=server-original'))return json({state:'retained',cleanupHeld:false,abandonment:'unsupported',checkpointId:4,checkpointHash:hash,sources});
  throw Error('Unexpected route '+url);
 };
 try{
  const detail={execution:{id:'source',branchId:'branch',state:'completed'},resources:[],paths:[],attempts:[],steps:[],gates:[]};
  root.render(<QueryClientProvider client={client}><BranchGroupReview detail={detail as never} enabled onChanged={()=>{}}/></QueryClientProvider>);await settle();button('Review resource group').click();await settle();
  button('Restart capture discovery').click();await settle();assert(document.body.textContent?.includes('Unsupported legacy capture'),'legacy key explicitly unsupported');
  button('Load more group commands').click();await settle();button('Read discovered capture command').click();await settle();
  assert(localStorage.getItem(key)?.includes('server-original'),'cross-device canonical exact key retained');assert(document.body.textContent?.includes('package31'),'32nd source seal visible');
  button('Restart capture discovery').click();await settle();invalid=true;button('Load more group commands').click();await settle();
  assert(!document.body.textContent?.includes('Every exact source seal'),'stale capture selection cleared');assert(!button('Read discovered capture command'),'stale selectable row removed');
  assert(button('Capture exact resource cut').disabled,'stale confirmation cannot authorize capture');assert(gets.some(url=>url.includes('cursor=opaque-current-revision')),'exact opaque pagination');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=originalFetch;if(saved===null)localStorage.removeItem(key);else localStorage.setItem(key,saved);}
}
