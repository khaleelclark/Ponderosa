import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBrowserService, BrowserServiceClient } from '../../apps/server/dist/browser-service.js';
import { BrowserSessionError } from '../../apps/server/dist/browser-security.js';
import { BrowserSessionManager } from '../../apps/server/dist/browser-session-manager.js';
import {BrowserObservationBuffer} from '../../apps/server/dist/browser-observation-buffer.js';
import {chatBrowserOwnerId} from '../../packages/core/dist/index.js';

test('check 4: native manual conflicts remain typed across the real broker/client and resume in the same session', { skip: process.platform === 'win32' ? 'Unix socket transport; native Windows transport needs qualification' : false }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pbr-'));
  const calls = []; let alive = true, manual = 'automation', revision = 0;
  const driver = {
    isAlive: () => alive, close: async () => { alive = false; },
    manualState: () => manual, controlRevision: () => revision,
    manualSocket: () => path.join(root, 'unused-display.sock'),
    viewport: () => ({ width: 1280, height: 720 }),
    pages: async () => ({ activePageId: 'page', pages: [{ pageId: 'page', url: 'about:blank', title: 'Fixture', active: true, isNew: false, closable: false }] }),
    capture: async () => { calls.push('capture'); return Buffer.from('fixture pixels'); },
    navigate: async () => { calls.push('navigate'); return { pageId: 'page', url: 'https://fixture.invalid', title: 'Fixture' }; },
    cancelPendingFileChooser: async () => {},
    pauseAutomation: async () => { manual = 'manual'; revision++; },
    resumeAutomation: async () => { manual = 'automation'; revision++; },
  };
  const socket = path.join(root, 'broker.sock'), broker = await startBrowserService(socket, root, async () => driver);
  let remote;
  t.after(async () => { if (remote?.isAlive()) await remote.close(); await broker.close(); assert.equal(alive, false); await rm(root, { recursive: true, force: true }); });
  const client = new BrowserServiceClient(socket); await client.claim();
  const sessionId = randomUUID();
  remote = await client.driver(sessionId, () => {}, { owner: { version: 1, kind: 'chat', conversationId: randomUUID() } });
  await remote.capture();
  await remote.pauseAutomation();
  const before = [...calls];
  for (const action of [() => remote.capture(), () => remote.navigate('https://fixture.invalid')]) {
    await assert.rejects(action, error => error instanceof BrowserSessionError && error.statusCode === 409 && error.code === 'browser_manual_control');
  }
  assert.deepEqual(calls, before, 'Paused calls reached the driver');
  await remote.resumeAutomation(); await remote.capture(); await remote.navigate('https://fixture.invalid');
  assert.equal(remote.isAlive(), true); assert.equal(alive, true);
  assert.deepEqual(calls, ['capture', 'capture', 'navigate']);
});

for (const failCleanup of [false, true]) test(`check ${failCleanup ? '39' : '98'}: ${failCleanup ? 'failed browser cleanup blocks replacement until its owned driver exits' : 'old Run cleanup cannot close its successor browser'}`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-browser-regression-'));
  const drivers = []; let refuseClose = failCleanup, passed = false;
  const manager = new BrowserSessionManager(root, async () => {
    const state = { alive: true }; drivers.push(state);
    return {
      isAlive: () => state.alive,
      close: async () => { if (refuseClose) throw new Error('Declared cleanup failure'); state.alive = false; },
      pages: async () => ({ activePageId: 'page', pages: [{ pageId: 'page', url: 'about:blank', title: 'Fixture', active: true, isNew: false, closable: false }] }),
      viewport: () => ({ width: 1280, height: 720 }),
      controlRevision: () => 0, manualState: () => 'automation',
      cancelPendingFileChooser: async () => {},
    };
  }, () => {});
  t.after(async () => {
    refuseClose = false; await manager.closeAll('fixture_shutdown');
    assert.ok(drivers.every(x => !x.alive), 'Owned driver remains alive');
    if (passed) await rm(root, { recursive: true, force: true }); else t.diagnostic(`Failed browser fixture retained: ${root}`);
  });
  const scope = { projectId: randomUUID(), agentId: randomUUID(), runId: randomUUID(), conversationId: randomUUID() };
  const first = await manager.open(scope);
  if (failCleanup) {
    await assert.rejects(manager.closeRun(scope, 'fixture_run_ended'), /cleanup/);
    await assert.rejects(manager.open({ ...scope, runId: randomUUID() }));
    assert.equal(drivers.length, 1); assert.equal(drivers[0].alive, true, 'Refused cleanup was mistaken for exit');
    refuseClose = false;
  }
  await manager.closeRun(scope, 'fixture_run_ended'); assert.equal(drivers[0].alive, false);
  const nextScope = { ...scope, runId: randomUUID() }, second = await manager.open(nextScope);
  assert.notEqual(second.id, first.id); assert.equal(drivers.length, 2);
  await manager.closeRun(scope, 'late_old_cleanup');
  assert.equal(manager.get(scope.agentId).id, second.id); assert.equal(drivers[1].alive, true);
  await manager.closeRun(nextScope, 'fixture_complete'); assert.equal(drivers[1].alive, false); passed = true;
});

test('a single-tab browser refuses new-tab requests before invoking its driver', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'ponderosa-browser-single-tab-'));
  const previous={mode:process.env.NODE_ENV,multi:process.env.PONDEROSA_BROWSER_MULTI_PAGE};
  process.env.NODE_ENV='production';process.env.PONDEROSA_BROWSER_MULTI_PAGE='0';
  let alive=true,calls=0,passed=false;
  const manager=new BrowserSessionManager(root,async()=>({
    isAlive:()=>alive,close:async()=>{alive=false;},
    pages:async()=>({activePageId:'existing',pages:[{pageId:'existing',url:'about:blank',title:'Existing tab',active:true,isNew:false,closable:false}]}),
    newPage:async()=>{calls++;throw new Error('Disabled driver must not be called');},
  }),()=>{});
  try {
    const scope={projectId:randomUUID(),agentId:randomUUID(),runId:randomUUID(),conversationId:randomUUID()};
    const session=await manager.open(scope,undefined,'operator');assert.equal(session.capabilities.multiPage,false);
    await assert.rejects(manager.newPage(scope,session.controlEpoch),error=>error instanceof BrowserSessionError&&error.statusCode===409&&/New tabs are unavailable/.test(error.message));
    assert.equal(calls,0);assert.equal(manager.get(scope.agentId).id,session.id);assert.equal(alive,true);passed=true;
  }finally{
    await manager.closeAll('qualification_shutdown');assert.equal(alive,false);
    if(previous.mode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous.mode;
    if(previous.multi===undefined)delete process.env.PONDEROSA_BROWSER_MULTI_PAGE;else process.env.PONDEROSA_BROWSER_MULTI_PAGE=previous.multi;
    if(passed)await rm(root,{recursive:true,force:true});else t.diagnostic(`Failed single-tab fixture retained: ${root}`);
  }
});

// Deferred under the implementation-first instruction; execute with the final browser lane.
test('owned console query bounds history, filters without clearing, and rejects invalid cursors',()=>{
 const buffer=new BrowserObservationBuffer();
 for(let i=0;i<502;i++)buffer.console(i%2?'page-a':'page-b',i%2?'error':'log',`entry-${i}`);
 const first=buffer.query({after:0,limit:2,pageId:'page-a',level:'error'});
 assert.equal(first.truncated,true);assert.equal(first.entries.length,2);
 assert.deepEqual(first.entries.map(e=>e.sequence),[4,6]);assert.equal(first.next,6);
 assert.deepEqual(buffer.query({after:0,limit:2,pageId:'page-a',level:'error'}),first);
 assert.equal(buffer.query({after:502}).entries.length,0);
 for(const query of [{after:-1},{after:503},{limit:101},{limit:0},{level:'fake'},null])assert.throws(()=>buffer.query(query));
});
test('explicit frame recording retains one page, freezes on stop and reports frame/byte limits',()=>{
 const buffer=new BrowserObservationBuffer(),jpeg=Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
 const started=buffer.start('page-a');assert.throws(()=>buffer.start('page-b'));
 buffer.frame('page-b',jpeg);buffer.frame('page-a',jpeg);
 assert.throws(()=>buffer.stop('wrong-id'));
 const stopped=buffer.stop(started.id);assert.equal(stopped.frames.length,1);assert.equal(stopped.reason,'explicit_stop');
 buffer.frame('page-a',jpeg);assert.equal(buffer.stop(started.id).frames.length,1);
 buffer.discard();const capped=buffer.start('page-a');
 for(let i=0;i<121;i++)buffer.frame('page-a',jpeg);
 assert.equal(buffer.stop(capped.id).reason,'frame_limit');assert.equal(buffer.stop(capped.id).frames.length,120);
 buffer.discard();const bytes=buffer.start('page-a');buffer.frame('page-a','a'.repeat(8*1024*1024+1));
 assert.equal(buffer.stop(bytes.id).reason,'byte_limit');assert.equal(buffer.stop(bytes.id).frames.length,0);
});

test('console and recording methods cross the owned broker without bypassing manual control', {skip:process.platform==='win32'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'pbr-observe-')),buffer=new BrowserObservationBuffer();let alive=true,manual='automation';
 const driver={isAlive:()=>alive,close:async()=>{alive=false;},manualState:()=>manual,
  viewport:()=>({width:1280,height:720}),pages:async()=>({activePageId:'page',pages:[{pageId:'page',url:'about:blank',title:'Observation',active:true,isNew:false,closable:false}]}),
  cancelPendingFileChooser:async()=>{},pauseAutomation:async()=>{manual='manual';},resumeAutomation:async()=>{manual='automation';},
  consoleQuery:async q=>buffer.query(q),recordingStart:async page=>buffer.start(page),recordingStop:async id=>buffer.stop(id),recordingDiscard:async()=>buffer.discard()};
 const service=await startBrowserService(path.join(root,'broker.sock'),root,async()=>driver);let remote;
 t.after(async()=>{if(remote?.isAlive())await remote.close();await service.close();await rm(root,{recursive:true,force:true});});
 const client=new BrowserServiceClient(path.join(root,'broker.sock'));await client.claim();
 remote=await client.driver(randomUUID(),()=>{},{owner:{version:1,kind:'chat',conversationId:randomUUID()}});
 buffer.console('page','info','Owned observation');assert.equal((await remote.consoleQuery({})).entries[0].text,'Owned observation');
 const recording=await remote.recordingStart('page');buffer.frame('page','/9j/2Q==');
 assert.equal((await remote.recordingStop(recording.id)).frames.length,1);
 await remote.recordingDiscard();await remote.pauseAutomation();
 for(const action of [()=>remote.consoleQuery({}),()=>remote.recordingStart('page'),()=>remote.recordingStop(recording.id)])await assert.rejects(action,e=>e instanceof BrowserSessionError&&e.code==='browser_manual_control');
 await remote.recordingDiscard();
});

test('observation manager requires exact owner/Run and discards recording on control handoff',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'pbr-owner-'));let alive=true,queries=0,discarded=0;
 const manager=new BrowserSessionManager(root,async()=>({isAlive:()=>alive,close:async()=>{alive=false;},
  pages:async()=>({activePageId:'page',pages:[{pageId:'page',url:'about:blank',title:'Owned',active:true,isNew:false,closable:false}]}),
  cancelPendingFileChooser:async()=>{},consoleQuery:async()=>{queries++;return {entries:[],next:0,truncated:false};},
  recordingStart:async pageId=>({id:'owned-recording',pageId,startedAt:new Date().toISOString()}),recordingDiscard:async()=>{discarded++;}
 }),()=>{});
 t.after(async()=>{await manager.closeAll('fixture_complete');await rm(root,{recursive:true,force:true});});
 const conversationId=randomUUID(),scope={projectId:randomUUID(),agentId:randomUUID(),runId:randomUUID(),conversationId,owner:{version:1,kind:'chat',conversationId}};
 const opened=await manager.open(scope,undefined,'agent');await manager.consoleQuery(scope,{});assert.equal(queries,1);
 for(const other of [{...scope,projectId:randomUUID()},{...scope,runId:randomUUID()},{...scope,owner:{version:1,kind:'chat',conversationId:randomUUID()}}])await assert.rejects(manager.consoleQuery(other,{}));
 assert.equal(queries,1,'cross-owner query reached the driver');
 await manager.startRecording(scope,'page');const before=discarded;
 await manager.setControl(scope,'operator',opened.controlEpoch);assert.ok(discarded>before);
 await assert.rejects(manager.consoleQuery(scope,{}));await assert.rejects(manager.stopRecording(scope,'owned-recording'));assert.equal(queries,1);
});

// Deferred with the combined implementation: no execution performed for this source delivery.
test('operator observations require exact session/epoch/page and retain recoverable recording receipts', async t => {
 const root=await mkdtemp(path.join(tmpdir(),'pbr-operator-'));
 let alive=true,queries=0,active='page',published=0;
 const buffer=new BrowserObservationBuffer();
 const manager=new BrowserSessionManager(root,async()=>({isAlive:()=>alive,close:async()=>{alive=false;},
  pages:async()=>({activePageId:active,pages:[{pageId:'page',url:'about:blank',title:'Owned',active:active==='page',isNew:false,closable:false},{pageId:'sibling',url:'about:blank',title:'Other',active:active==='sibling',isNew:false,closable:true}]}),
  cancelPendingFileChooser:async()=>{},consoleQuery:async q=>{queries++;return buffer.query(q);},
  recordingStart:async page=>buffer.start(page),recordingStop:async id=>buffer.stop(id),recordingDiscard:async()=>buffer.discard()
 }),(_scope,event)=>{if(event.type==='generated_artifact')published++;});
 t.after(async()=>{await manager.closeAll('fixture_complete');await rm(root,{recursive:true,force:true});});
 const conversationId=randomUUID(),scope={projectId:randomUUID(),agentId:randomUUID(),runId:randomUUID(),conversationId,owner:{version:1,kind:'chat',conversationId}};
 const opened=await manager.open(scope,undefined,'operator');
 const context={sessionId:opened.id,expectedControlEpoch:opened.controlEpoch};
 buffer.console('page','info','owned');
 assert.equal((await manager.operatorConsole(scope,context,{pageId:'page'})).entries[0].text,'owned');
 for(const changed of [{...context,sessionId:randomUUID()},{...context,expectedControlEpoch:context.expectedControlEpoch+1}]) {
  await assert.rejects(manager.operatorConsole(scope,changed,{pageId:'page'}));
  await assert.rejects(manager.operatorRecordingStart(scope,changed,'page'));
  await assert.rejects(manager.operatorRecordingStatus(scope,changed));
 }
 await assert.rejects(manager.operatorConsole(scope,context,{pageId:'unadmitted'}));
 await assert.rejects(manager.operatorConsole({...scope,runId:randomUUID()},context,{pageId:'page'}));
 assert.equal(queries,1,'rejected requests reached the driver');
 await assert.rejects(manager.operatorRecordingStart(scope,context,'sibling'));
 active='sibling';await assert.rejects(manager.operatorRecordingStart(scope,context,'page'),'driver active-page race must be checked inside the queue');active='page';
 const recording=await manager.operatorRecordingStart(scope,context,'page');
 assert.deepEqual((await manager.operatorRecordingStatus(scope,context)).recording,recording,'lost start response can be recovered without another start');
 buffer.frame('page','/9j/2Q==');
 await assert.rejects(manager.operatorRecordingStop(scope,context,'wrong-id'));
 const receipt=await manager.operatorRecordingStop(scope,context,recording.id);
 assert.equal(receipt.frames,1);assert.equal(published,1);
 assert.deepEqual((await manager.operatorRecordingStatus(scope,context)).artifact,receipt,'lost stop response recovers its original receipt');
 assert.deepEqual(await manager.operatorRecordingStop(scope,context,recording.id),receipt);assert.equal(published,1,'repeated exact stop published twice');
 await manager.setControl(scope,'agent',context.expectedControlEpoch);
 await assert.rejects(manager.operatorRecordingStatus(scope,context));
 await assert.rejects(manager.operatorRecordingStop(scope,context,recording.id));
});

test('operator shared browser console is available without a grant, but recording cannot fabricate artifact provenance',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'pbr-shared-observation-'));let alive=true,started=0;
 const manager=new BrowserSessionManager(root,async()=>({isAlive:()=>alive,close:async()=>{alive=false;},
  pages:async()=>({activePageId:'page',pages:[{pageId:'page',url:'about:blank',title:'Owned',active:true,isNew:false,closable:false}]}),
  cancelPendingFileChooser:async()=>{},consoleQuery:async()=>({entries:[],next:0,truncated:false}),recordingStart:async()=>{started++;}
 }),()=>{});
 t.after(async()=>{await manager.closeAll('fixture_complete');await rm(root,{recursive:true,force:true});});
 const conversationId=randomUUID(),scope={projectId:randomUUID(),agentId:chatBrowserOwnerId(conversationId),runId:`chat:v1:${conversationId}`,conversationId,owner:{version:1,kind:'chat',conversationId}};
 const opened=await manager.open(scope,undefined,'operator');const context={sessionId:opened.id,expectedControlEpoch:opened.controlEpoch};
 assert.equal((await manager.operatorConsole(scope,context,{pageId:'page'})).next,0);
 await assert.rejects(manager.operatorRecordingStart(scope,context,'page'),e=>e.code==='operator_recording_unavailable');assert.equal(started,0);
});

test('operator observation reports driver unavailability rather than silently opening another browser',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'pbr-no-observation-'));let alive=true,opens=0;
 const manager=new BrowserSessionManager(root,async()=>{opens++;return {isAlive:()=>alive,close:async()=>{alive=false;},
  pages:async()=>({activePageId:'page',pages:[{pageId:'page',url:'about:blank',title:'Owned',active:true,isNew:false,closable:false}]}),cancelPendingFileChooser:async()=>{}};},()=>{});
 t.after(async()=>{await manager.closeAll('fixture_complete');await rm(root,{recursive:true,force:true});});
 const scope={projectId:randomUUID(),agentId:randomUUID(),runId:randomUUID()};const opened=await manager.open(scope,undefined,'operator');
 const context={sessionId:opened.id,expectedControlEpoch:opened.controlEpoch};
 await assert.rejects(manager.operatorConsole(scope,context,{pageId:'page'}),e=>e.statusCode===409&&/unavailable/.test(e.message));
 await assert.rejects(manager.operatorRecordingStart(scope,context,'page'),e=>e.statusCode===409&&/unavailable/.test(e.message));
 assert.equal(opens,1);
});
