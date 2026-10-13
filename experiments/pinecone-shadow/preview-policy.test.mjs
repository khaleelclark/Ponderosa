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
