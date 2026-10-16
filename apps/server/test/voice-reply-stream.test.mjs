import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AgentStore, CoordinationV3Store, BranchStore } from '../../../packages/agents/dist/index.js';
import { authorizeCandidateMutation, candidateMutationAllowed } from '../../../preview-policy.mjs';
import { createServer } from '../dist/app.js';
import { mapCodexAppServerNotification } from '../../../packages/engines/dist/index.js';
import { PONDEROSA_VOICE_REPLY_TOOL } from '@ponderosa/core';
import { createProviderDynamicToolHandler } from '../dist/routes/provider-dynamic-tool-handler.js';
import { VoiceReplyStream } from '../dist/voice-reply-stream.js';
const snapshot=()=>({projectId:'p',conversationId:'c',agentId:'a',messageId:'m',runId:'r',fence:1,streamId:'s',sequence:0,text:'',state:'open',acceptedAt:'2026-10-10T00:00:00Z'});
const candidate=(kind,text='',patch={})=>({type:'response_text',providerTurnId:'provider-turn',itemId:'item',phase:'final_answer',kind,text,...patch});
const armedStream=(steering=[])=>{const initial=snapshot(),s=new VoiceReplyStream(initial,steering,'authorize');s.observeWork({type:'tool_result',id:'authorize',output:'',isError:false,voiceReplyStreamId:initial.streamId});return s;};
test('candidate bytes cannot precede an exact explicit-success normalized acknowledgement',()=>{
 const s=new VoiceReplyStream(snapshot(),[],'authorize');
 assert.equal(s.accept(candidate('start'),'at'),true);
 assert.equal(s.snapshot.state,'failed');
 s.observeWork({type:'tool_result',id:'authorize',output:'',isError:false,voiceReplyStreamId:'s'});
 assert.equal(s.accept(candidate('complete','Forbidden'),'at'),false);assert.equal(s.finalText(),undefined);
});
test('stream orders one item, reconciles completion and bounds text/events',()=>{
 const s=armedStream();s.accept(candidate('start'),'at');
 s.accept(candidate('delta','First sentence. '),'first');s.accept(candidate('delta','Tail'),'second');
 assert.equal(s.snapshot.firstTextAt,'first');assert.equal(s.finalText(),undefined);
 s.accept(candidate('complete','First sentence. Tail'),'complete');assert.equal(s.finalText(),'First sentence. Tail');
 s.complete('canonical-time');assert.equal(s.snapshot.completedAt,'canonical-time');
 const b=armedStream();b.accept(candidate('start'),'at');b.accept(candidate('delta','x'.repeat(10001)),'at');assert.equal(b.snapshot.state,'failed');assert.equal(b.finalText(),undefined);
});
test('commentary, foreign item, invalidation and unsupported phase cannot yield early response',()=>{
 const s=armedStream();assert.equal(s.accept(candidate('start','',{phase:'commentary'}),'at'),false);
 s.accept(candidate('start','',{phase:'unknown'}),'at');assert.equal(s.accept(candidate('delta','secret',{phase:'unknown'}),'at'),false);assert.equal(s.snapshot.text,'');
 assert.equal(s.accept(candidate('delta','foreign',{itemId:'foreign'}),'at'),false);
 s.accept(candidate('complete','Fallback',{phase:'unknown'}),'at');assert.equal(s.snapshot.state,'open');assert.equal(s.finalText(),'Fallback');
 s.invalidate();assert.equal(s.finalText(),undefined);assert.equal(s.accept(candidate('delta','late'),'at'),false);
});
test('scoped text follows canonical Unicode and steering normalization across deltas',()=>{
 const s=armedStream(['steering-id']);s.accept(candidate('start'),'at');
 s.accept(candidate('delta','  Cafe'),'at');s.accept(candidate('delta','\u0301 references steering-'),'at');s.accept(candidate('delta','id. '),'at');
 assert.equal(s.snapshot.text,'Café references [steering reference]. ');
 s.accept(candidate('complete','  Cafe\u0301 references steering-id. '),'at');
 assert.equal(s.finalText(),'Café references [steering reference].');
});
test('rapid phrase backpressure stops telemetry but retains the final authorized answer',()=>{
 const s=armedStream();s.accept(candidate('start'),'at');
 for(let i=0;i<270;i++)s.accept(candidate('delta','A. '),'at');
 assert.equal(s.snapshot.state,'failed');assert.ok(s.snapshot.sequence<=256);
 const seq=s.snapshot.sequence;s.accept(candidate('delta','late'),'at');assert.equal(s.snapshot.sequence,seq);
 s.accept(candidate('complete','A. '.repeat(270)),'at');assert.equal(s.finalText(),'A. '.repeat(270).trim());
 s.invalidate();assert.equal(s.finalText(),undefined);
});
async function boundedWait(condition,label){const deadline=Date.now()+7000;while(!condition()){assert.ok(Date.now()<deadline,label);await new Promise(r=>setTimeout(r,10));}}
async function fixture(options={},runCheck){
 const dir=await mkdtemp(path.join(tmpdir(),'voice-stream-canonical-'));console.log('OWN ROOT',dir);
 const store=new AgentStore(dir),coord=new CoordinationV3Store(store.sqlite),token=randomBytes(32).toString('hex'),headers={authorization:`Bearer ${token}`};
 const project=store.createProject({label:'Synthetic voice streaming',hostPath:dir,defaultEngine:'fixture'}),chat=store.createConversation(project.id,{title:'Voice test'}),agent=store.createAgent(project.id,{engine:'fixture',conversationId:chat.id,title:'Voice'});
 const branch=new BranchStore(store.sqlite,coord).create('Disposable streaming Branch','fixture');
 store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(branch.id,chat.id);
 const installation={branchId:branch.id,projectId:project.id,conversationId:chat.id,spokespersonId:agent.id,supported:true,deliveryMode:'user-ui',voiceEnabled:true};
 let app,release,armed,reauthorization,starts=0,submitted=[],completion,reached=false;const gate=new Promise(r=>release=r);const done=new Promise(r=>completion=r);
 const run=async function*(opts){try{
  starts++;submitted.push(store.getProviderInput(coord.activeAgentRun(agent.id).id,true));yield {type:'text',delta:'FORBIDDEN WORK LOG'};
  if(options.ordinaryWork)yield* mapCodexAppServerNotification({method:'item/started',params:{item:{type:'webSearch',id:'ordinary',query:'PRIVATE NATIVE PAYLOAD'}}},dir);
  yield* mapCodexAppServerNotification({method:'item/started',params:{item:{type:'dynamicToolCall',id:'voice-authorize',tool:'ponderosa_voice_reply',arguments:{}}}},dir);
  const fence=coord.latestAcknowledgedSteeringInjection(coord.activeAgentRun(agent.id).id);
  const authorization=await createProviderDynamicToolHandler(app,[PONDEROSA_VOICE_REPLY_TOOL],opts.environment.PONDEROSA_AGENT_MESSAGE_TOKEN)({id:'voice-rpc',operationId:'voice-authorize',name:'ponderosa_voice_reply',arguments:fence?{steeringInjectionId:fence}:{}});
  assert.equal(authorization.text,armed.body,'actual provider tool route receipt');
  if(authorization.success){
   // Normal authorizing acknowledgement must not invalidate the stream.
   for(const ack of mapCodexAppServerNotification({method:'item/completed',params:{item:{type:'dynamicToolCall',id:'voice-authorize',tool:'ponderosa_voice_reply',success:true,contentItems:[{text:armed.body,type:'inputText'}]}}},dir))yield ack;
   if(options.delayedAuthorStart)yield {type:'tool_call',id:'voice-authorize',name:'ponderosa_voice_reply',input:{}};
   const work=function*(){if(options.nativeItems){for(const notification of options.nativeItems)yield* mapCodexAppServerNotification(notification,dir);}else yield options.work;};
   if(options.workAt==='before')yield* work();
   yield candidate('start','',options.unknown?{phase:'unknown'}:{});
   yield candidate('delta','First stable phrase. ',options.unknown?{phase:'unknown'}:{});
   yield {type:'reasoning',delta:'FORBIDDEN REASONING'};
   if(options.workAt==='during')yield* work();
   if(options.workAt==='after'){yield candidate('complete','First stable phrase. ');yield* work();}
   if(options.nativeItems){
    reauthorization=await createProviderDynamicToolHandler(app,[PONDEROSA_VOICE_REPLY_TOOL],opts.environment.PONDEROSA_AGENT_MESSAGE_TOKEN)({id:'reauthorize-rpc',operationId:'voice-authorize',name:'ponderosa_voice_reply',arguments:fence?{steeringInjectionId:fence}:{}});
    // A duplicate original acknowledgement and new candidates cannot restore authority.
    yield* mapCodexAppServerNotification({method:'item/completed',params:{item:{type:'dynamicToolCall',id:'voice-authorize',tool:'ponderosa_voice_reply',success:true,contentItems:[{text:authorization.text,type:'inputText'}]}}},dir);
   }
   if(options.overflow)yield candidate('delta','x'.repeat(10001));
   reached=true; await gate;
   // Deliberately yield late bytes even after abort; host must fence them.
   yield candidate('delta','Second phrase.');yield candidate('complete','First stable phrase. Second phrase.');
  }else{await gate;const result=await app.inject({method:'POST',url:'/api/agent-messages',headers:{authorization:`Bearer ${opts.environment.PONDEROSA_AGENT_MESSAGE_TOKEN}`},payload:{text:'Canonical fallback.',...(fence?{steeringInjectionId:fence}:{})}});assert.equal(result.statusCode,200,result.body);}
  yield {type:'turn_done'};
 }finally{completion();}};
 const adapter={id:'fixture',displayName:'Inert',trustedSystemPromptChannel:'developer',supportsVoiceReplyStream:!options.unsupported,listModels:()=>[],listEfforts:()=>[],seed:run,continue:run};
 try{
 app=createServer({dataDir:dir,store,authToken:token,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,memoryEnabled:options.memory===true,communicationV3:{pollMs:10}});
 app.addHook('onSend',async(request,reply,payload)=>{if(request.url==='/api/agent-voice-reply')armed={statusCode:reply.statusCode,body:typeof payload==='string'?payload:JSON.stringify(payload)};return payload;});
 let memoryRecord;
 const memoryUrl=`/api/branches/engine/projects/${project.id}/memories`;
 if(options.publicationAckRace){
  let changed=false;
  app.addHook('onSend',async(request,reply,payload)=>{
   if(request.url==='/api/agent-messages'&&reply.statusCode===200&&!changed){
    changed=true;
    const update=await app.inject({method:'POST',url:memoryUrl,headers,payload:{operation:'update',memoryId:memoryRecord.memoryId,expectedRevision:memoryRecord.revision,text:'Synthetic voice input NEW after commit',classification:'user_statement',commandKey:'publication-ack-race'}});
    assert.equal(update.statusCode,200,update.body);
   }
   return payload;
  });
 }
 if(options.publicationRace){
  let changed=false;
  app.addHook('preHandler',async request=>{
   if(request.url==='/api/agent-messages'&&!changed){
    changed=true;
    const update=await app.inject({method:'POST',url:memoryUrl,headers,payload:{operation:'update',memoryId:memoryRecord.memoryId,expectedRevision:memoryRecord.revision,text:'Synthetic voice input NEW at publication',classification:'user_statement',commandKey:'publication-race'}});
    assert.equal(update.statusCode,200,update.body);
   }
  });
 }
 await app.ready();
 if(options.memory){
  const saved=await app.inject({method:'POST',url:memoryUrl,headers,payload:{operation:'save',text:'Synthetic voice input remembers the OLD value',commandKey:'initial-memory',classification:'user_statement',...(options.expiry?{expiresAt:new Date(Date.now()+1300).toISOString()}:{})}});
  assert.equal(saved.statusCode,200,saved.body);memoryRecord=saved.json();
 }
 if(options.global){
  const globalSaved=await app.inject({method:'POST',url:'/api/branches/engine/memories',headers,payload:{operation:'save',text:'Synthetic voice input GLOBAL OLD',commandKey:'global-save',classification:'user_statement',scope:'global'}});assert.equal(globalSaved.statusCode,200,globalSaved.body);
  const granted=await app.inject({method:'PUT',url:`/api/branches/engine/projects/${project.id}/memory-global-grant`,headers,payload:{enabled:true,expectedRevision:0}});assert.equal(granted.statusCode,200,granted.body);
 }
 const input={text:'Synthetic voice input' ,idempotencyKey:'turn',recipients:[{agentId:agent.id}],activeRunDelivery:'queue',...(!options.ordinary?{voiceReply:true}:{})};
 const sendUrl=`/api/branches/engine/conversations/${chat.id}/direct-messages`;
 assert.equal(candidateMutationAllowed('POST',sendUrl,input,[installation]),true);
 const sent=await app.inject({method:'POST',url:sendUrl,headers,payload:input});assert.equal(sent.statusCode,200,sent.body);
 const messageId=sent.json().message.communicationEventId;
 await boundedWait(()=>armed,'arm tool result');
 await boundedWait(()=>options.unsupported||options.ordinary||reached,'candidate processed');
 const url=`/api/branches/engine/conversations/${chat.id}/voice-replies/${messageId}/${agent.id}`;
 await runCheck({app,store,coord,agent,chat,project,headers,messageId,url,release,done,installation,get armed(){return armed;},get reauthorization(){return reauthorization;},get starts(){return starts;},memoryRecord,memoryUrl,submitted});
 }finally{release();if(app){if(starts)await done;app.prepareForShutdown();await app.close();assert.equal(app.server.listening,false);console.log('OWN SERVER CLOSED');}store.close();await rm(dir,{recursive:true,force:true});
  await new Promise(resolve=>setImmediate(resolve));
  console.log('FIXTURE RESOURCE OBSERVATION',JSON.stringify({root:dir,listening:app?.server.listening??false,activeResources:process.getActiveResourcesInfo(),activeHandleTypes:process._getActiveHandles().map(x=>x.constructor.name)}));
  console.log('RELEASED ROOT',dir);}
}
test('inert Branch-owned accepted DM → scheduled Run → scoped early text → one canonical final and delivery receipt',async()=>fixture({},async f=>{
 assert.equal(f.armed.statusCode,200,f.armed.body);
 const early=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.equal(early.reply.text,'First stable phrase. ');assert.equal(early.reply.state,'streaming');
 await f.app.listen({host:'127.0.0.1',port:0});
 const origin=`http://127.0.0.1:${f.app.server.address().port}`;
 const streamPath=`/api/branches/engine/agents/${f.agent.id}/stream`;
 assert.equal((await fetch(origin+streamPath)).status,401,'actual socket requires operator authentication');
 async function replay(cursor=0){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
  let reader;
  try{
   const response=await fetch(origin+streamPath+`?lastEventId=${cursor}`,{headers:f.headers,signal:controller.signal});assert.equal(response.status,200);
   reader=response.body.getReader();let text='';const events=[];
   while(!events.some(e=>e.event?.type==='voice_reply'&&e.event.reply.state==='streaming')){
    const chunk=await reader.read();assert.equal(chunk.done,false);text+=new TextDecoder().decode(chunk.value);
    let boundary;while((boundary=text.indexOf('\n\n'))>=0){const frame=text.slice(0,boundary);text=text.slice(boundary+2);if(frame.startsWith('event: message')||frame.includes('\nevent: message')){const line=frame.split('\n').find(l=>l.startsWith('data: '));if(line)events.push(JSON.parse(line.slice(6)));}}
   }
   return events;
  }finally{clearTimeout(timer);await reader?.cancel().catch(()=>{});controller.abort()}
 }
 const firstReplay=await replay();const snapshots=firstReplay.filter(e=>e.event?.type==='voice_reply');
 assert.ok(snapshots.every(e=>e.agentId===f.agent.id&&e.event.reply.runId===early.runId));
 const reconnect=await replay(Math.max(0,snapshots.at(-1).seq-1));
 assert.equal(reconnect.filter(e=>e.event?.type==='voice_reply').at(-1).event.reply.sequence,snapshots.at(-1).event.reply.sequence,'authenticated reconnect returns the same cumulative snapshot');

 assert.ok(early.acceptedAt&&early.leasedAt&&early.runStartedAt&&early.reply.firstTextAt);
 assert.ok(Date.parse(early.runStartedAt)>=Date.parse(early.acceptedAt));
 assert.equal(f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent').length,0);
 assert.equal((await f.app.inject({method:'GET',url:f.url})).statusCode,401);
 assert.equal((await f.app.inject({method:'GET',url:f.url.replace(f.messageId,'foreign'),headers:f.headers})).statusCode,404);
 assert.equal((await f.app.inject({method:'GET',url:f.url.replace('/api/branches/engine/','/api/'),headers:f.headers})).statusCode,404,'ordinary product cannot read Branch voice snapshots');
 const reconnected=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.deepEqual(reconnected.reply,early.reply,'cumulative recovery snapshot is stable without a new event');
 f.release();await f.done;
 await boundedWait(()=>f.coord.runtimeCommunications(f.project.id).some(x=>x.payload.communication?.sender.kind==='agent'),'canonical reply');
 await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'run released');
 const replies=f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent');assert.equal(replies.length,1);assert.equal(replies[0].payload.communication.text,'First stable phrase. Second phrase.');assert.equal(replies[0].payload.communication.intent,'user_dm');assert.equal(replies[0].payload.communication.audience.kind,'user_agent');
 const after=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.equal(after.reply.state,'completed');assert.equal(after.reply.firstTextAt,early.reply.firstTextAt);
 const chat=(await f.app.inject({method:'GET',url:`/api/branches/engine/conversations/${f.chat.id}?limit=20`,headers:f.headers})).json();
 assert.equal(chat.messages.filter(x=>x.role==='assistant').length,1);const sent=chat.messages.find(x=>x.communicationEventId===f.messageId);assert.equal(sent.deliveryReceipts[0].state,'processed');
 const evidence=f.store.readEvents(f.agent.id).filter(x=>x.event.type==='voice_reply');assert.equal(evidence.at(-1).event.reply.state,'completed');assert.equal(evidence.at(-1).event.reply.completedAt,replies[0].createdAt);
 console.log('CANONICAL STREAM ORACLE',JSON.stringify({communications:replies.length,receipt:sent.deliveryReceipts[0].state,snapshots:evidence.length,runId:early.runId,timings:early}));
}));
test('exact cancellation rejects late chunks and final publication; successor is never guessed',async()=>fixture({},async f=>{
 const run=f.coord.activeAgentRun(f.agent.id);
 const url=`/api/branches/engine/agents/${f.agent.id}/cancel`,body={targetRunId:run.id,idempotencyKey:'cancel'};
 const readJson=async path=>{const response=await f.app.inject({method:'GET',url:path,headers:f.headers});assert.equal(response.statusCode,200,response.body);return response.json()};
 assert.equal(await authorizeCandidateMutation('POST',url,body,[f.installation],{readJson}),true);
 assert.equal(await authorizeCandidateMutation('POST',url,{...body,targetRunId:'foreign'},[f.installation],{readJson}),false);
 const cancel=f.app.inject({method:'POST',url,headers:f.headers,payload:body});
 await boundedWait(()=>f.coord.isSchedulerRunCancelled(run.id),"canonical cancellation fence");
 f.release();const result=await cancel;assert.equal(result.statusCode,200,result.body);await f.done;
 assert.equal(f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent').length,0);
 const events=f.store.readEvents(f.agent.id).filter(x=>x.event.type==='voice_reply');assert.ok(events.every(x=>!x.event.reply.text.includes('Second phrase')));
}));
for(const options of [{unsupported:true},{ordinary:true},{unknown:true},{overflow:true}])test(`canonical fallback ${JSON.stringify(options)}`,async()=>fixture(options,async f=>{
 assert.equal(f.armed.statusCode,options.unknown||options.overflow?200:409,f.armed.body);
 if(options.overflow){const status=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.equal(status.reply.state,'failed');assert.ok(status.reply.text.length<=10000);}
 if(options.unknown){const status=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.equal(status.reply.text,'');}
 f.release();await f.done;await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'fallback completed');
 const replies=f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent');assert.equal(replies.length,1);assert.equal(f.starts,1);
}));

for(const work of [{type:'work_start',kind:'command',callId:'native'}, {type:'work_start',kind:'file_change',callId:'native'}, {type:'command',command:'inert native work',cwd:'/synthetic',callId:'native'},
 {type:'file_change',path:'synthetic.txt',kind:'edit',callId:'native'}])
for(const workAt of ['before','during','after'])test(`native ${work.type} ${workAt} invalidates irreversibly on actual host path`,async()=>fixture({work,workAt},async f=>{
 assert.equal(f.armed.statusCode,200,f.armed.body);
 const early=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();
 assert.equal(early.reply.state,'failed');
 const failures=f.store.readEvents(f.agent.id).filter(x=>x.event.type==='voice_reply'&&x.event.reply.state==='failed');assert.ok(failures.length);
 const firstFailedSeq=failures[0].seq;
 f.release();await f.done;await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'invalidated Run completed');
 const events=f.store.readEvents(f.agent.id).filter(x=>x.event.type==='voice_reply'&&x.seq>firstFailedSeq);
 assert.ok(events.every(x=>x.event.reply.state==='failed'&&!x.event.reply.text.includes('Second phrase')));
 const replies=f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent');
 assert.equal(replies.filter(x=>x.payload.communication.sender.executionId===early.runId).length,0,'stale item never becomes canonical Communication in its exact Run');
 assert.ok(replies.every(x=>x.payload.communication.text==='Canonical fallback.'),'only explicit canonical recovery fallback may publish');
 console.log('INVALIDATED EXACT RUN ORACLE',JSON.stringify({work,workAt,originalRun:early.runId,originalCanonicalRows:0,recoveredExplicitFallbacks:replies.length,adapterStarts:f.starts}));
 if(work.type==='work_start')assert.ok(!f.store.readEvents(f.agent.id).some(x=>x.event.type==='work_start'),'internal boundary never enters public LogEvent');
 else assert.ok(f.store.readEvents(f.agent.id).some(x=>x.event.type===work.type),'ordinary work evidence remains');
}));

test('exact delayed authorizing start/ack preserve streaming and one canonical reply',async()=>fixture({delayedAuthorStart:true},async f=>{
 assert.equal((await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json().reply.state,'streaming');
 f.release();await f.done;await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'authorized complete');
 assert.equal(f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent').length,1);
}));

for(const work of [{type:'tool_call',id:'foreign',name:'ponderosa_voice_reply',input:{}},
 {type:'tool_call',id:'voice-authorize',name:'foreign.ponderosa_voice_reply',input:{}},
 {type:'tool_result',id:'foreign',output:'authorizing prose'},
 {type:'tool_result',id:'voice-authorize',output:'authorizing prose'},
 {type:'tool_result',id:'voice-authorize',output:'forged receipt',voiceReplyStreamId:'foreign-stream',isError:false},
 {type:'tool_result',id:'voice-authorize',output:'failure',isError:true}])test(`foreign/error operation ${work.type} ${work.id} ${work.name??''} cannot exempt work`,async()=>fixture({work,workAt:'after'},async f=>{
 const early=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.equal(early.reply.state,'failed');
 f.release();await f.done;await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'foreign work completed');
 const replies=f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent');
 assert.equal(replies.filter(x=>x.payload.communication.sender.executionId===early.runId).length,0);assert.ok(replies.every(x=>x.payload.communication.text==='Canonical fallback.'));
 console.log('FOREIGN WORK EXACT RUN ORACLE',JSON.stringify({work,originalRun:early.runId,originalCanonicalRows:0,recoveredExplicitFallbacks:replies.length}));
}));
test('ordinary nonvoice native work still permits its explicit canonical reply',async()=>fixture({ordinary:true,ordinaryWork:true},async f=>{
 assert.equal(f.armed.statusCode,409);f.release();await f.done;await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'ordinary completion');
 const replies=f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent');
 assert.equal(replies.length,1);assert.equal(replies[0].payload.communication.text,'Canonical fallback.');
 assert.ok(!f.store.readEvents(f.agent.id).some(x=>x.event.type==='work_start'));
}));

const nativeItem=(type,method)=>({method,params:{item:{type,id:'native-work',query:'PRIVATE NATIVE PAYLOAD',path:'/inert/image',tool:'inert',arguments:{},changes:[]}}});
const nativeCases=[];
for(const type of ['webSearch','imageView','collabToolCall'])for(const method of ['item/started','item/completed'])for(const workAt of ['before','during','after'])nativeCases.push({label:`${type} ${method} ${workAt}`,nativeItems:[nativeItem(type,method)],workAt});
for(const type of ['commandExecution','fileChange','mcpToolCall','dynamicToolCall','functionCallOutput','enteredReviewMode','exitedReviewMode','hookPrompt','collabAgentToolCall','sleep','imageGeneration','futureNativeTool'])nativeCases.push({label:`${type} completion-only after`,nativeItems:[nativeItem(type,'item/completed')],workAt:'after'});
nativeCases.push({label:'reordered completion then start after',nativeItems:[nativeItem('webSearch','item/completed'),nativeItem('webSearch','item/started')],workAt:'after'});
nativeCases.push({label:'malformed missing item during',nativeItems:[{method:'item/started',params:{}}],workAt:'during'});
for(const {label,nativeItems,workAt} of nativeCases)test(`mapper native ${label} fails closed on authenticated host path`,async()=>fixture({nativeItems,workAt},async f=>{
 const early=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();
 assert.equal(early.reply.state,'failed');
 assert.equal(f.reauthorization.success,false,'broken authority cannot be reauthorized');
 assert.equal(JSON.parse(f.reauthorization.text).authorized,false);
 const failures=f.store.readEvents(f.agent.id).filter(x=>x.event.type==='voice_reply'&&x.event.reply.state==='failed');assert.ok(failures.length);
 const seq=failures[0].seq;
 f.release();await f.done;await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'native invalidation completed');
 const late=f.store.readEvents(f.agent.id).filter(x=>x.event.type==='voice_reply'&&x.seq>seq&&x.event.reply.runId===early.runId);
 assert.ok(late.every(x=>x.event.reply.state==='failed'&&!x.event.reply.text.includes('Second phrase')));
 const replies=f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent');
 assert.equal(replies.filter(x=>x.payload.communication.sender.executionId===early.runId).length,0);
 assert.ok(replies.every(x=>x.payload.communication.sender.executionId!==early.runId&&x.payload.communication.text==='Canonical fallback.'));
 assert.ok(!f.store.readEvents(f.agent.id).some(x=>['work_start','response_text'].includes(x.event.type)),'private native boundary/candidate never becomes LogEvent');
 const chat=(await f.app.inject({method:'GET',url:`/api/branches/engine/conversations/${f.chat.id}?limit=20`,headers:f.headers})).json();
 assert.ok(!JSON.stringify(chat).includes('PRIVATE NATIVE PAYLOAD'),'native payload never becomes Chat');
 console.log('MAPPER NATIVE EXACT RUN ORACLE',JSON.stringify({label,originalCanonicalRows:0,recoveredExplicitFallbacks:replies.length,adapterStarts:f.starts,originalRun:early.runId,reauthorization:f.reauthorization.success}));
}));

test('short split sentence emits a new cumulative snapshot before completion without trailing space',()=>{
 const s=armedStream();s.accept(candidate('start'),'at');
 s.accept(candidate('delta','A short'),'one');const sequence=s.snapshot.sequence;
 assert.equal(s.accept(candidate('delta',' sentence.'),'two'),true);
 assert.ok(s.snapshot.sequence>sequence);assert.equal(s.snapshot.text,'A short sentence.');
 assert.equal(s.finalText(),undefined);
});
for(const operation of ['update','forget'])test(`memory ${operation} invalidates exposed speech while model is paused and rejects stale final`,async()=>fixture({memory:true},async f=>{
 const early=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.equal(early.reply.state,'streaming');
 const record=f.memoryRecord;
 const changed=await f.app.inject({method:'POST',url:f.memoryUrl,headers:f.headers,payload:{operation,memoryId:record.memoryId,expectedRevision:record.revision,commandKey:'change-memory',...(operation==='update'?{text:'Synthetic voice input now remembers the NEW value',classification:'user_statement'}:{})}});
 assert.equal(changed.statusCode,200,changed.body);
 // No model event arrives during this wait: notification must not rely on a next chunk.
 let failure;
 await boundedWait(()=>{failure=f.store.readEvents(f.agent.id).find(e=>e.event.type==='voice_reply'&&e.event.reply.failureReason==='context_changed');return failure;},'paused stream notified after memory mutation');
 assert.equal(failure.event.reply.state,'failed');
 f.release();await f.done;await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'stale Run released');
 const late=f.store.readEvents(f.agent.id).filter(e=>e.event.type==='voice_reply'&&e.seq>failure.seq);
 assert.ok(late.every(e=>e.event.reply.state==='failed'&&!e.event.reply.text.includes('Second phrase')));
 const original=f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent'&&x.payload.communication.sender.executionId===early.runId);
 assert.equal(original.length,0,'memory-stale Run cannot publish its canonical voice fallback');
 await boundedWait(()=>f.submitted.length>=2,'fresh required-reply recovery turn prepared');
 const successor=f.submitted[1];const selected=successor.sourceManifest.sources.filter(x=>x.kind==='memory');
 if(operation==='update'){
  assert.ok(selected.some(x=>x.ref===record.memoryId&&x.revision===2));
  assert.ok(successor.exactPrompt.includes('Synthetic voice input now remembers the NEW value'));
 }else assert.ok(!selected.some(x=>x.ref===record.memoryId));
 assert.ok(!successor.exactPrompt.includes('Synthetic voice input remembers the OLD value'),'fresh turn never retains old memory packet');
 console.log('MEMORY STREAM ORACLE',JSON.stringify({operation,runId:early.runId,failedSequence:failure.seq,originalCanonicalReplies:original.length}));
}));

for(const mode of ['expiry','grant'])test(`memory ${mode} invalidates the paused stream without another provider chunk`,async()=>fixture({memory:true,expiry:mode==='expiry',global:mode==='grant'},async f=>{
 const early=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.equal(early.reply.state,'streaming');
 if(mode==='grant'){
  const revoke=await f.app.inject({method:'PUT',url:`/api/branches/engine/projects/${f.project.id}/memory-global-grant`,headers:f.headers,payload:{enabled:false,expectedRevision:1}});assert.equal(revoke.statusCode,200,revoke.body);
 }
 await boundedWait(()=>f.store.readEvents(f.agent.id).some(e=>e.event.type==='voice_reply'&&e.event.reply.failureReason==='context_changed'),`paused stream ${mode} notice`);
 f.release();await f.done;await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'invalid context Run released');
 assert.equal(f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent'&&x.payload.communication.sender.executionId===early.runId).length,0);
}));

test('memory change between final validation and injected canonical publication is rejected at durable boundary',async()=>fixture({memory:true,publicationRace:true},async f=>{
 const early=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();
 f.release();await f.done;await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'publication-race Run released');
 assert.ok(f.store.readEvents(f.agent.id).some(e=>e.event.type==='voice_reply'&&e.event.reply.failureReason==='context_changed'));
 assert.equal(f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent'&&x.payload.communication.sender.executionId===early.runId).length,0);
}));

test('context invalidation cannot be resurrected by completion or an old success acknowledgement',()=>{
 const s=armedStream();s.accept(candidate('start'),'at');s.accept(candidate('complete','A reply.'),'at');
 s.invalidate('context_changed');const sequence=s.snapshot.sequence;
 s.observeWork({type:'tool_result',id:'authorize',output:'',isError:false,voiceReplyStreamId:'s'});
 s.complete('late-success');assert.equal(s.snapshot.state,'failed');assert.equal(s.snapshot.sequence,sequence);assert.equal(s.finalText(),undefined);
});
test('memory change after canonical commit but before its HTTP acknowledgement cannot rearm speech',async()=>fixture({memory:true,publicationAckRace:true},async f=>{
 const early=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();f.release();await f.done;
 await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'committed Run released');
 const status=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.equal(status.reply.state,'failed');assert.equal(status.reply.failureReason,'context_changed');
 const original=f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent'&&x.payload.communication.sender.executionId===early.runId);
 assert.equal(original.length,1,'historical canonical commit preceded correction and is preserved');
}));
