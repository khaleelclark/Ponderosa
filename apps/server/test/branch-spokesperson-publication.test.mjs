import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {registerAgentRequestCommandRoutes} from '../dist/routes/agent-request-commands.js';
import {PONDEROSA_UPDATE_REQUEST_TOOL} from '@ponderosa/core';

test('managed Request tool carries exact authored publication through the real route and Branch receipt boundary',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'branch-publication-')),store=new AgentStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination,(p,id)=>store.getCommunicationEvent(p,id)),app=Fastify();
 t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true})});
 const project=store.createProject({label:'Publication',hostPath:dir,defaultEngine:'codex'}),chat=store.getConversation(project.lastConversationId),agent=store.createAgent(project.id,{title:'Spokesperson',engine:'codex',conversationId:chat.id});
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',bindings:{agents:{speaker:agent.id},directories:{root:dir}},definition:{schema:'ponderosa.branch.v1',name:'Publication',trigger:{kind:'manual'},entry:'speak',steps:[{id:'speak',kind:'agent',target:{kind:'persistent_agent',ref:'speaker'},instructions:'Publish once',requireUserCommunication:true},{id:'receipt',kind:'script',runtime:'node',source:'console.log("delivered")',cwdRef:'root',timeoutMs:5000}],controls:[],edges:[{id:'published',from:'speak',to:'receipt',on:'success'}],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}}});
 const execution=branches.accept(branch.id,'check','input');branches.advance();const attempt=branches.detail(execution.id).attempts[0];
 const lease=coordination.leaseNextRun({workerId:'fixture'});assert.ok(lease);coordination.markRunStarted(lease.runId,lease.fencingToken);
 coordination.recordProviderInput({executionId:'provider-run',schedulerRunId:lease.runId,fencingToken:lease.fencingToken,agentId:agent.id,projectId:project.id,prompt:'Publish once',sourceManifest:{schemaVersion:1,activationIds:lease.activationIds,communicationEventIds:[],artifactIds:[],historyMessageCount:0,conversationId:chat.id,providerSessionDisposition:'fresh_task',sources:[]}});
 const capability={agentId:agent.id,runId:'provider-run',v3SchedulerRunId:lease.runId};
 registerAgentRequestCommandRoutes(app,{store,coordinationV3:coordination,agentMessageCapabilities:new Map([['fixture',capability]]),activeRuns:new Map([[agent.id,{messageCapability:'fixture'}]]),capabilityMatchesCleanupRun:()=>true,runAuthorization:()=>({runId:lease.runId,agentId:agent.id,fencingToken:lease.fencingToken}),projectDeletionInProgress:()=>false,conversationDeletionInProgress:()=>false,agentDeletionInProgress:()=>false,conversationDeliveryLeases:new Map(),agentDeliveryLeases:new Map(),projectCommunicationArtifact(){},requestArtifactAccess(){return{}},runtimeArtifactMetadata(){return{}},stageCommunicationArtifact(){throw Error('No long-text staging expected')},removeRuntimeArtifactReservation(){},recordCommunication:e=>store.appendCommunicationEvent(e).event,projectCommunicationToAgentAudit(){},publishCoordinationV3Changed(){},notifyScheduler(){}});
 const update=payload=>app.inject({method:'POST',url:'/api/agent-request-updates',headers:{authorization:'Bearer fixture'},payload});
 const originalState=coordination.getRequest(attempt.requestId).state;
 assert.ok(PONDEROSA_UPDATE_REQUEST_TOOL.inputSchema.properties.communicationEventId);
 for(const bad of ['',123,'x'.repeat(257)]){const response=await update({text:'delivered',communicationEventId:bad});assert.equal(response.statusCode,400,response.body);assert.equal(coordination.getRequest(attempt.requestId).state,originalState);}
 const absent=await update({text:'delivered',communicationEventId:'invented'});assert.equal(absent.statusCode,409,absent.body);
 store.appendCommunicationEvent({eventId:'actual-publication',schemaVersion:2,projectId:project.id,conversationId:chat.id,sender:{kind:'agent',agentId:agent.id,executionId:'provider-run'},intent:'user_dm',audience:{kind:'user_agent',agentId:agent.id,userId:'local-operator'},text:'An actual finding',createdAt:new Date().toISOString()});
 const accepted=await update({text:'An actual finding',communicationEventId:'actual-publication'});assert.equal(accepted.statusCode,200,accepted.body);
 const payload=JSON.parse(store.sqlite.prepare("SELECT payload_json FROM coordination_request_updates WHERE request_id=? AND resulting_state='completed'").get(attempt.requestId).payload_json);assert.equal(payload.communicationEventId,'actual-publication');
 const replay=await update({text:'An actual finding',communicationEventId:'actual-publication'});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().replayed,true);
 branches.advance();const receipt=branches.claimScript('receipt');assert.ok(receipt,'verified publication unlocks the receipt');branches.settleScript(receipt,{failed:false,output:'delivered'});assert.equal(branches.execution(execution.id).state,'completed');
});
