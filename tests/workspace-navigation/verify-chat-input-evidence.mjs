import {normalizeCanonicalText} from '../../packages/core/dist/text-policy.js';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// An oracle correction can be rerun against retained real API snapshots without
// repeating native input. Expected prefixes include explicitly selected routing.
export async function verifyChatInputEvidence(output){
 const read=async name=>JSON.parse(await readFile(path.join(output,name),'utf8'));
 const [cases,requests,journals,state]=await Promise.all(['paste-cases.json','requests.json','canonical-journal.json','canonical-state.json'].map(read));
 const equality=[];
 for(const item of cases){
  if(item.kind.startsWith('workflow-')){
   const saved=state.workflows[item.executionId],expected=item.expectedValues;
   const submitted=requests.filter(r=>r.method==='POST'&&r.status>=200&&r.status<300&&(item.kind==='workflow-gate'?r.path===`/api/branch-gates/${item.gateId}/resolve`:r.path===`/api/branch-executions/${item.executionId}/intervene`));
   assert.equal(submitted.length,1,'One exact workflow endpoint');
   assert.equal(item.kind==='workflow-gate'?submitted[0].body.output:submitted[0].body.result.output,expected.output);
   assert.equal(saved.execution.output,expected.output,'Complete persisted workflow output');
   if(expected.reason){assert.equal(submitted[0].body.reason,expected.reason);assert.ok(state.workflowCheckpoints.some(d=>d.execution_id===item.executionId&&d.evidence.reason===expected.reason&&d.evidence.result.output===expected.output),'Complete persisted intervention reason');}
   equality.push({...item,status:'pass',canonical:saved.execution.output});continue;
  }
  if(['runtime-string','runtime-enum'].includes(item.kind)){
   const submitted=requests.filter(r=>r.method==='POST'&&r.status>=200&&r.status<300&&r.path===`${item.prefix}/decisions/${item.decisionId}/respond`&&r.body?.content?.reply===item.expected);
   assert.equal(submitted.length,1,'One exact provider form submission');
   assert.equal(state.decisions[item.decisionId].agentId,item.agentId,'Exact provider owner');
   const receipts=state.providerReplies[item.agentId];
   const receipt=Array.isArray(receipts)?receipts.filter(r=>r.decisionId===item.decisionId):[{reply:receipts}];assert.equal(receipt.length,1,'One exact provider callback');
   assert.deepEqual(receipt[0].reply,{action:'accept',content:{reply:item.expected}},'Exact controlled provider delivery');
   assert.equal(Object.hasOwn(state.decisions[item.decisionId].response,'content'),false,'Provider content is not persisted in Decision');
   equality.push({...item,status:'pass',canonical:receipt[0].reply});continue;
  }

  if(item.kind==='decision-group'){
   const expectedAnswers=item.expectedAnswers.map(answer=>({...answer,attachmentIds:answer.attachmentIds??[]}));
   const submitted=requests.filter(r=>r.method==='POST'&&r.status>=200&&r.status<300&&JSON.stringify(r.body?.answers??[]).includes(item.marker+'-first '));
   assert.equal(submitted.length,1,item.marker);assert.deepEqual(submitted[0].body.answers,expectedAnswers,'Complete submitted grouped answers');
   const decision=state.decisions[item.decisionId];assert.equal(decision.agentId,item.agentId);assert.deepEqual(decision.response.answers,expectedAnswers,'Complete canonical grouped answers');equality.push({...item,status:'pass',canonical:decision.response.answers});continue;
  }
  const contains=text=>typeof text==='string'&&text.includes(item.marker+' λ😀');
  const submitted=requests.filter(r=>['POST','PATCH'].includes(r.method)&&r.status>=200&&r.status<300&&contains(r.body?.text??r.body?.initialMessage));
  assert.equal(submitted.length,1,'One accepted submission '+item.marker);
  const submittedText=item.kind==='inbox'?'#'+item.agentHandle+' '+item.expected:item.expected;
  assert.equal(submitted[0].body.text??submitted[0].body.initialMessage,submittedText,'Complete submitted body '+item.marker);
  if(item.kind.startsWith('queue')){
   const saved=state.queues[item.agentId],queue=Array.isArray(saved)?saved:saved.items??saved.messages,q=queue.find(q=>contains(q.text));
   assert.equal(q?.text,item.expected,'Complete canonical queue body');assert.equal(q.targetAgentId,item.agentId,'Exact queue recipient');
   equality.push({...item,status:'pass',submitted:submittedText,canonical:q.text});continue;
  }
  if(item.kind.startsWith('decision')||item.kind.startsWith('runtime-')){
   const decision=state.decisions[item.decisionId];assert.equal(decision.agentId,item.agentId,'Exact Decision owner');assert.equal(decision.response.text,item.expected,'Complete canonical Decision body');
   equality.push({...item,status:'pass',submitted:submittedText,canonical:decision.response.text});continue;
  }
  const canonical=journals.filter(r=>r.role==='user'&&contains(r.renderedText));assert.equal(canonical.length,1,'One canonical message '+item.marker);
  const expectedPrefix=item.kind==='chat'?'#broadcast ':item.kind.startsWith('call')?'':item.kind==='initial'?(submitted[0].body.managerAgentId?'':'#broadcast '):'#'+item.agentHandle+' ';
  if(item.kind==='chat')assert.equal(canonical[0].channel,'main','Exact shared Broadcast scope');
  if(item.kind==='initial')assert.equal(canonical[0].channel,submitted[0].body.managerAgentId?'collaboration':'main','Exact initial communication scope');
  assert.equal(canonical[0].renderedText,expectedPrefix+normalizeCanonicalText(item.expected),'Complete canonical body and routing prefix');
  assert.deepEqual(canonical[0].deliveryIntents.map(i=>i.targetAgentId),[item.kind==='initial'||item.kind==='chat'&&submitted[0].body.initialMessage?submitted[0].responseId:item.agentId],'Exact canonical recipient');
  equality.push({...item,status:'pass',submitted:submittedText,canonical:canonical[0].renderedText});
 }
 assert.ok(cases.length,'At least one actual input case must be present');
 await writeFile(path.join(output,'canonical-equality.json'),JSON.stringify(equality,null,2)+'\n');return equality;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){assert.ok(process.argv[2],'Supply a retained evidence directory');const result=await verifyChatInputEvidence(process.argv[2]);console.log('PASS '+result.length+' complete submitted/canonical bodies and recipients');}
