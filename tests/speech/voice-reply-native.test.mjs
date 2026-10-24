import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {CapabilityPolicyStore} from '../../packages/agents/dist/index.js';
import {CAPABILITY_IDS} from '../../packages/core/dist/index.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {PonderosaMemory}=await import(createRequire(new URL('../../apps/server/package.json',import.meta.url)).resolve('@local-memory/mcp-node-private/ponderosa'));
import { randomBytes } from 'node:crypto';
import { AgentStore, CoordinationV3Store, BranchStore } from '../../packages/agents/dist/index.js';
import { createServer } from '../../apps/server/dist/app.js';
import { mapCodexAppServerNotification } from '../../packages/engines/dist/index.js';
import { PONDEROSA_VOICE_REPLY_TOOL } from '../../packages/core/dist/index.js';
import { createProviderDynamicToolHandler } from '../../apps/server/dist/routes/provider-dynamic-tool-handler.js';
import { localMemoryFor } from '../../apps/server/dist/local-memory.js';
import { VoiceReplyStream } from '../../apps/server/dist/voice-reply-stream.js';
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

let chroma;
async function isolatedChroma(){
 if(chroma)return chroma.url;
 const root=await mkdtemp(path.join(tmpdir(),'voice-private6-chroma-')),reserve=net.createServer();
 await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const child=spawn(process.env.PONDEROSA_TEST_CHROMA_BIN ?? 'chroma',['run','--path',root,'--host','127.0.0.1','--port',String(port)],{stdio:'ignore',env:{...process.env,ANONYMIZED_TELEMETRY:'False'}});
 chroma={root,child,url:'http://127.0.0.1:'+port,exit:once(child,'exit')};
 for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error('Owned Chroma exited');try{if((await fetch(chroma.url+'/api/v2/heartbeat')).ok)return chroma.url;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Owned Chroma unavailable');
}
after(async()=>{if(chroma){chroma.child.kill('SIGTERM');await chroma.exit;await rm(chroma.root,{recursive:true,force:true});}});
async function fixture(options={},runCheck){
 const dir=await realpath(await mkdtemp(path.join(tmpdir(),'voice-stream-canonical-')));console.log('OWN ROOT',dir);
 const store=new AgentStore(path.join(dir,'data')),coord=new CoordinationV3Store(store.sqlite),token=randomBytes(32).toString('hex'),headers={authorization:`Bearer ${token}`};
 const branch=new BranchStore(store.sqlite,coord).create('Disposable streaming Branch','fixture');
 const project=store.createProject({label:'Synthetic voice streaming',hostPath:dir,defaultEngine:'fixture',chatOwned:true,branchId:branch.id}),chat=store.getConversation(project.lastConversationId),agent=store.createAgent(project.id,{engine:'fixture',conversationId:chat.id,title:'Voice'});
 const installation={branchId:branch.id,projectId:project.id,conversationId:chat.id,spokespersonId:agent.id,supported:true,deliveryMode:'user-ui',voiceEnabled:true};
 let originalBindChat=PonderosaMemory.prototype.bindChat;
 let app,release,armed,reauthorization,starts=0,submitted=[],completion,reached=false,memoryRecord,memoryHeaders,globalRecord,fallbackResult;const modes=[];const gate=new Promise(r=>release=r);const done=new Promise(r=>completion=r);
 const run=async function*(opts,fresh){try{
  starts++;modes.push(fresh?'seed':'continue');if(options.retainedMemory)yield {type:'session',sessionId:fresh?randomBytes(16).toString('hex'):opts.resumeSessionId};submitted.push(store.getProviderInput(coord.activeAgentRun(agent.id).id,true));
   memoryHeaders={authorization:'Bearer '+opts.environment.PONDEROSA_AGENT_MESSAGE_TOKEN};
   if(options.memory&&options.readMemory!==false&&starts===1){
    memoryHeaders={authorization:'Bearer '+opts.environment.PONDEROSA_AGENT_MESSAGE_TOKEN};
    const saved=await app.inject({method:'POST',url:'/api/agent-local-memory',headers:memoryHeaders,payload:{operation:'save',text:'Synthetic voice input remembers the OLD value',destination:'chat'}});
    assert.equal(saved.statusCode,200,saved.body);memoryRecord=saved.json().structuredContent.result;
    if(options.writePreview){
     let target;
     if(options.writePreview==='update'){const saved=await app.inject({method:'POST',url:'/api/agent-local-memory',headers:memoryHeaders,payload:{operation:'save',text:'Separate synthetic voice target',destination:'chat'}});assert.equal(saved.statusCode,200,saved.body);target=saved.json().structuredContent.result.chunk_id;}
     const preview=await app.inject({method:'POST',url:'/api/agent-local-memory',headers:memoryHeaders,payload:{operation:options.writePreview,...(target?{chunk_id:target}:{}),destination:'chat',text:options.writePreview==='save'?'Update: Synthetic voice input remembers the OLD value':'Synthetic voice input remembers the OLD value with a revised detail'}});
     assert.equal(preview.statusCode,200,preview.body);
     const result=preview.json().structuredContent.result,candidates=result.candidate_update_targets??result.candidate_stale_parallel_chunks;
     assert.ok(candidates?.some(row=>row.chunk_id===memoryRecord.chunk_id&&row.text_preview.includes('OLD value')),preview.body);
    }else{
     const got=await app.inject({method:'POST',url:'/api/agent-local-memory',headers:memoryHeaders,payload:{operation:'get',chunk_id:memoryRecord.chunk_id,source:'chat'}});
     assert.equal(got.statusCode,200,got.body);assert.equal(got.json().structuredContent.result.found,true);
    }
    if(options.global){const global=await app.inject({method:'POST',url:'/api/agent-local-memory',headers:memoryHeaders,payload:{operation:'get',chunk_id:globalRecord.chunk_id,source:'global'}});assert.equal(global.statusCode,200,global.body);assert.equal(global.json().structuredContent.result.found,true);}
   }
   if(options.noVoiceTool){
    const fence=coord.latestAcknowledgedSteeringInjection(coord.activeAgentRun(agent.id).id);
    reached=true;await gate;
    const result=await app.inject({method:'POST',url:'/api/agent-messages',headers:memoryHeaders,payload:{text:options.retainedMemory&&starts>1?(fresh?'Fresh canonical context.':'Remembered revoked memory.'):'Canonical fallback.',...(fence?{steeringInjectionId:fence}:{})}});
    fallbackResult={statusCode:result.statusCode,body:result.body};
    if(options.cancelled)assert.ok([401,409].includes(result.statusCode),result.body);else assert.equal(result.statusCode,200,result.body);yield {type:'turn_done'};return;
   }
   yield {type:'text',delta:'FORBIDDEN WORK LOG'};
  if(options.ordinaryWork)yield* mapCodexAppServerNotification({method:'item/started',params:{item:{type:'webSearch',id:'ordinary',query:'PRIVATE NATIVE PAYLOAD'}}},dir);
  yield* mapCodexAppServerNotification({method:'item/started',params:{item:{type:'dynamicToolCall',id:'voice-authorize',tool:'ponderosa_voice_reply',arguments:{}}}},dir);
  const fence=coord.latestAcknowledgedSteeringInjection(coord.activeAgentRun(agent.id).id);
  const authorization=await createProviderDynamicToolHandler(app,[PONDEROSA_VOICE_REPLY_TOOL],opts.environment.PONDEROSA_AGENT_MESSAGE_TOKEN)({id:'voice-rpc',operationId:'voice-authorize',name:'ponderosa_voice_reply',arguments:fence?{steeringInjectionId:fence}:{}});
  assert.deepEqual(JSON.parse(authorization.text),{...JSON.parse(armed.body),...(authorization.success?{}:{statusCode:armed.statusCode})},'actual provider tool route receipt, including normalized failure status');
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
 }catch(error){console.log("VOICE FIXTURE ERROR",error.stack);throw error;}finally{completion();}};
 const adapter={id:'fixture',displayName:'Inert',trustedSystemPromptChannel:'developer',supportsVoiceReplyStream:!options.unsupported,listModels:()=>[],listEfforts:()=>[],seed:opts=>run(opts,true),continue:opts=>run(opts,false)};
 try{
 // This inert voice fixture exercises voice authority, not the live CI
 // host's pressure. Admission holds/recovery are tested with explicit samples.
 app=createServer({resourceAdmissionObservation:{sample:async()=>({availableBytes:8*1024**3,memoryFullPercent:0,ioFullPercent:0,source:'linux_host'})},dataDir:path.join(dir,'data'),store,authToken:token,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,...(options.memory?{localMemory:{chromaUrl:await isolatedChroma(),collectionPrefix:'voice_'+branch.id.replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR ?? path.join(tmpdir(),'unconfigured-memory-models'),stateDirectory:path.join(dir,'memory-policy'),provision:true}}:{}),communicationV3:{pollMs:10}});
 app.addHook('onSend',async(request,reply,payload)=>{if(request.url==='/api/agent-voice-reply')armed={statusCode:reply.statusCode,body:typeof payload==='string'?payload:JSON.stringify(payload)};return payload;});
 const memoryUrl='/api/agent-local-memory';
 if(options.publicationAckRace){
  let changed=false;
  app.addHook('onSend',async(request,reply,payload)=>{
   if(request.url==='/api/agent-messages'&&reply.statusCode===200&&!changed){
    changed=true;
    const update=await app.inject({method:'POST',url:memoryUrl,headers:memoryHeaders,payload:{operation:'update',chunk_id:memoryRecord.chunk_id,destination:'chat',text:'Synthetic voice input NEW after commit'}});
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
    const update=await app.inject({method:'POST',url:memoryUrl,headers:memoryHeaders,payload:{operation:'update',chunk_id:memoryRecord.chunk_id,destination:'chat',text:'Synthetic voice input NEW at publication'}});
    assert.equal(update.statusCode,200,update.body);
   }
  });
 }
 await app.ready();
 const bindChat=PonderosaMemory.prototype.bindChat;
 if(options.previewFault)PonderosaMemory.prototype.bindChat=function(...args){
  const binding=bindChat.apply(this,args),call=binding.call.bind(binding);
  binding.call=async(...args)=>{
   const result=await call(...args);
   if(result.candidate_update_targets?.length){
    const db=localMemoryFor(app).core.database,get=db.get;
    db.get=async(...args)=>{db.get=get;if(options.previewFault==='missing')return null;if(options.previewFault==='error')throw Error('Synthetic preview lookup failure');const row=await get.apply(db,args);return {...row,text:'Synthetic changed preview'};};
   }
   return result;
  };return binding;
 };
 if(options.global){
  const saved=await app.inject({method:'POST',url:'/api/branches/engine/local-memory/global',headers,payload:{operation:'save',text:'Synthetic voice input GLOBAL OLD',destination:'global'}});assert.equal(saved.statusCode,200,saved.body);globalRecord=saved.json().structuredContent.result;
  const grant=await app.inject({method:'PUT',url:'/api/branches/engine/local-memory/grants/'+chat.id,headers,payload:{readGlobal:true,expectedRevision:0}});assert.equal(grant.statusCode,200,grant.body);
 }
 if(options.operatorRead){
  const read=await app.inject({method:'POST',url:'/api/branches/engine/local-memory/global',headers,payload:{operation:'get',chunk_id:globalRecord.chunk_id,source:'global'}});
  assert.equal(read.statusCode,200,read.body);assert.equal(read.json().structuredContent.result.found,true);
 }
 if(options.restricted)new CapabilityPolicyStore(store.sqlite).put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead]});
 if(options.exposureFull)for(let i=0;i<128;i++)localMemoryFor(app).speech.set('occupied-'+i,{authority:{actor:{id:'occupied-'+i},runId:'occupied-'+i},refs:new Map(),invalid:false,started:false,expires:Date.now()+3600000});
 const input={text:'Synthetic voice input' ,idempotencyKey:'turn',recipients:[{agentId:agent.id}],activeRunDelivery:'queue',...(!options.ordinary?{voiceReply:true}:{})};
 const sendUrl=`/api/branches/engine/conversations/${chat.id}/direct-messages`;
 const sent=await app.inject({method:'POST',url:sendUrl,headers,payload:input});assert.equal(sent.statusCode,200,sent.body);
 const messageId=sent.json().message.communicationEventId;
 await boundedWait(()=>options.noVoiceTool?reached:armed,'provider ready');
 await boundedWait(()=>options.unsupported||options.ordinary||reached,'candidate processed');
 const url=`/api/branches/engine/conversations/${chat.id}/voice-replies/${messageId}/${agent.id}`;
 await runCheck({app,store,coord,agent,chat,project,headers,messageId,url,release,done,installation,get armed(){return armed;},get reauthorization(){return reauthorization;},get fallbackResult(){return fallbackResult;},get modes(){return modes;},get starts(){return starts;},memoryRecord,memoryUrl,memoryHeaders,submitted});
 }finally{PonderosaMemory.prototype.bindChat=originalBindChat;release();if(app){if(starts)await done;app.prepareForShutdown();await app.close();assert.equal(app.server.listening,false);console.log('OWN SERVER CLOSED');}store.close();await rm(dir,{recursive:true,force:true});
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
 const cancel=f.app.inject({method:'POST',url,headers:f.headers,payload:body});
 await boundedWait(()=>f.coord.isSchedulerRunCancelled(run.id),"canonical cancellation fence");
 f.release();const result=await cancel;assert.equal(result.statusCode,200,result.body);await f.done;
 assert.equal(f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent').length,0);
 const events=f.store.readEvents(f.agent.id).filter(x=>x.event.type==='voice_reply');assert.ok(events.every(x=>!x.event.reply.text.includes('Second phrase')));
}));
for(const options of [{unsupported:true},{unsupported:true,memory:true},{ordinary:true},{unknown:true},{overflow:true}])test(`canonical fallback ${JSON.stringify(options)}`,async()=>fixture(options,async f=>{
 assert.equal(f.armed.statusCode,options.unknown||options.overflow?200:409,f.armed.body);
 if(options.overflow){const status=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.equal(status.reply.state,'failed');assert.ok(status.reply.text.length<=10000);}
 if(options.unknown){const status=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.equal(status.reply.text,'');}
 f.release();await f.done;await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'fallback completed');
 const replies=f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent');assert.equal(replies.length,1);assert.equal(f.starts,1);
  if(options.memory)assert.equal((await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json().memoryExposure.state,'valid');
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
 const changed=await f.app.inject({method:'POST',url:f.memoryUrl,headers:f.memoryHeaders,payload:{operation,chunk_id:record.chunk_id,destination:'chat',...(operation==='update'?{text:'Synthetic voice input now remembers the NEW value'}:{})}});
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
 assert.equal(selected.length,0,'private.6 is explicit tool memory; no automatic recall is synthesized');
 assert.ok(!successor.exactPrompt.includes('Synthetic voice input remembers the OLD value'),'fresh turn never silently retains a memory packet');
 console.log('MEMORY STREAM ORACLE',JSON.stringify({operation,runId:early.runId,failedSequence:failure.seq,originalCanonicalReplies:original.length}));
}));

for(const mode of ['policy','grant'])test(`memory ${mode} invalidates the paused stream without another provider chunk`,async()=>fixture({memory:true,global:mode==='grant'},async f=>{
 const early=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.equal(early.reply.state,'streaming');
 if(mode==='grant'){
  const revoke=await f.app.inject({method:'PUT',url:'/api/branches/engine/local-memory/grants/'+f.chat.id,headers:f.headers,payload:{readGlobal:false,expectedRevision:1}});assert.equal(revoke.statusCode,200,revoke.body);
 }
 if(mode==='policy')new CapabilityPolicyStore(f.store.sqlite).put({scopeKind:'agent',scopeId:f.agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead]});
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

async function completeFallback(f){
 f.release();await f.done;await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'fallback Run released');
 const replies=f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent');
 assert.equal(replies.length,1);assert.equal(replies[0].payload.communication.text,'Canonical fallback.');assert.equal(f.starts,1);
 return (await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();
}
for(const extra of [{},{readMemory:false},{unsupported:false},{readMemory:false,restricted:true},{global:true,operatorRead:true}])
 test(`non-streaming voice fallback retains valid exposure without any voice tool ${JSON.stringify(extra)}`,async()=>fixture({memory:true,unsupported:true,noVoiceTool:true,...extra},async f=>{
  const before=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.notEqual(before.memoryExposure.state,'invalid');assert.equal(before.reply,undefined);
  const after=await completeFallback(f);assert.equal(after.memoryExposure.state,'valid');assert.equal(after.reply,undefined);
  assert.throws(()=>localMemoryFor(f.app).beginSpeech(f.memoryHeaders.authorization.slice(7)),/Invalid speech Run/,'released capability cannot rearm');
 }));
for(const extra of [{ordinary:true},{exposureFull:true}])
 test(`unarmed fallback keeps canonical text and fails audio closed ${JSON.stringify(extra)}`,async()=>fixture({memory:true,readMemory:false,unsupported:true,noVoiceTool:true,...extra},async f=>{
  const after=await completeFallback(f);assert.equal(after.memoryExposure.state,'invalid');
 }));
for(const operation of ['update','forget'])
 test(`non-streaming fallback suppresses speech after memory ${operation} but preserves canonical text`,async()=>fixture({memory:true,unsupported:true,noVoiceTool:true},async f=>{
  const changed=await f.app.inject({method:'POST',url:f.memoryUrl,headers:f.memoryHeaders,payload:{operation,chunk_id:f.memoryRecord.chunk_id,destination:'chat',...(operation==='update'?{text:'Corrected memory'}:{})}});assert.equal(changed.statusCode,200,changed.body);
  const after=await completeFallback(f);assert.equal(after.memoryExposure.state,'invalid');
 }));
test('completed fallback with missing ephemeral exposure cannot be reconstructed',async()=>fixture({memory:true,unsupported:true,noVoiceTool:true,readMemory:false},async f=>{
 const after=await completeFallback(f);assert.equal(after.memoryExposure.state,'valid');
 // Drop ephemeral exposure as a new host process would; GET must not rebuild it.
 localMemoryFor(f.app).speech.clear();
 const reopened=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.equal(reopened.memoryExposure.state,'invalid');
}));

for(const mode of ['policy','grant','reset','expiry','fence','lease'])
 test(`fallback ${mode} change cannot reauthorize stale speech`,async()=>fixture({memory:true,unsupported:true,noVoiceTool:true,global:mode==='grant'},async f=>{
  const memory=localMemoryFor(f.app),run=f.coord.activeAgentRun(f.agent.id),token=f.memoryHeaders.authorization.slice(7);
  const policy=new CapabilityPolicyStore(f.store.sqlite);
  const grant=async(readGlobal,expectedRevision)=>{const result=await f.app.inject({method:'PUT',url:'/api/branches/engine/local-memory/grants/'+f.chat.id,headers:f.headers,payload:{readGlobal,expectedRevision}});assert.equal(result.statusCode,200,result.body);};
  if(mode==='policy')policy.put({scopeKind:'agent',scopeId:f.agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead]});
  if(mode==='grant')await grant(false,1);
  if(mode==='reset')f.store.appendEvent(f.agent.id,{type:'session_reset'});
  if(mode==='expiry')memory.speech.get(run.id).expires=Date.now()-1;
  if(mode==='fence')f.store.sqlite.prepare('UPDATE scheduler_runs SET fencing_token=fencing_token+1 WHERE id=?').run(run.id);
  if(mode==='lease')f.store.sqlite.prepare('UPDATE scheduler_runs SET lease_expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',run.id);
  const invalid=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.equal(invalid.memoryExposure.state,'invalid');
  if(mode==='policy')policy.put({scopeKind:'agent',scopeId:f.agent.id,expectedRevision:1,restrictedCapabilityIds:[]});
  if(mode==='grant')await grant(true,2);
  if(mode==='fence')f.store.sqlite.prepare('UPDATE scheduler_runs SET fencing_token=? WHERE id=?').run(run.fencingToken,run.id);
  if(mode==='lease')f.store.sqlite.prepare('UPDATE scheduler_runs SET lease_expires_at=? WHERE id=?').run(run.leaseExpiresAt,run.id);
  assert.throws(()=>memory.beginSpeech(token),/Memory changed|Invalid speech Run/);
  const after=await completeFallback(f);assert.equal(after.memoryExposure.state,'invalid');
 }));

test('cancelled fallback rejects retained provider publication and cannot rearm audio',async()=>fixture({memory:true,readMemory:false,unsupported:true,noVoiceTool:true,cancelled:true},async f=>{
 const run=f.coord.activeAgentRun(f.agent.id);
 const cancellation=f.app.inject({method:'POST',url:`/api/branches/engine/agents/${f.agent.id}/cancel`,headers:f.headers,payload:{targetRunId:run.id,idempotencyKey:'cancel-fallback'}});
 await boundedWait(()=>f.coord.isSchedulerRunCancelled(run.id),'fallback cancellation fence');
 assert.throws(()=>localMemoryFor(f.app).beginSpeech(f.memoryHeaders.authorization.slice(7)),/Invalid speech Run/);
 f.release();assert.equal((await cancellation).statusCode,200);await f.done;
 assert.ok(f.fallbackResult,'retained callback reached the messaging route');assert.ok([401,409].includes(f.fallbackResult.statusCode),f.fallbackResult.body);
 assert.equal(f.coord.runtimeCommunications(f.project.id).filter(x=>x.payload.communication?.sender.kind==='agent').length,0);
 const status=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.notEqual(status.memoryExposure.state,'valid');assert.equal(await localMemoryFor(f.app).speechStatus(run.id),false);
}));
test('reopened host never rebuilds completed fallback speech authorization',async()=>fixture({memory:true,readMemory:false,unsupported:true,noVoiceTool:true},async f=>{
 const after=await completeFallback(f);assert.equal(after.memoryExposure.state,'valid');
 const opts=localMemoryFor(f.app).ports.opts;
 f.app.prepareForShutdown();await f.app.close();
 // Startup replaces opts.dataDir with a process-local descriptor; restart uses the owned physical root.
 const config={dataDir:path.join(f.project.hostPath,'data'),authToken:f.headers.authorization.slice(7),engines:[],logger:false,communicationV3:{pollMs:10},localMemory:{...opts.localMemory,provision:false}};
 const code=`
 import assert from 'node:assert/strict';
 import {createServer} from ${JSON.stringify(new URL('../../apps/server/dist/app.js',import.meta.url).href)};
 import {localMemoryFor} from ${JSON.stringify(new URL('../../apps/server/dist/local-memory.js',import.meta.url).href)};
 const adapter={id:'fixture',displayName:'Inert restart',trustedSystemPromptChannel:'developer',listModels:()=>[],listEfforts:()=>[],seed:async function*(){yield {type:'turn_done'};}};
 const app=createServer({...${JSON.stringify(config)},engines:[{adapter,authStatus:async()=>({authenticated:true})}]});
 try{
  await app.ready();const memory=localMemoryFor(app);
  assert.equal(memory.ports.store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(${JSON.stringify(after.memoryExposure.runId)}).status,'completed');
  assert.equal(await memory.speechStatus(${JSON.stringify(after.memoryExposure.runId)}),false);
  const response=await app.inject({method:'GET',url:${JSON.stringify(f.url)},headers:${JSON.stringify(f.headers)}});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().memoryExposure.state,'invalid');
  console.log('Fresh host rejects historical fallback speech through the service and authenticated route');
 }finally{app.prepareForShutdown();await app.close();}`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:20000});
 assert.ok(!child.error,child.error?.message);assert.equal(child.status,0,child.stdout+child.stderr);

}));

test('memory exposure capacity recovers for a fresh Run without rearming the missed Run',async()=>fixture({memory:true,exposureFull:true,unsupported:true,noVoiceTool:true},async f=>{
 const memory=localMemoryFor(f.app),token=f.memoryHeaders.authorization.slice(7);
 assert.throws(()=>memory.beginSpeech(token),/exposure|capacity/i);
 for(const entry of memory.speech.values())entry.expires=Date.now()-1;
 assert.throws(()=>memory.beginSpeech(token),/exposure|capacity/i,'the same live Run remains denied after expiry');
 const first=await completeFallback(f);assert.equal(first.memoryExposure.state,'invalid');
 const sent=await f.app.inject({method:'POST',url:'/api/branches/engine/conversations/'+f.chat.id+'/direct-messages',headers:f.headers,payload:{text:'Fresh voice Run after capacity recovery',idempotencyKey:'after-exposure-expiry',recipients:[{agentId:f.agent.id}],activeRunDelivery:'queue',voiceReply:true}});
 assert.equal(sent.statusCode,200,sent.body);
 await boundedWait(()=>f.starts===2&&f.coord.activeAgentRun(f.agent.id)===undefined,'fresh fallback completed');
 const messageId=sent.json().message.communicationEventId;
 const next=(await f.app.inject({method:'GET',url:'/api/branches/engine/conversations/'+f.chat.id+'/voice-replies/'+messageId+'/'+f.agent.id,headers:f.headers})).json();
 assert.equal(next.memoryExposure.state,'valid','a fresh canonical Run recovers without restarting the host');
 assert.equal((await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json().memoryExposure.state,'invalid','the missed Run stays invalid');
}));
test('pruning an expired live exposure cannot recreate speech authority without its source refs',async()=>fixture({memory:true,unsupported:true,noVoiceTool:true},async f=>{
 const memory=localMemoryFor(f.app),run=f.coord.activeAgentRun(f.agent.id),entry=memory.speech.get(run.id);
 entry.expires=Date.now()-1;
 assert.throws(()=>memory.speechEntry({...entry.authority,runId:'unowned-expiry-probe'}),/Speech Run authority changed/);
 assert.throws(()=>memory.beginSpeech(f.memoryHeaders.authorization.slice(7)),/exposure|capacity/i);
 assert.equal((await completeFallback(f)).memoryExposure.state,'invalid');
}));
for(const writePreview of ['save','update'])for(const mutate of [false,true])
 test('write '+writePreview+' previews retain speech freshness '+(mutate?'after source mutation':'without mutation'),async()=>fixture({memory:true,unsupported:true,noVoiceTool:true,writePreview},async f=>{
  const before=(await f.app.inject({method:'GET',url:f.url,headers:f.headers})).json();assert.notEqual(before.memoryExposure.state,'invalid');
  if(mutate){const changed=await f.app.inject({method:'POST',url:f.memoryUrl,headers:f.memoryHeaders,payload:{operation:'forget',chunk_id:f.memoryRecord.chunk_id,destination:'chat'}});assert.equal(changed.statusCode,200,changed.body);}
  assert.equal((await completeFallback(f)).memoryExposure.state,mutate?'invalid':'valid');
 }));

for(const previewFault of ['missing','mismatch','error'])
 test('committed save preserves its response and denies speech on '+previewFault+' preview verification',async()=>fixture({memory:true,unsupported:true,noVoiceTool:true,writePreview:'save',previewFault},async f=>{
  assert.ok(f.memoryRecord.chunk_id,'the original memory write succeeded');
  assert.equal((await completeFallback(f)).memoryExposure.state,'invalid');
 }));


for(const {memory,voice,streaming}of [{memory:true,voice:true,streaming:true},{memory:true,voice:true,streaming:false},{memory:true,voice:false,streaming:false},{memory:false,voice:true,streaming:false}])
test('retained-context boundary '+JSON.stringify({memory,voice,streaming}),()=>fixture({memory,readMemory:memory,global:memory,ordinary:true,unsupported:!streaming,noVoiceTool:true,retainedMemory:true},async f=>{
 f.release();await f.done;await boundedWait(()=>f.coord.activeAgentRun(f.agent.id)===undefined,'first ordinary memory Run released');
 if(memory){const changed=await f.app.inject({method:'PUT',url:'/api/branches/engine/local-memory/grants/'+f.chat.id,headers:f.headers,payload:{readGlobal:false,expectedRevision:1}});assert.equal(changed.statusCode,200,changed.body);}
 const second=await f.app.inject({method:'POST',url:'/api/branches/engine/conversations/'+f.chat.id+'/direct-messages',headers:f.headers,payload:{text:'What do you remember?',idempotencyKey:'retained-voice',recipients:[{agentId:f.agent.id}],activeRunDelivery:'queue',...(voice?{voiceReply:true}:{})}});
 assert.equal(second.statusCode,200,second.body);await boundedWait(()=>f.starts===2&&f.coord.activeAgentRun(f.agent.id)===undefined,'second Run released');
 if(voice){
  const messageId=second.json().message.communicationEventId,status=await f.app.inject({method:'GET',url:'/api/branches/engine/conversations/'+f.chat.id+'/voice-replies/'+messageId+'/'+f.agent.id,headers:f.headers});
  assert.equal(status.statusCode,200,status.body);assert.equal(status.json().memoryExposure.state,memory?'valid':'disabled');
 }
 const fresh=memory&&voice;assert.deepEqual(f.modes,fresh?['seed','seed']:['seed','continue'],'opaque retained memory cannot authorize a fresh voice exposure');
 assert.equal(f.submitted[1].sourceManifest.providerSessionDisposition,fresh?'fresh_task':'continued_session');
}));
