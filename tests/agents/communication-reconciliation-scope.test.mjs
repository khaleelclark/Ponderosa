import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore} from '../../packages/agents/dist/index.js';
import {deriveCommunicationBehavior} from '../../packages/core/dist/index.js';
import {seedQualificationHistory} from '../shared/ui-load-fixture.mjs';

async function withStore(run){
 const root=await mkdtemp(path.join(tmpdir(),'ponderosa-reconcile-scope-'));
 const hostPath=path.join(root,'work'),dataDir=path.join(root,'data');await mkdir(hostPath);
 const x={root,hostPath,dataDir,store:new AgentStore(dataDir)};let success=false;
 try{await run(x);success=true;}finally{x.store.close();if(success)await rm(root,{recursive:true,force:true});}
}
function reconcileReads(store,projectId){
 const original=store.getConversation,reads=[];
 store.getConversation=function(id,...args){reads.push(id);return original.call(this,id,...args);};
 try{return {report:store.reconcileCommunicationEvents(projectId),reads};}
 finally{store.getConversation=original;}
}
function oncePerChat(reads,ids){
 assert.deepEqual([...reads].sort(),[...ids].sort(),'Catalog reads must scale with distinct Chats, including missing Chats, rather than historical rows');
}

test('real retained history reconciles with one current Chat read per room and refreshes deletion boundaries',async()=>withStore(async x=>{
 const project=x.store.createProject({label:'Reconciliation scale',hostPath:x.hostPath,defaultEngine:'codex'});
 const first=x.store.createConversation(project.id,{title:'Small history'});
 seedQualificationHistory(x.store,first,32);
 let pass=reconcileReads(x.store,project.id);assert.equal(pass.report.ok,true);assert.equal(pass.report.canonicalEvents,32);oncePerChat(pass.reads,[first.id]);
 const second=x.store.createConversation(project.id,{title:'Larger retained history'}),seed=seedQualificationHistory(x.store,second,384);
 pass=reconcileReads(x.store,project.id);assert.equal(pass.report.ok,true);assert.equal(pass.report.canonicalEvents,416);oncePerChat(pass.reads,[first.id,second.id]);
 const before=pass.report;x.store.close();x.store=new AgentStore(x.dataDir);
 pass=reconcileReads(x.store,project.id);assert.deepEqual(pass.report,before);oncePerChat(pass.reads,[first.id,second.id]);
 const last=x.store.getProjectedConversationMessageById(second.id,'main',seed.lastId);assert.equal(last?.id,seed.lastId);
 const lastEventId=last.communicationEventId;assert.equal(typeof lastEventId,'string');
 assert.equal(x.store.getCommunicationProjection(project.id,lastEventId,'conversation',second.id)?.eventId,lastEventId);
 x.store.markConversationDeletionPending(second.id);
 for(let i=0;i<2;i++){
  pass=reconcileReads(x.store,project.id);assert.equal(pass.report.ok,true);assert.equal(pass.report.canonicalEvents,32);oncePerChat(pass.reads,[first.id,second.id]);
 }
 assert.equal(x.store.getCommunicationProjection(project.id,lastEventId,'conversation',second.id),undefined,'Independent reads must immediately observe a deleted-room fence');
 assert.equal(x.store.readCommunicationProjections(project.id).some(row=>row.projectionKey===second.id),false);
}));

test('reconciliation reuse preserves private recipients, foreign-room rejection and later Agent removal',async()=>withStore(async x=>{
 const project=x.store.createProject({label:'Private reconciliation',hostPath:x.hostPath,defaultEngine:'codex'});
 const chat=x.store.createConversation(project.id,{title:'Private Chat'}),other=x.store.createConversation(project.id,{title:'Other Chat'});
 const agent=x.store.createAgent(project.id,{title:'Recipient',engine:'codex',conversationId:chat.id});
 const outsider=x.store.createAgent(project.id,{title:'Unrelated',engine:'codex',conversationId:other.id});
 const event={schemaVersion:2,eventId:randomUUID(),projectId:project.id,conversationId:chat.id,sender:{kind:'user',userId:'local-operator'},intent:'user_dm',audience:{kind:'user_agents',userId:'local-operator',agentIds:[agent.id]},text:'Private canonical instruction',createdAt:new Date().toISOString()};
 x.store.appendCommunicationEvent(event);
 for(const target of deriveCommunicationBehavior(event).projectionTargets){
  x.store.appendCommunicationProjection(project.id,{eventId:event.eventId,...target,projectedAt:event.createdAt,
   ...(['conversation','collaboration_view','direct_agent_audit'].includes(target.surface)?{message:{messageId:event.eventId,role:'user',renderedText:event.text,createdAt:event.createdAt}}:{})});
 }
 const before=reconcileReads(x.store,project.id);assert.equal(before.report.ok,true);oncePerChat(before.reads,[chat.id]);
 assert.ok(x.store.getCommunicationProjection(project.id,event.eventId,'direct_agent_audit',agent.id));
 for(const [surface,projectionKey]of [['conversation',other.id],['direct_agent_audit',outsider.id]]){
  assert.throws(()=>x.store.appendCommunicationProjection(project.id,{eventId:event.eventId,surface,projectionKey,projectedAt:event.createdAt}),/scope cannot project/);
  assert.equal(x.store.getCommunicationProjection(project.id,event.eventId,surface,projectionKey),undefined);
 }
 assert.equal(x.store.deleteAgent(agent.id),true);
 const after=reconcileReads(x.store,project.id);assert.equal(after.report.ok,true);oncePerChat(after.reads,[chat.id]);
 assert.ok(after.report.linkedProjections<before.report.linkedProjections);
 assert.equal(x.store.getCommunicationProjection(project.id,event.eventId,'direct_agent_audit',agent.id),undefined);
 assert.equal(x.store.readCommunicationProjections(project.id).some(row=>row.projectionKey===agent.id),false);
 assert.equal(x.store.getCommunicationProjection(project.id,event.eventId,'conversation',chat.id)?.eventId,event.eventId,'The operator retains its own canonical Chat message');
}));
