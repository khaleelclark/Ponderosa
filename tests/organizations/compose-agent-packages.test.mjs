import test from 'node:test';
import assert from 'node:assert/strict';
import {composeAgentPackages} from '../../apps/server/dist/compose-agent-packages.js';
const definition=(title,body='same')=>({schema:'ponderosa.agent-package.v1',mode:'full',kind:'agent',exportedAt:'2026-01-01T00:00:00.000Z',sourceLabel:'Chat',rootRef:title,agents:[{ref:title,title,engine:'codex',workingCopyMode:'shared',sourceChat:{ref:'chat',title:'Chat'},managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},accessSettings:{restrictedCapabilityIds:[]},artifacts:[{ref:'same-ref',kind:'document',path:'file.txt',createdAt:'2026-01-01T00:00:00.000Z',dataBase64:Buffer.from(body).toString('base64')}],workingFiles:[{path:'file.txt',artifactRef:'same-ref'}],history:[{role:'assistant',text:'ponderosa://artifact/same-ref',attachmentRefs:['same-ref']}]}]});
test('composition namespaces repeated refs, preserves independent roots and Shared bytes without mutating inputs',async()=>{
  const inputs=[{ref:'first',package:definition('a')},{ref:'second',package:definition('b')}],original=structuredClone(inputs);
  const result=await composeAgentPackages(inputs);
  assert.deepEqual(inputs,original);assert.deepEqual(result.package.rootRefs,['first','second']);
  assert.deepEqual(result.orderedRefs,['first','second']);
  assert.notEqual(result.artifactRefs.first['same-ref'],result.artifactRefs.second['same-ref']);
  assert.equal(result.package.agents[0].workingRootRef,result.package.agents[1].workingRootRef);
  assert.equal(result.package.agents.filter(node=>node.workingFolder).length,1);
  for(const node of result.package.agents)assert.equal(node.history[0].text,`ponderosa://artifact/${node.history[0].attachmentRefs[0]}`);
  assert.deepEqual(await composeAgentPackages(inputs),result);
});
test('composition retains explicit manager edges and refuses conflicting source originals',async()=>{
  const inputs=[{ref:'first',package:definition('a')},{ref:'second',managerRef:'first',package:definition('b')}];
  const result=await composeAgentPackages(inputs);assert.equal(result.package.agents[1].managerRef,'first');assert.equal(result.package.rootRefs,undefined);
  inputs[1].package=definition('b','conflicting');
  await assert.rejects(composeAgentPackages(inputs),/Conflicting Shared working originals/);
});
test('composition deduplicates identical team memory and preserves separate private audiences',async()=>{
  const row=(id,audience)=>({id,text:id,metadata:{source_type:'user_statement',confidence:1,deprecated:false},embedding:[1,...Array(383).fill(0)],stamp:{format:1,principal:'operator',id,scope:'chat:chat',audience,ownerChat:'chat',sourceType:'user_statement',provenance:{actor:{kind:'user',id:'operator'},runId:'run',fenceToken:'fence',at:'2026-01-01T00:00:00.000Z'}}});
  const inputs=['a','b'].map(ref=>{const pkg=definition(ref);pkg.memory=[{snapshot:{schema:'ponderosa.chat-memory.v1',signature:'embedding-v1',sourceChatId:'chat',agentIds:[ref],excludedScopes:['global'],chunks:[row('team','chat:chat:team'),row('private-'+ref,'chat:chat:agent:'+ref)],conflicts:[]},agentRefs:{[ref]:ref}}];return {ref,package:pkg};});
  const result=await composeAgentPackages(inputs),memory=result.package.memory[0];
  assert.deepEqual(memory.agentRefs,{a:'a',b:'b'});assert.equal(memory.snapshot.chunks.length,3);
  assert.ok(memory.snapshot.chunks.some(row=>row.stamp.audience==='chat:chat:agent:a'));
  assert.ok(memory.snapshot.chunks.some(row=>row.stamp.audience==='chat:chat:agent:b'));
  inputs[1].package.memory[0].snapshot.chunks[0].text='different capture';
  await assert.rejects(composeAgentPackages(inputs),/Conflicting captured memory rows/);
});
