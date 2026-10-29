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
