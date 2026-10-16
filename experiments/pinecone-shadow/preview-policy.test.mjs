import assert from 'node:assert/strict';
import test from 'node:test';
import {candidateMutationAllowed as allowed} from '../../preview-policy.mjs';
const c={branchId:'candidate',spokespersonId:'speaker',triggerId:'timer',supported:true,deliveryMode:'user-ui'};
const message={text:'A real user message',idempotencyKey:'stable',activeRunDelivery:'queue'};
test('Only the activated spokesperson UI accepts user messages',()=>{
 assert.equal(allowed('POST','/api/branches/engine/agents/speaker/messages',message,[c]),true);
 for(const change of [{deliveryMode:'shadow'},{supported:false}])assert.equal(allowed('POST','/api/branches/engine/agents/speaker/messages',message,[{...c,...change}]),false);
 assert.equal(allowed('POST','/api/branches/engine/agents/worker/messages',message,[c]),false);
 assert.equal(allowed('POST','/api/branches/engine/agents/speaker/messages',{...message,recipientAgentIds:['other']},[c]),false);
 assert.equal(allowed('POST','/api/branches/engine/agents/speaker/messages',{...message,model:'unrequested'},[c]),false);
 assert.equal(allowed('POST','/api/branches/engine/agents/speaker/messages',{...message,text:''},[c]),false);
});
test('Check now and pause are bound to this candidate only',()=>{
 assert.equal(allowed('POST','/api/branches/candidate/executions',{occurrenceKey:'once',input:'Check now'},[c]),true);
 assert.equal(allowed('POST','/api/branches/other/executions',{occurrenceKey:'once',input:'Check now'},[c]),false);
 const toggle={enabled:false,reviewedDefinition:{id:'timer',branchId:'candidate'}};
 assert.equal(allowed('PATCH','/api/branches/engine/triggers/timer',toggle,[c]),true);
 assert.equal(allowed('PATCH','/api/branches/engine/triggers/timer',{...toggle,reviewedDefinition:{id:'timer',branchId:'other'}},[c]),false);
 assert.equal(allowed('PATCH','/api/branches/engine/agents/speaker',{model:'other'},[c]),false);
 assert.equal(allowed('POST','/api/agent-messages',message,[c]),false);
});

test('v4 texting routes retain exact ownership and reject routing or model overrides',()=>{
 const own={branchId:'v4',spokespersonId:'v4-speaker',triggerId:'v4-trigger',deliveryMode:'user-ui',supported:true};
 const body={text:'Harmless fixture',idempotencyKey:'test',activeRunDelivery:'queue'};
 assert.equal(allowed('POST','/api/branches/engine/agents/v4-speaker/messages',body,[own]),true);
 assert.equal(allowed('POST','/api/branches/engine/agents/other/messages',body,[own]),false);
 assert.equal(allowed('POST','/api/branches/engine/agents/v4-speaker/messages',{...body,sourceConversationId:'other'},[own]),false);
 assert.equal(allowed('POST','/api/branches/engine/agents/v4-speaker/messages',{...body,model:'different'},[own]),false);
});

test('voice, cancellation, memory and decisions need exact reviewed installation and host observations',async()=>{
 const {authorizeCandidateMutation,mutationOriginAllowed}=await import('../../preview-policy.mjs');
 const {memoryCommand}=await import('../../apps/server/dist/routes/memory.js');
 const own={...c,conversationId:'chat',projectId:'project',voiceEnabled:true,memoryEnabled:true};
 const path='/api/branches/engine/conversations/chat/direct-messages';
 const voice={...message,recipients:[{agentId:'speaker'}],voiceReply:true};
 assert.equal(allowed('POST',path,voice,[own]),true);
 for(const extra of [{model:'other'},{engine:'claude'},{attachments:[]},{recipients:[{agentId:'speaker',attachments:[]}]},{recipients:[{agentId:'foreign'}]},{voiceReply:false},{activeRunDelivery:'steer'}])assert.equal(allowed('POST',path,{...voice,...extra},[own]),false);
 assert.equal(allowed('POST',path,voice,[{...own,voiceEnabled:false}]),false);
 const cancel='/api/branches/engine/agents/speaker/cancel',body={targetRunId:'run',idempotencyKey:'cancel'};
 assert.equal(allowed('POST',cancel,body,[own]),false);
 assert.equal(await authorizeCandidateMutation('POST',cancel,body,[own],{readJson:async()=>({agent:{id:'speaker'},runs:[{id:'run',status:'running'}]})}),true);
 assert.equal(await authorizeCandidateMutation('POST',cancel,body,[own],{readJson:async()=>({agent:{id:'speaker'},runs:[{id:'foreign',status:'running'}]})}),false);
 const memory='/api/branches/engine/projects/project/memories';
 assert.equal(allowed('POST',memory,{operation:'list'},[own],{memoryCommand}),true);
 assert.equal(allowed('POST',memory,{operation:'list'},[own]),false);
 for(const bad of [{operation:'list',projectId:'other'},{operation:'promote'},{operation:'save',text:'fact',commandKey:'save',scope:'global'},{operation:'save',text:'fact',commandKey:'save',sources:[{kind:'communication',id:'x',revision:'1',sha256:'invalid'}]}])assert.equal(allowed('POST',memory,bad,[own],{memoryCommand}),false);
 const decision='/api/branches/engine/decisions/question/respond',answer={optionId:'yes'};
 assert.equal(allowed('POST',decision,answer,[own]),false);
 assert.equal(await authorizeCandidateMutation('POST',decision,answer,[own],{readJson:async()=>[{id:'question',projectId:'project',conversationId:'chat',agentId:'speaker',status:'pending'}]}),true);
 assert.equal(await authorizeCandidateMutation('POST',decision,answer,[own],{readJson:async()=>[{id:'question',projectId:'project',conversationId:'foreign',agentId:'speaker',status:'pending'}]}),false);
 assert.equal(mutationOriginAllowed('https://unapproved.test',['http://100.88.80.22:18795']),false);
 assert.equal(mutationOriginAllowed('http://100.88.80.22:18795',['http://100.88.80.22:18795']),true);
});
