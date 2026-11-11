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

test('Shared composition preserves identical topology and rejects conflicting alias targets',async()=>{
  const inputs=['a','b'].map(ref=>{const pkg=definition(ref);pkg.agents[0].workingFolder={directories:[],excludedPaths:[],links:[{path:'alias',kind:'hardlink',target:'file.txt'},{path:'symbolic',kind:'symlink',target:'file.txt'}]};return {ref,package:pkg};});
  const result=await composeAgentPackages(inputs),owner=result.package.agents.find(node=>node.workingFolder);
  assert.equal(owner.workingFolder.links.length,2);
  assert.deepEqual(owner.workingFolder.links,inputs[0].package.agents[0].workingFolder.links);
  assert.equal(result.package.agents.filter(node=>node.workingFolder).length,1);
  inputs[1].package.agents[0].workingFolder.links[1].target='different';
  await assert.rejects(composeAgentPackages(inputs),/Conflicting captured Shared link topology/);
});


test('Shared composition compares exact originals across compressed and plain encodings',async()=>{
 const {encodePortableArtifactData,decodePortableArtifactData}=await import('../../apps/server/dist/agent-package-codec.js');
 const body='雪🌲 original working bytes'.repeat(10000),plain=definition('a',body),compressed=definition('b',body);
 Object.assign(compressed.agents[0].artifacts[0],await encodePortableArtifactData(Buffer.from(body)));
 assert.equal(compressed.agents[0].artifacts[0].dataEncoding,'gzip');
 const result=await composeAgentPackages([{ref:'first',package:plain},{ref:'second',package:compressed}]);
 const owner=result.package.agents.find(node=>node.workingFiles?.length);
 assert.equal(result.package.agents.flatMap(node=>node.workingFiles??[]).length,1);
 const original=owner.artifacts.find(artifact=>artifact.ref===owner.workingFiles[0].artifactRef);
 assert.deepEqual((await decodePortableArtifactData(original)).data,Buffer.from(body));
});

test('Shared composition keeps one verified multipart working original and rejects a conflicting one',async()=>{
 const {createHash}=await import('node:crypto');
 const {encodePortableArtifactData,decodePortableArtifactData}=await import('../../apps/server/dist/agent-package-codec.js');
 const {WORKING_FILE_PART_MEDIA_TYPE}=await import('../../packages/core/dist/index.js');
 const size=32*1024*1024,first=Buffer.alloc(size,0x00),second=Buffer.alloc(size,0x62),last=Buffer.from('x');
 const sha=chunks=>{const hash=createHash('sha256');for(const chunk of chunks)hash.update(chunk);return hash.digest('hex');};
 const packageFor=async(title,chunks)=>{
  const value=definition(title),node=value.agents[0],refs=chunks.map((_,index)=>title+'-part-'+index),bytes=chunks.reduce((total,chunk)=>total+chunk.length,0);
  node.artifacts.push(...await Promise.all(chunks.map(async(chunk,index)=>({ref:refs[index],kind:'document',path:'portable-working-part/'+refs[index],
   summary:'Transport part '+(index+1)+' of '+chunks.length+' for working file large.bin; not a complete file',
   createdAt:value.exportedAt,mediaType:WORKING_FILE_PART_MEDIA_TYPE,...await encodePortableArtifactData(chunk)}))));
  node.workingFiles=[{path:'large.bin',artifactRef:refs[0],mode:0o640,mtime:'2026-01-01T00:00:00.000Z',
   parts:{schema:'ponderosa.working-file-parts.v1',refs,byteLength:bytes,sha256:sha(chunks)}}];
  return value;
 };
 const input=[{ref:'first',package:await packageFor('a',[first,second,last])},{ref:'second',package:await packageFor('b',[first,second,last])}];
 const original=structuredClone(input),result=await composeAgentPackages(input);
 assert.deepEqual(input,original,'composition never mutates source packages');
 const owners=result.package.agents.filter(node=>node.workingFolder),owner=owners[0];
 assert.equal(owners.length,1,'the shared root has one owner');
 assert.equal(owner.workingFiles.length,1,'the path remains one logical file');
 const file=owner.workingFiles[0],parts=file.parts.refs;
 assert.equal(file.path,'large.bin');assert.equal(file.artifactRef,parts[0]);assert.equal(parts.length,3);
 assert.equal(file.parts.byteLength,2*size+1);assert.equal(file.parts.sha256,sha([first,second,last]));
 const transport=result.package.agents.flatMap(node=>(node.artifacts??[]).filter(item=>item.mediaType===WORKING_FILE_PART_MEDIA_TYPE));
 assert.equal(transport.length,3,'exactly one set of parts survives deduplication');
 assert.deepEqual(transport.map(item=>item.ref).sort(),[...parts].sort(),'all parts belong to the selected original');
 assert.ok(result.package.agents.filter(node=>node!==owner).every(node=>(node.artifacts??[]).every(item=>item.mediaType!==WORKING_FILE_PART_MEDIA_TYPE)));
 for(const [index,ref] of parts.entries()){
  const item=owner.artifacts.find(item=>item.ref===ref);assert.ok(item);
  assert.deepEqual((await decodePortableArtifactData(item)).data,[first,second,last][index]);
 }
 for(const item of input)for(const ref of item.package.agents[0].workingFiles[0].parts.refs)
  assert.equal(result.artifactRefs[item.ref][ref],undefined,'transport parts are not public artifact mappings');
 assert.ok(result.artifactRefs.first['same-ref']&&result.artifactRefs.second['same-ref'],'ordinary artifact mappings survive');
 const different=await packageFor('b',[first,second,Buffer.from('y')]);
 await assert.rejects(composeAgentPackages([input[0],{ref:'second',package:different}]),/Conflicting Shared working originals/);
 assert.deepEqual(input,original,'conflict refusal preserves both source packages');
});
