import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {verifyChatInputEvidence} from '../workspace-navigation/verify-chat-input-evidence.mjs';

async function evidence(t){
 const dir=await mkdtemp(path.join(tmpdir(),'chat-input-oracle-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const cases=['row-queue','row-queue-chat'].map((marker,index)=>({marker,kind:'queue',agentId:'agent-'+index,expected:marker+' λ😀\nsecond\n\nTAIL_KEEP_ME  '}));
 const requests=cases.map(c=>({method:'PATCH',status:200,body:{text:c.expected}}));
 const state={decisions:{},queues:Object.fromEntries(cases.map(c=>[c.agentId,[{deliveryId:c.marker,targetAgentId:c.agentId,text:c.expected}]]))};
 const save=(name,value)=>writeFile(path.join(dir,name),JSON.stringify(value));
 await Promise.all([save('paste-cases.json',cases),save('requests.json',requests),save('canonical-journal.json',[]),save('canonical-state.json',state)]);
 return {dir,cases,requests,state,save};
}

test('input oracle distinguishes queue from queue-chat and keeps complete multiline tails',async t=>{
 const f=await evidence(t),result=await verifyChatInputEvidence(f.dir);
 assert.equal(result.length,2);assert.deepEqual(result.map(r=>r.canonical),f.cases.map(c=>c.expected));
 assert.ok((await readFile(path.join(f.dir,'canonical-equality.json'),'utf8')).includes('TAIL_KEEP_ME  '));
});

test('input oracle rejects submitted truncation and canonical recipient substitution',async t=>{
 const f=await evidence(t);f.requests[0].body.text=f.cases[0].expected.replace('TAIL_KEEP_ME  ','');await f.save('requests.json',f.requests);
 await assert.rejects(verifyChatInputEvidence(f.dir),/Complete submitted body/u);
 f.requests[0].body.text=f.cases[0].expected;await f.save('requests.json',f.requests);
 f.state.queues[f.cases[0].agentId][0].targetAgentId='different-agent';await f.save('canonical-state.json',f.state);
 await assert.rejects(verifyChatInputEvidence(f.dir),/Exact queue recipient/u);
});

test('input oracle keeps raw CRLF submission distinct from canonical LF policy',async t=>{
 const f=await evidence(t),expected='row-dm λ😀\r\nsecond\r\n\r\nTAIL_KEEP_ME';
 const item={marker:'row-dm',kind:'dm',agentId:'agent',agentHandle:'Recipient',expected};
 await f.save('paste-cases.json',[item]);await f.save('requests.json',[{method:'POST',status:200,body:{text:expected}}]);
 await f.save('canonical-journal.json',[{role:'user',renderedText:'#Recipient '+expected.replaceAll('\r\n','\n'),deliveryIntents:[{targetAgentId:'agent'}]}]);
 assert.equal((await verifyChatInputEvidence(f.dir))[0].submitted,expected);
 await f.save('requests.json',[{method:'POST',status:200,body:{text:expected.replaceAll('\r\n','\n')}}]);
 await assert.rejects(verifyChatInputEvidence(f.dir),/Complete submitted body/u);
});

test('adjacent workflow oracle rejects a changed persisted reason',async t=>{
 const f=await evidence(t),expected={output:'workflow λ😀\nsecond\n\nTAIL_KEEP_ME',reason:'workflow-reason λ😀\nsecond\n\nTAIL_KEEP_ME'};
 await f.save('paste-cases.json',[{marker:'workflow',kind:'workflow-intervention',executionId:'exact-execution',expectedValues:expected}]);
 await f.save('requests.json',[{method:'POST',path:'/api/branch-executions/exact-execution/intervene',status:200,body:{result:{output:expected.output},reason:expected.reason}}]);
 const state={workflows:{'exact-execution':{execution:{output:expected.output}}},workflowCheckpoints:[{execution_id:'exact-execution',evidence:{result:{output:expected.output},reason:expected.reason}}]};
 await f.save('canonical-state.json',state);assert.equal((await verifyChatInputEvidence(f.dir)).length,1);
 state.workflowCheckpoints[0].evidence.reason='Unrelated reason';await f.save('canonical-state.json',state);
 await assert.rejects(verifyChatInputEvidence(f.dir),/Complete persisted intervention reason/u);
});

test('shared Chat default creation proves Broadcast scope and the returned new recipient',async t=>{
 const f=await evidence(t),expected='shared-chat λ😀\r\nsecond\r\n\r\nTAIL_KEEP_ME';
 await f.save('paste-cases.json',[{marker:'shared-chat',kind:'chat',agentId:'unrelated-existing-agent',expected}]);
 await f.save('requests.json',[{method:'POST',status:201,body:{initialMessage:expected},responseId:'new-default-agent'}]);
 const journal=[{role:'user',channel:'main',renderedText:'#broadcast '+expected.replaceAll('\r\n','\n'),deliveryIntents:[{targetAgentId:'new-default-agent'}]}];await f.save('canonical-journal.json',journal);
 assert.equal((await verifyChatInputEvidence(f.dir)).length,1);
 journal[0].deliveryIntents[0].targetAgentId='unrelated-existing-agent';await f.save('canonical-journal.json',journal);
 await assert.rejects(verifyChatInputEvidence(f.dir),/Exact canonical recipient/u);
});

test('provider enum receipts bind the exact Decision even when values match',async t=>{
 const f=await evidence(t),expected='Same allowed value';
 await f.save('paste-cases.json',[{kind:'runtime-enum',agentId:'agent',decisionId:'exact',prefix:'/api',expected}]);
 await f.save('requests.json',['exact','other'].map(id=>({method:'POST',status:200,path:'/api/decisions/'+id+'/respond',body:{content:{reply:expected}}})));
 const state={decisions:{exact:{agentId:'agent',response:{optionId:'submit'}}},providerReplies:{agent:[{decisionId:'exact',reply:{action:'accept',content:{reply:expected}}}]}};
 await f.save('canonical-state.json',state);assert.equal((await verifyChatInputEvidence(f.dir)).length,1);
 state.providerReplies.agent[0].decisionId='other';await f.save('canonical-state.json',state);
 await assert.rejects(verifyChatInputEvidence(f.dir),/One exact provider callback/u);
});
