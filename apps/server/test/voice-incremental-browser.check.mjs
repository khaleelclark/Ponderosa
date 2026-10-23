// Inert model, real canonical host + authenticated Branch SSE + shared call UI.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,readdir,mkdir,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {createRequire} from 'node:module';import {randomBytes,createHash} from 'node:crypto';import {performance} from 'node:perf_hooks';
import {execFileSync,spawn} from 'node:child_process';import net from 'node:net';import {once} from 'node:events';
import {AgentStore,CoordinationV3Store,BranchStore} from '../../../packages/agents/dist/index.js';
import {CodexResponseText,mapCodexAppServerNotification} from '../../../packages/engines/dist/index.js';
import {PONDEROSA_VOICE_REPLY_TOOL} from '@ponderosa/core';
import {createServer} from '../dist/app.js';import {createProviderDynamicToolHandler} from '../dist/routes/provider-dynamic-tool-handler.js';
const root=fileURLToPath(new URL('../../..',import.meta.url)),require=createRequire(root+'/apps/web/package.json');
const {createRsbuild}=await import(pathToFileURL(require.resolve('@rsbuild/core'))),{pluginReact}=await import(pathToFileURL(require.resolve('@rsbuild/plugin-react'))),{chromium}=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const area=await mkdtemp(path.join(process.env.VOICE_FIXTURE_DATA_ROOT??tmpdir(),'incremental-browser-'));console.log('OWN ROOT',area);
let browser,chroma;const reports=[];
async function memoryBackend(){
 if(chroma)return chroma.url;const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const child=spawn(process.env.PONDEROSA_TEST_CHROMA_BIN ?? 'chroma',['run','--path',area+'/chroma','--host','127.0.0.1','--port',String(port)],{stdio:'ignore',env:{...process.env,ANONYMIZED_TELEMETRY:'False'}});chroma={child,url:'http://127.0.0.1:'+port,exit:once(child,'exit')};
 for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error('Owned Chroma exited');try{if((await fetch(chroma.url+'/api/v2/heartbeat')).ok)return chroma.url;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Owned Chroma startup failed');
}

try{
 const build=await createRsbuild({cwd:root+'/apps/web',rsbuildConfig:{plugins:[pluginReact()],source:{transformImport:[],entry:{index:root+'/apps/web/test/voice-incremental-browser-entry.tsx'}},output:{distPath:{root:area+'/web'}},logLevel:'error'}});await build.build();
 if(process.env.VOICE_TIMING_REPORT){
  const stem=process.env.VOICE_TIMING_REPORT.replace(/\.json$/,'');
  const files=execFileSync('git',['ls-files'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(p=>/^(packages\/(core|agents|engines)\/src|apps\/server\/src|apps\/web\/src|apps\/web\/test|apps\/server\/test)/.test(p));
  const bindings=[];for(const file of files){const bytes=await readFile(root+'/'+file);bindings.push({path:file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
  const assets=[];const walk=async(dir)=>{for(const item of await readdir(dir,{withFileTypes:true})){const full=dir+'/'+item.name;if(item.isDirectory())await walk(full);else if(item.isFile()){const bytes=await readFile(full);assets.push({path:full.slice((area+'/web/').length),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}}};await walk(area+'/web');
  const runtimeBuilds=[];for(const prefix of ['apps/server/dist','packages/core/dist','packages/agents/dist','packages/engines/dist']){
   const scan=async(dir)=>{for(const item of await readdir(dir,{withFileTypes:true})){const full=dir+'/'+item.name;if(item.isDirectory())await scan(full);else if(item.isFile()&&/\.js$/.test(item.name)){const bytes=await readFile(full);runtimeBuilds.push({path:full.slice(root.length+1),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}}};await scan(root+'/'+prefix);
  }
  const patch=execFileSync('git',['diff','HEAD','--binary'],{cwd:root,maxBuffer:32*1024*1024});await writeFile(stem+'-tested.patch',patch);
  const changed=execFileSync('git',['diff','HEAD','--name-only','--diff-filter=ACMR'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
  for(const file of changed){await mkdir(path.dirname(stem+'-source/'+file),{recursive:true});await copyFile(root+'/'+file,stem+'-source/'+file);}
  await writeFile(stem+'-bindings.json',JSON.stringify({capturedBeforeFixtureCleanup:true,head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),bindings,assets,runtimeBuilds},null,2)+'\n');
 }
 browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH,chromiumSandbox:true});
 const scenarios=process.env.VOICE_LIFETIME_ONLY?['post-final-forget','post-final-update','fallback-forget','post-final-reset','post-final-revoke','missed-sse-regrant','guard-denied','delayed-valid-stop','delayed-valid-reset','late-valid-memory','post-final-native-error','post-final-external-stop']:['delayed','memory-update'];
 const selected=process.env.VOICE_SCENARIOS?.split(',')??scenarios;assert.ok(selected.every(s=>scenarios.includes(s)),'only named scenarios may be selected');
 for(const surface of ['branches','standalone'])for(const scenario of selected){
  const dir=area+'/'+surface+'-'+scenario;const store=new AgentStore(dir+'/data'),coord=new CoordinationV3Store(store.sqlite),token=randomBytes(32).toString('hex'),headers={authorization:'Bearer '+token};
  const project=store.createProject({label:'Inert incremental '+surface,hostPath:area,defaultEngine:'fixture'}),chat=store.createConversation(project.id,{title:'Inert private call'}),agent=store.createAgent(project.id,{engine:'fixture',conversationId:chat.id,title:'Fixture Voice'});
  const branch=new BranchStore(store.sqlite,coord).create('Inert voice Branch','fixture');store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(branch.id,chat.id);
  const append=store.appendEvent.bind(store);
  store.appendEvent=(...args)=>{try{return append(...args);}catch(error){console.log('APPEND FAILURE',args[1]?.type,error.stack);throw error;}};
  const host=[];let release,app,finished,memory;const hold=new Promise(r=>release=r),done=new Promise(r=>finished=r);
  const finalText='A short sentence. Café 😀 你好. Final tail.';
  const run=async function*(opts){try{
   host.push({stage:'adapter_submission',at:performance.now()});
   if(scenario!=='delayed'){
    const read=await app.inject({method:'POST',url:'/api/agent-local-memory',headers:{authorization:'Bearer '+opts.environment.PONDEROSA_AGENT_MESSAGE_TOKEN},payload:{operation:'get',chunk_id:memory.chunk_id,source:'global'}});
    assert.equal(read.statusCode,200,read.body);assert.equal(read.json().structuredContent.result.found,true);
   }
   if(scenario==='post-final-control')yield {type:'session',sessionId:'inert-accepted-session'};
   yield {type:'text',delta:'FORBIDDEN WORK LOG'};yield {type:'reasoning',delta:'FORBIDDEN REASONING'};
   const name='ponderosa_voice_reply',id='authorize';
   const fence=coord.latestAcknowledgedSteeringInjection(coord.activeAgentRun(agent.id).id);
   // A non-streaming engine need not call the optional voice tool at all.
   let auth={success:false};
   if(scenario!=='fallback-forget'){
    yield {type:'tool_call',id,name,input:{}};
    auth=await createProviderDynamicToolHandler(app,[PONDEROSA_VOICE_REPLY_TOOL],opts.environment.PONDEROSA_AGENT_MESSAGE_TOKEN)({id:'rpc',operationId:id,name,arguments:fence?{steeringInjectionId:fence}:{} });
   }
   if(!auth.success){
    if(scenario==='fallback-forget')await hold;
    const fallback=await app.inject({method:'POST',url:'/api/agent-messages',headers:{authorization:`Bearer ${opts.environment.PONDEROSA_AGENT_MESSAGE_TOKEN}`},payload:{text:scenario==='fallback-forget'?finalText:'Fresh context acknowledged.',...(fence?{steeringInjectionId:fence}:{})}});assert.equal(fallback.statusCode,200,fallback.body);yield {type:'turn_done'};return;
   }
   yield* mapCodexAppServerNotification({method:'item/completed',params:{item:{type:'dynamicToolCall',id,tool:name,success:true,contentItems:[{type:'inputText',text:auth.text}]}}},area);
   const mapper=new CodexResponseText('thread');mapper.map('turn/started',{threadId:'thread',turn:{id:'provider-turn'}});
   const item={type:'agentMessage',id:'item',phase:'final_answer',text:''};
   yield* mapper.map('item/started',{threadId:'thread',turnId:'provider-turn',item});
   for(const delta of ['A short',' sentence.']){await new Promise(r=>setTimeout(r,60));host.push({stage:'model_delta',at:performance.now(),text:delta});yield* mapper.map('item/agentMessage/delta',{threadId:'thread',turnId:'provider-turn',itemId:'item',delta});}
   await hold;
   for(const delta of [' Café \ud83d','\ude00 你好. ','Final tail.'])yield* mapper.map('item/agentMessage/delta',{threadId:'thread',turnId:'provider-turn',itemId:'item',delta});
   yield* mapper.map('item/completed',{threadId:'thread',turnId:'provider-turn',item:{...item,text:finalText}});
   host.push({stage:'model_final_completion',at:performance.now()});yield {type:'turn_done'};
  }finally{finished();}};
  const adapter={id:'fixture',displayName:'Inert delayed chunks',trustedSystemPromptChannel:'developer',supportsVoiceReplyStream:scenario!=='fallback-forget',listModels:()=>[],listEfforts:()=>[],seed:run,continue:run};
  app=createServer({dataDir:dir+'/data',store,authToken:token,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,...(scenario!=='delayed'?{localMemory:{chromaUrl:await memoryBackend(),collectionPrefix:'browser_'+branch.id.replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR ?? path.join(tmpdir(),'unconfigured-memory-models'),stateDirectory:dir+'/memory-policy',provision:true}}:{}),communicationV3:{pollMs:10}});
  app.get('/fixture-context',async()=>({projectId:project.id,conversationId:chat.id,agents:[agent],selectedAgentId:agent.id,lockAgent:true}));
  for(const url of ['/','/branches/fixture'])app.get(url,async(_r,reply)=>reply.type('text/html').send(await readFile(area+'/web/index.html')));
  app.get('/static/*',async(request,reply)=>{const pathname=new URL(request.url,'http://localhost').pathname;assert.ok(!pathname.includes('..'));return reply.type(pathname.endsWith('.js')?'text/javascript':'text/css').send(await readFile(area+'/web'+pathname));});
  let page,unblockStatus;
  try{
   await app.listen({host:'127.0.0.1',port:0});const origin='http://127.0.0.1:'+app.server.address().port;
   const memoryUrl='/api/branches/engine/local-memory/global',grantUrl='/api/branches/engine/local-memory/grants/'+chat.id;
   if(scenario!=='delayed'){
    const grant=await app.inject({method:'PUT',url:grantUrl,headers,payload:{readGlobal:true,expectedRevision:0}});assert.equal(grant.statusCode,200,grant.body);
    const saved=await app.inject({method:'POST',url:memoryUrl,headers,payload:{operation:'save',text:'Synthetic voice input OLD',destination:'global'}});assert.equal(saved.statusCode,200,saved.body);memory=saved.json().structuredContent.result;
   }
   page=await browser.newPage({extraHTTPHeaders:headers});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
   await page.goto(origin+(surface==='branches'?'/branches/fixture':'/?surface=standalone'));
   await page.waitForFunction(()=>window.incrementalFixture);await page.getByRole('dialog').waitFor();
   if(scenario==='post-final-forget')for(const mode of ['stop','replacement'])assert.deepEqual(await page.evaluate(mode=>window.incrementalFixture.guardRace(mode),mode),{checks:1,queued:0},'serialized valid async guard after '+mode+' never starts old speech');
   await page.getByRole('button',{name:'Transcript & typing',exact:true}).click();
   await page.getByLabel('Your next turn').fill('Synthetic voice input');await page.getByRole('button',{name:'Send turn',exact:true}).click();
   if(process.env.VOICE_LIFETIME_ONLY){
    if(scenario!=='fallback-forget')await page.waitForFunction(()=>window.incrementalFixture.receipts.some(x=>x.stage==='onstart_mock'),null,{timeout:7000});
    release();await done;
    const end=Date.now()+7000;while(coord.activeAgentRun(agent.id)&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(coord.activeAgentRun(agent.id),undefined);
    await page.evaluate(()=>window.incrementalFixture.wake());
    await page.getByLabel('Call transcript').getByText(finalText,{exact:false}).first().waitFor({timeout:7000});
    await page.waitForFunction(()=>window.incrementalFixture.receipts.some(x=>x.stage==='onstart_mock'));
    await page.evaluate(()=>{window.saved=window.incrementalFixture.saveLate();});
    const before=await page.evaluate(()=>window.incrementalFixture.receipts.filter(x=>x.stage==='onstart_mock').map(x=>x.text));
    assert.equal(before.length,1,'first utterance remains current while model/canonical are complete');
    assert.equal(coord.runtimeCommunications(project.id).filter(x=>x.payload.communication?.sender.kind==='agent').length,1);
    if(['post-final-native-error','post-final-external-stop'].includes(scenario)){
     const observed=await page.evaluate(()=>window.incrementalFixture.observation());
     assert.deepEqual(observed,{streams:1,exposureTimers:1,conversationObservers:1},'exact-turn observation remains active through current/queued speech');
     await page.evaluate(scenario=>scenario==='post-final-native-error'?window.incrementalFixture.nativeError():window.incrementalFixture.externalStop(),scenario);
     await page.waitForFunction(()=>{const x=window.incrementalFixture.observation();return !x.streams&&!x.exposureTimers&&!x.conversationObservers;});
     assert.equal(await page.evaluate(()=>window.incrementalFixture.handlers()),0,'failure/stop clears native handlers');
     await page.evaluate(()=>{window.saved.start?.();window.saved.end?.();window.incrementalFixture.reconnect();window.incrementalFixture.wake();});
     await page.waitForTimeout(600);
     assert.deepEqual(await page.evaluate(()=>window.incrementalFixture.receipts.filter(x=>x.stage==='onstart_mock').map(x=>x.text)),before,'saved callbacks/status/canonical reads cannot rearm stopped automatic queue');
     assert.deepEqual(await page.evaluate(()=>window.incrementalFixture.observation()),{streams:0,exposureTimers:0,conversationObservers:0});
     assert.equal(coord.runtimeCommunications(project.id).filter(x=>x.payload.communication?.sender.kind==='agent').length,1,'canonical history survives native queue failure');
     // Deliberate replay is independent of the fenced automatic queue.
     await page.getByRole('button',{name:'Play reply',exact:true}).click();
     await page.waitForFunction(()=>window.incrementalFixture.receipts.filter(x=>x.stage==='onstart_mock').length===2);
     assert.equal(await page.evaluate(()=>window.incrementalFixture.receipts.filter(x=>x.stage==='onstart_mock').at(-1).text),finalText);
     await page.evaluate(()=>window.incrementalFixture.complete());
     await page.waitForFunction(()=>window.incrementalFixture.handlers()===0);
     await page.getByLabel('Your next turn').fill('Synthetic deliberate turn after native stop');await page.getByRole('button',{name:'Send turn',exact:true}).click();
     await page.waitForFunction(()=>window.incrementalFixture.receipts.filter(x=>x.stage==='onstart_mock').length>2);
     const nextEnd=Date.now()+7000;while(coord.activeAgentRun(agent.id)&&Date.now()<nextEnd)await new Promise(r=>setTimeout(r,10));assert.equal(coord.activeAgentRun(agent.id),undefined);
     await page.evaluate(()=>window.incrementalFixture.wake());
     await page.waitForFunction(()=>document.querySelector('[aria-label="Call transcript"]')?.textContent.split('A short sentence.').length===3);
     for(let n=0;n<4;n++){await page.evaluate(()=>window.incrementalFixture.complete());await page.waitForTimeout(100);}
     await page.waitForFunction(()=>{const x=window.incrementalFixture.observation();return !x.streams&&!x.exposureTimers&&!x.conversationObservers;});
     assert.equal(await page.evaluate(()=>window.incrementalFixture.handlers()),0);
     assert.equal(coord.runtimeCommunications(project.id).filter(x=>x.payload.communication?.sender.kind==='agent').length,2,'deliberate new turn publishes exactly one new canonical reply');
     assert.deepEqual(errors,[]);reports.push({surface,scenario,modelAndCanonicalCompletedBeforeNativeStop:true,observersReleased:true,lateCallbacksFenced:true,manualReplay:true,freshTurn:true,hostClock:host,browserClock:await page.evaluate(()=>window.incrementalFixture.receipts),errors});console.log('PASS LIFETIME',JSON.stringify(reports.at(-1)));await page.evaluate(()=>window.incrementalFixture.unmount());continue;
    }
    if(scenario==='post-final-control'){
     for(let n=0;n<3;n++){await page.evaluate(()=>window.incrementalFixture.complete());await page.waitForTimeout(100);}
     await page.waitForFunction(()=>window.incrementalFixture.liveStreams()===0);
     assert.equal(await page.evaluate(()=>window.incrementalFixture.handlers()),0);
     assert.equal((await page.evaluate(()=>window.incrementalFixture.receipts.filter(x=>x.stage==='onstart_mock').map(x=>x.text).join(' '))),finalText);
     const firstPacket=store.getProviderInput(coord.voiceReplyRunTiming(coord.runtimeCommunications(project.id).find(x=>x.payload.communication?.sender.kind==='user').id,agent.id).runId,true);
     const changed=await app.inject({method:'POST',url:memoryUrl,headers,payload:{operation:'forget',chunk_id:memory.chunk_id,destination:'global'}});assert.equal(changed.statusCode,200,changed.body);
     await page.getByLabel('Your next turn').fill('Synthetic fresh empty-memory turn');await page.getByRole('button',{name:'Send turn',exact:true}).click();
     await page.waitForFunction(()=>window.incrementalFixture.receipts.filter(x=>x.stage==='onstart_mock').length>3);
     const limit=Date.now()+7000;while(coord.activeAgentRun(agent.id)&&Date.now()<limit)await new Promise(r=>setTimeout(r,10));assert.equal(coord.activeAgentRun(agent.id),undefined);
     const packets=store.sqlite.prepare('SELECT source_manifest_json,provider_prompt FROM provider_inputs WHERE agent_id=? ORDER BY created_at').all(agent.id);assert.equal(packets.length,2);const fresh=JSON.parse(packets[1].source_manifest_json);
     assert.equal(fresh.sources.filter(s=>s.kind==='memory').length,0);assert.ok(!packets[1].provider_prompt.includes('Synthetic voice input OLD'));assert.ok(fresh.memorySessionResetSeq>firstPacket.sourceManifest.memorySessionResetSeq,'actual reseed captures the new epoch with fresh packet');
     await page.evaluate(()=>window.incrementalFixture.wake());for(let n=0;n<4;n++){await page.evaluate(()=>window.incrementalFixture.complete());await page.waitForTimeout(100);}await page.waitForFunction(()=>window.incrementalFixture.liveStreams()===0);
     assert.equal(await page.evaluate(()=>window.incrementalFixture.handlers()),0);assert.deepEqual(errors,[]);
     reports.push({surface,scenario,drainedOnce:true,observersReleased:true,freshEmptyManifest:true,reseedEpoch:fresh.memorySessionResetSeq,hostClock:host,browserClock:await page.evaluate(()=>window.incrementalFixture.receipts),errors});console.log('PASS LIFETIME',JSON.stringify(reports.at(-1)));await page.evaluate(()=>window.incrementalFixture.unmount());continue;
    }
    let releaseStatus;let held;const heldStatus=new Promise(r=>held=r),statusGate=new Promise(r=>releaseStatus=r);
    unblockStatus=releaseStatus;
    if(['delayed-valid-stop','delayed-valid-reset','late-valid-memory'].includes(scenario)){
     await page.route('**/voice-replies/**',async route=>{const response=await route.fetch();assert.equal((await response.json()).memoryExposure.state,'valid');held();await statusGate;await route.fulfill({response});});
     let timeout;try{await Promise.race([heldStatus,new Promise((_,reject)=>timeout=setTimeout(()=>reject(new Error('valid status hold timed out')),7000))]);}finally{clearTimeout(timeout);}await page.evaluate(()=>window.incrementalFixture.complete());
     if(scenario==='delayed-valid-stop')await page.getByRole('button',{name:'Stop speaking',exact:true}).click();
     if(scenario==='delayed-valid-reset')await page.evaluate(()=>window.dispatchEvent(new PopStateEvent('popstate')));
    }
    if(['missed-sse-regrant','guard-denied'].includes(scenario))await page.evaluate(()=>{window.incrementalFixture.dropHints();window.incrementalFixture.suppressPoll();});
    if(scenario==='post-final-reset'){
     const reset=store.appendEvent(agent.id,{type:'session_reset',reason:'explicit_compaction'});
     // Status recovery must detect durable reset even without a live event delivery.
    }else if(['post-final-revoke','missed-sse-regrant'].includes(scenario)){
     const revoked=await app.inject({method:'PUT',url:grantUrl,headers,payload:{readGlobal:false,expectedRevision:1}});assert.equal(revoked.statusCode,200,revoked.body);
     if(scenario==='missed-sse-regrant'){const regrant=await app.inject({method:'PUT',url:grantUrl,headers,payload:{readGlobal:true,expectedRevision:2}});assert.equal(regrant.statusCode,200,regrant.body);await page.evaluate(()=>window.incrementalFixture.complete());}
    }else if(scenario==='post-final-expiry'){
     store.sqlite.prepare("UPDATE memory_revisions SET expires_at='2000-01-01' WHERE memory_id=?").run(memory.memoryId);
    }else if(!['delayed-valid-stop','delayed-valid-reset'].includes(scenario)){
     const operation=scenario==='post-final-update'?'update':'forget';
     const changed=await app.inject({method:'POST',url:memoryUrl,headers,payload:{operation,chunk_id:memory.chunk_id,destination:'global',...(operation==='update'?{text:'Synthetic voice input NEW after final',destination:'global'}:{})}});assert.equal(changed.statusCode,200,changed.body);
    }
    if(scenario==='guard-denied')await page.evaluate(()=>window.incrementalFixture.complete());
    if(!['delayed-valid-stop','delayed-valid-reset'].includes(scenario))await page.getByRole('alert').filter({hasText:/Memory changed|context changed|session changed/i}).waitFor({timeout:7000});
    releaseStatus?.();
    assert.equal(await page.evaluate(()=>window.incrementalFixture.handlers()),0,'current and queued native handlers cleared after provider completion');
    await page.evaluate(()=>{window.saved.start?.();window.saved.end?.();window.incrementalFixture.reconnect();window.incrementalFixture.wake();});
    await page.waitForTimeout(150);
    assert.deepEqual(await page.evaluate(()=>window.incrementalFixture.receipts.filter(x=>x.stage==='onstart_mock').map(x=>x.text)),before,'late valid status/onset/end/reconnect/canonical callbacks never rearm');
    if(['missed-sse-regrant','guard-denied'].includes(scenario))assert.ok(await page.evaluate(()=>window.incrementalFixture.receipts.some(x=>x.stage==='exposure_guard_result'&&x.state==='invalid')),'queue guard revalidates the actual host status despite suppressed polling and no memory SSE hints');
    assert.equal(await page.evaluate(()=>window.incrementalFixture.liveStreams()),0,'observers close after invalidation or stop');
    assert.equal(coord.runtimeCommunications(project.id).filter(x=>x.payload.communication?.sender.kind==='agent').length,1,'historical canonical answer preserved');
    reports.push({surface,scenario,modelAndCanonicalCompletedBeforeMutation:true,hostClock:host,browserClock:await page.evaluate(()=>window.incrementalFixture.receipts),canonicalReplies:1,errors});assert.deepEqual(errors,[]);console.log('PASS LIFETIME',JSON.stringify(reports.at(-1)));
    await page.evaluate(()=>window.incrementalFixture.unmount());continue;
   }
   await page.waitForFunction(()=>window.incrementalFixture.receipts.some(x=>x.stage==='ui_text'),null,{timeout:10000});
   await page.waitForFunction(()=>window.incrementalFixture.receipts.some(x=>x.stage==='onstart_mock'),null,{timeout:7000});
   const early=await page.evaluate(()=>window.incrementalFixture.receipts);
   assert.deepEqual(early.filter(x=>x.stage==='onstart_mock').map(x=>x.text),['A short sentence.']);
   assert.equal(host.some(x=>x.stage==='model_final_completion'),false);
   assert.equal(coord.runtimeCommunications(project.id).filter(x=>x.payload.communication?.sender.kind==='agent').length,0);
   const snapshots=store.readEvents(agent.id).filter(x=>x.event.type==='voice_reply');const snapshot=snapshots.at(-1).event.reply;
   const opens=early.filter(x=>x.stage==='sse_open').length;
   await page.evaluate(()=>window.incrementalFixture.reconnect());
   await page.waitForFunction(n=>window.incrementalFixture.receipts.filter(x=>x.stage==='sse_open').length>n,opens);
   assert.deepEqual(await page.evaluate(()=>window.incrementalFixture.receipts.filter(x=>x.stage==='onstart_mock').map(x=>x.text)),['A short sentence.'],'actual SSE reconnect never repeats queued/started phrase');
   await page.evaluate(()=>{window.saved=window.incrementalFixture.saveLate();});
   if(scenario==='memory-update'){
    const changed=await app.inject({method:'POST',url:memoryUrl,headers,payload:{operation:'update',chunk_id:memory.chunk_id,text:'Synthetic voice input NEW',destination:'global'}});assert.equal(changed.statusCode,200,changed.body);
    await page.getByRole('alert').filter({hasText:/Memory (?:or session )?changed/}).waitFor({timeout:7000});
    assert.equal(await page.getByLabel('Streaming reply').count(),0);assert.equal(await page.evaluate(()=>window.incrementalFixture.handlers()),0);
    await page.evaluate(()=>{window.saved.start?.();window.saved.end?.();});
   }else await page.evaluate(()=>window.incrementalFixture.complete());
   release();await done;
   const end=Date.now()+7000;while(coord.activeAgentRun(agent.id)&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(coord.activeAgentRun(agent.id),undefined);
   const replies=coord.runtimeCommunications(project.id).filter(x=>x.payload.communication?.sender.kind==='agent'&&x.payload.communication.sender.executionId===snapshot.runId);
   await page.evaluate(()=>window.incrementalFixture.wake());
   if(scenario==='delayed'){
    assert.equal(replies.length,1);assert.equal(replies[0].payload.communication.text,finalText);
    await page.waitForFunction(()=>window.incrementalFixture.receipts.filter(x=>x.stage==='onstart_mock').length===2);await page.evaluate(()=>window.incrementalFixture.complete());
    // Speech may queue the Unicode sentence and final tail separately.
    await page.waitForFunction(()=>window.incrementalFixture.receipts.filter(x=>x.stage==='onstart_mock').map(x=>x.text).join(' ').includes('Final tail.'));await page.evaluate(()=>window.incrementalFixture.complete());
    const spoken=await page.evaluate(()=>window.incrementalFixture.receipts.filter(x=>x.stage==='onstart_mock').map(x=>x.text).join(' '));assert.equal(spoken,finalText);
   }else{assert.equal(replies.length,0);assert.deepEqual(await page.evaluate(()=>window.incrementalFixture.receipts.filter(x=>x.stage==='onstart_mock').map(x=>x.text)),['A short sentence.']);}
   const report={surface,scenario,earlyTextAndMockOnstartBeforeFinal:true,hostClock:host,browserClock:await page.evaluate(()=>window.incrementalFixture.receipts),timingText:await page.getByLabel('Call timing').innerText(),canonicalReplies:replies.length,errors};assert.deepEqual(errors,[]);reports.push(report);console.log('PASS INCREMENTAL',JSON.stringify(report));
   await page.evaluate(()=>window.incrementalFixture.unmount());assert.equal(await page.evaluate(()=>window.incrementalFixture.handlers()),0);
  }catch(error){console.log('PRIMARY FAILURE',error.stack);console.log('FAILURE BROWSER',JSON.stringify(await page?.evaluate(()=>({receipts:window.incrementalFixture?.receipts,alerts:[...document.querySelectorAll('[role=alert]')].map(x=>x.textContent)})).catch(()=>null)));throw error;}finally{unblockStatus?.();release();await page?.close();try{app.prepareForShutdown();await app.close();assert.equal(app.server.listening,false);}finally{store.close();console.log('OWN STORE CLOSED',surface,scenario);}}
 }
 if(process.env.VOICE_TIMING_REPORT)await writeFile(process.env.VOICE_TIMING_REPORT,JSON.stringify(reports,null,2)+'\n');
}finally{await browser?.close();if(chroma){chroma.child.kill('SIGTERM');await chroma.exit;}await rm(area,{recursive:true,force:true});console.log('RELEASED ROOT',area);}
