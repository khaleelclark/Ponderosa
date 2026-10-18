import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingPineconeDecision,preparePineconeReply,deliverPineconeReply} from '../../web/src/components/pinecone/pineconeDecisionReply.ts';
const decision=(id,extra={})=>({id,agentId:'speaker',status:'pending',blocking:true,mode:'choice',allowOther:true,createdAt:'2026-10-18T00:00:00Z',options:[],...extra});
test('follow-up uses the oldest exact blocking question, not another Agent or approval',()=>{
  const rows=[decision('other',{agentId:'other'}),decision('new',{createdAt:'2026-10-18T01:00:00Z'}),decision('approval',{mode:'approval'}),decision('runtime',{runtimeAction:{}}),decision('old'),decision('scope',{approvalScope:{kind:'saved_browser'}})];
  assert.equal(pendingPineconeDecision(rows,'speaker').id,'old');
  assert.equal(rows[0].id,'other');
});
test('pick either is an answer bound to the selected decision; never a new chat or inferred option',async()=>{
 const sent=[],answers=[];
 const attempt=preparePineconeReply(' pick either one ','key',decision('question'));
 for(let n=0;n<2;n++)await deliverPineconeReply(attempt,async x=>sent.push(x),async(id,response)=>answers.push({id,response}));
 assert.deepEqual(sent,[]);
 assert.deepEqual(answers,[{id:'question',response:{text:'pick either one'}},{id:'question',response:{text:'pick either one'}}]);
 assert.deepEqual(JSON.parse(JSON.stringify(attempt)),{text:'pick either one',key:'key',decisionId:'question'});
});
test('an explicit new-message destination remains chat even when its prose resembles an answer',async()=>{
 const sent=[],answers=[];
 await deliverPineconeReply(preparePineconeReply('pick either one','key'),async x=>sent.push(x),async(...x)=>answers.push(x));
 assert.equal(sent.length,1);assert.equal(answers.length,0);
});
test('failed answer cannot silently fall back to sending an unrelated chat',async()=>{
 let messages=0;
 await assert.rejects(deliverPineconeReply(preparePineconeReply('yes','key',decision('exact')),async()=>messages++,async()=>{throw Error('offline')}));
 assert.equal(messages,0);
});

test('an option-only question cannot turn a free-text answer into a new chat',()=>{const strict=decision('strict',{allowOther:false});assert.equal(pendingPineconeDecision([strict],'speaker').id,'strict');assert.throws(()=>preparePineconeReply('pick either','key',strict),/offered option/)});
