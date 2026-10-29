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
  const expectedPrefix=item.kind.startsWith('call')?'':item.kind==='initial'?(submitted[0].body.managerAgentId?'':'#broadcast '):'#'+item.agentHandle+' ';
  if(item.kind==='initial')assert.equal(canonical[0].channel,submitted[0].body.managerAgentId?'collaboration':'main','Exact initial communication scope');
  assert.equal(canonical[0].renderedText,expectedPrefix+item.expected,'Complete canonical body and routing prefix');
  assert.deepEqual(canonical[0].deliveryIntents.map(i=>i.targetAgentId),[item.kind==='initial'?submitted[0].responseId:item.agentId],'Exact canonical recipient');
  equality.push({...item,status:'pass',submitted:submittedText,canonical:canonical[0].renderedText});
 }
 assert.ok(cases.length,'At least one actual input case must be present');
 await writeFile(path.join(output,'canonical-equality.json'),JSON.stringify(equality,null,2)+'\n');return equality;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){assert.ok(process.argv[2],'Supply a retained evidence directory');const result=await verifyChatInputEvidence(process.argv[2]);console.log('PASS '+result.length+' complete submitted/canonical bodies and recipients');}
