// Deferred source fixture. No browser/process/provider is launched by its controlled driver.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore, readManagedArtifactContent} from '@ponderosa/agents';
import {chatBrowserOwnerId} from '@ponderosa/core';
import {AssetStore} from '../../apps/server/dist/assets.js';
import {createBrowserAuthority} from '../../apps/server/dist/browser-authority.js';
import {BrowserObservationBuffer} from '../../apps/server/dist/browser-observation-buffer.js';

for (const saved of [false,true]) test(`operator ${saved?'saved':'Chat'} recording publishes a canonical private Chat document without Agent/Run attribution`,async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'pbr-chat-publication-'));let store=new AgentStore(root),assets=new AssetStore(root),authority;
 const buffers=new Map();let runtimeEvents=0;
 try {
  const project=store.createProject({label:'Operator recording',hostPath:root,defaultEngine:'codex'});
  const chat=store.createConversation(project.id,{title:'Chosen destination'}),other=store.createConversation(project.id,{title:'Other Chat'});
  const reader=store.createAgent(project.id,{title:'Not a recording producer',engine:'codex',conversationId:other.id});
  authority=createBrowserAuthority({dataDir:root,store,assets,activeRuns:new Map(),publish:()=>{},logWarn:()=>{},
   persistRuntimeEvent:async()=>{runtimeEvents++;throw Error('Operator recording fabricated an Agent runtime event');},
   providerProcessAuthority:{register:()=>{}},browserAdmissionAllowed:()=>true,
   driverFactory:async sessionId=>{
    const buffer=new BrowserObservationBuffer();buffers.set(sessionId,buffer);let alive=true;
    return {isAlive:()=>alive,close:async()=>{alive=false;},cancelPendingFileChooser:async()=>{},
     pages:async()=>({activePageId:'page',pages:[{pageId:'page',url:'about:blank',title:'Controlled',active:true,isNew:false,closable:false}]}),
     recordingStart:async page=>buffer.start(page),recordingStop:async id=>buffer.stop(id),recordingDiscard:async()=>buffer.discard()};
   }});
  const manager=authority.projectBrowserSessions,scope=authority.projectBrowserScope(saved?'saved-browser':chatBrowserOwnerId(chat.id));
  const opened=await manager.open(scope,undefined,'operator');
  const context={sessionId:opened.id,expectedControlEpoch:opened.controlEpoch,...(saved?{destination:{conversationId:chat.id}}:{})};
  if(saved)await assert.rejects(manager.operatorRecordingStart(scope,{sessionId:opened.id,expectedControlEpoch:opened.controlEpoch},'page'),e=>e.code==='recording_destination_required');
  else await assert.rejects(manager.operatorRecordingStart(scope,{...context,destination:{conversationId:other.id}},'page'));
  const started=await manager.operatorRecordingStart(scope,context,'page');buffers.get(opened.id).frame('page','/9j/2Q==');
  await assert.rejects(manager.operatorRecordingStop(scope,{...context,destination:{conversationId:other.id}},started.id));
  const receipt=await manager.operatorRecordingStop(scope,context,started.id);
  assert.deepEqual(receipt.destination,{projectId:project.id,conversationId:chat.id});assert.equal(receipt.frames,1);
  assert.deepEqual((await manager.operatorRecordingStatus(scope,context)).artifact,receipt);
  assert.deepEqual(await manager.operatorRecordingStop(scope,context,started.id),receipt);
  const artifact=store.getProjectArtifact(project.id,receipt.artifactId);
  assert.equal(artifact.agentId,chat.id,'storage owner is the canonical Chat, never a fabricated Agent');
  assert.deepEqual(artifact.origin,{kind:'operator',conversationId:chat.id});assert.equal(artifact.originAgentId,undefined);assert.equal(artifact.executionId,undefined);
  assert.throws(()=>store.recordOperatorChatArtifact({...artifact,id:'forged-origin',originAgentId:reader.id}));
  assert.throws(()=>store.recordOperatorChatArtifact({...artifact,id:'forged-run',executionId:'not-an-operator-run'}));
  assert.equal(artifact.kind,'document');assert.equal(runtimeEvents,0);assert.equal(store.readEvents(reader.id).some(x=>x.event.type==='generated_artifact'),false);
  assert.equal(store.operatorCanReadProjectArtifact(project.id,artifact.id),true);
  assert.equal(store.agentCanReadProjectArtifact(project.id,artifact.id,reader.id),false);
  assert.equal(store.projectArtifactBelongsToConversation(project.id,artifact.id,chat.id),true);
  assert.equal(store.projectArtifactBelongsToConversation(project.id,artifact.id,other.id),false);
  assert.ok(store.getProjectArtifactPage(project.id,{limit:20,conversationId:chat.id,productScope:'dev'}).items.some(x=>x.id===artifact.id));
  assert.equal(store.getProjectArtifactPage(project.id,{limit:20,conversationId:other.id}).items.some(x=>x.id===artifact.id),false);
  assert.equal(store.getProjectArtifactPage(project.id,{limit:20,productScope:'branches'}).items.some(x=>x.id===artifact.id),false);
  assert.equal(store.getProjectContextArtifacts(project.id,20,chat.id).some(x=>x.id===artifact.id),false);
  const managed=readManagedArtifactContent(root,project.id,artifact.id,artifact.size,artifact.sha256);
  assert.ok(managed);const bytes=managed.body;
  assert.equal(JSON.parse(bytes.toString()).format,'ponderosa.browser-recording.v1');
  const next=await manager.operatorRecordingStart(scope,context,'page');buffers.get(opened.id).frame('page','/9j/2Q==');
  store.markConversationDeletionPending(chat.id);
  await assert.rejects(manager.operatorRecordingStop(scope,context,next.id),'a pending destination deletion must fence publication');
  await assert.rejects(manager.operatorRecordingStatus(scope,context));
  assert.equal(store.getProjectArtifacts(project.id).length,1,'rejected publication changed the destination catalog');
  assert.equal(store.operatorCanReadProjectArtifact(project.id,artifact.id),false,'pending Chat deletion fences prior receipts too');
  assert.throws(()=>store.recordOperatorChatArtifact({...artifact,id:'late-document'}));
  await manager.closeAll('fixture_restart');
  assert.throws(()=>store.purgeOperatorChatArtifacts(project.id,chat.id),/committed Chat deletion receipt/);
  assert.ok(store.commitConversationDeletion(chat.id)?.canonicalDeletionCompleted);
  assets.close();store.close();
  store=new AgentStore(root);assets=new AssetStore(root);
  const restored=store.getProjectArtifact(project.id,artifact.id);assert.deepEqual(restored.origin,artifact.origin);
  assert.ok(readManagedArtifactContent(root,project.id,restored.id,restored.size,restored.sha256)?.body.equals(bytes));
  store.purgeOperatorChatArtifacts(project.id,chat.id);
  assert.equal(store.getProjectArtifact(project.id,artifact.id),undefined);
  assert.equal(readManagedArtifactContent(root,project.id,artifact.id,artifact.size,artifact.sha256),undefined);
 } finally {
  await authority?.projectBrowserSessions.closeAll('fixture_complete');assets.close();store.close();await rm(root,{recursive:true,force:true});
 }
});
