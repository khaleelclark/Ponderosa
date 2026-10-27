import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {portableBase64ByteLength,decodePortableArtifact,portablePackageJsonChunks} from '../../apps/server/dist/agent-package-codec.js';
import {MANAGED_ARTIFACT_MAX_BYTES} from '@ponderosa/agents';
import {AGENT_PACKAGE_MAX_AGENTS,AGENT_PACKAGE_MAX_BYTES,agentPackageJsonPieces,agentPackageJsonUtf8Bytes} from '@ponderosa/core';
import {validatePortableAgentPackage} from '../../apps/server/dist/portable-agent-package-validation.js';
import {AgentManagementAuthority} from '../../packages/agents/dist/store-agent-management-authority.js';

const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
const packageFor=(count=1)=>({schema:'ponderosa.agent-package.v1',mode:'full',kind:count===1?'agent':'organization',exportedAt:'2026-10-27T00:00:00Z',sourceLabel:'Complete portable conversation',rootRef:'a0',agents:Array.from({length:count},(_,i)=>({ref:`a${i}`,title:`Agent ${i}`,engine:'codex',managementPermissions:permissions,...(i?{managerRef:`a${i-1}`}:{})}))});

test('package preview sizes agree with actual artifact decoding across padding and chunk boundaries',async()=>{
 for(const size of [0,1,2,3,4,5,6,31,196607,196608,196609,393217]){
  const bytes=randomBytes(size),encoded=bytes.toString('base64');
  for(const value of new Set([encoded,encoded.replace(/=+$/u,'')])){
   assert.equal(portableBase64ByteLength(value),size);
   assert.deepEqual((await decodePortableArtifact(value)).data,bytes);
  }
 }
});

test('preview and import agree at the managed-file ceiling including base64 rounding',async()=>{
 for(const extra of [0,1,2,3]){
  const size=MANAGED_ARTIFACT_MAX_BYTES+extra,encoded=Buffer.alloc(size).toString('base64');
  for(const value of new Set([encoded,encoded.replace(/=+$/u,'')])){
   if(extra===0){assert.equal(portableBase64ByteLength(value),size);assert.equal((await decodePortableArtifact(value)).data.length,size)}
   else{assert.throws(()=>portableBase64ByteLength(value),/64 MiB/);await assert.rejects(decodePortableArtifact(value),/64 MiB/)}
  }
 }
});

test('preview validation rejects illegal padding, alphabet and nonzero unused bits before displaying a size',async()=>{
 for(const value of ['A','AB','ABC','AAB','AAAAAB','AAB=','AA===','AA A','AA\n','AAAA-','A=AA','====']){
  assert.throws(()=>portableBase64ByteLength(value),/invalid base64/);
  await assert.rejects(decodePortableArtifact(value),/invalid base64/);
 }
});

test('package serialization and admission preserve UTF-8 bytes, JSON escaping and surrogate boundaries',async()=>{
 const pkg=packageFor(),text='雪\r\n"\\\u0000'+'x'.repeat(32761)+'🌲'+'TRAILING_MARKER';
 pkg.agents[0].initialInstructions=text;
 pkg.agents[0].history=[{role:'user',text,createdAt:'2026-10-27T02:00:00+02:00'},{role:'user',text}];
 const expected=JSON.stringify(pkg),chunks=[];for await(const chunk of portablePackageJsonChunks(pkg))chunks.push(chunk);
 assert.equal(chunks.join(''),expected);assert.equal([...agentPackageJsonPieces(pkg)].join(''),expected);
 assert.equal(agentPackageJsonUtf8Bytes(pkg),Buffer.byteLength(expected));
 assert.equal(validatePortableAgentPackage(pkg).package,pkg);
});

test('portable text rejects malformed UTF-16 while preserving all well-formed Unicode',()=>{
 for(const text of ['\ud800','\udfff','x\ud800y']){
  const pkg=packageFor();pkg.agents[0].initialInstructions=text;
  assert.throws(()=>validatePortableAgentPackage(pkg),/well-formed Unicode/u);
  delete pkg.agents[0].initialInstructions;pkg.agents[0].history=[{role:'user',text}];
  assert.throws(()=>validatePortableAgentPackage(pkg),/well-formed Unicode/u);
 }
});

test('the one shared Agent ceiling admits 101 and 10000 with deep topology and rejects 10001 whole',()=>{
 for(const count of [101,AGENT_PACKAGE_MAX_AGENTS]){
  const pkg=packageFor(count);pkg.agents.reverse();assert.equal(validatePortableAgentPackage(pkg).package.agents.length,count);
 }
 assert.throws(()=>validatePortableAgentPackage(packageFor(AGENT_PACKAGE_MAX_AGENTS+1)),error=>error.statusCode===413&&/10001.*10000/u.test(error.message));
 const cycle=packageFor(AGENT_PACKAGE_MAX_AGENTS);cycle.agents.at(-2).managerRef=cycle.agents.at(-1).ref;
 assert.throws(()=>validatePortableAgentPackage(cycle),/reachable/u);
});

test('text-only packages use the actual 256 MiB UTF-8 boundary without full JSON allocation',async()=>{
 const pkg=packageFor(),text='雪'.repeat(64*1024),history=Array.from({length:1300},()=>({role:'user',text}));
 history.push({role:'user',text:''});pkg.agents[0].history=history;
 history.at(-1).text='x'.repeat(AGENT_PACKAGE_MAX_BYTES-agentPackageJsonUtf8Bytes(pkg));
 assert.equal(agentPackageJsonUtf8Bytes(pkg),AGENT_PACKAGE_MAX_BYTES);
 assert.equal(validatePortableAgentPackage(pkg).package,pkg);
 let serializedBytes=0;for await(const chunk of portablePackageJsonChunks(pkg))serializedBytes+=Buffer.byteLength(chunk);
 assert.equal(serializedBytes,AGENT_PACKAGE_MAX_BYTES);
 history.at(-1).text+='🌲';
 assert.throws(()=>validatePortableAgentPackage(pkg),error=>error.statusCode===413&&/256 MiB/u.test(error.message));
 await assert.rejects(async()=>{for await(const _chunk of portablePackageJsonChunks(pkg)){/* consume admitted batches */}},/256 MiB/u);
});

test('package admission retains the 128 MiB decoded aggregate artifact boundary',()=>{
 const pkg=packageFor(),dataBase64=Buffer.alloc(MANAGED_ARTIFACT_MAX_BYTES).toString('base64');
 pkg.agents[0].artifacts=['one','two'].map(ref=>({ref,kind:'document',path:`${ref}.txt`,createdAt:'2026-10-27T00:00:00Z',dataBase64}));
 assert.equal(validatePortableAgentPackage(pkg).totalArtifactBytes,128*1024*1024);
 pkg.agents[0].artifacts.push({ref:'three',kind:'document',path:'three.txt',createdAt:'2026-10-27T00:00:00Z',dataBase64:'eA=='});
 assert.throws(()=>validatePortableAgentPackage(pkg),error=>error.statusCode===413&&/128 MiB/u.test(error.message));
});

test('subtree traversal stays iterative and preserves order for deep and wide 10000-Agent organizations',()=>{
 for(const shape of ['deep','wide']){
  const nodes=Array.from({length:AGENT_PACKAGE_MAX_AGENTS},(_,i)=>({id:`a${i}`,projectId:'project',...(i?{managerAgentId:`a${shape==='deep'?i-1:0}`}:{})})),byId=new Map(nodes.map(node=>[node.id,node]));
  const owner={getAgent:id=>byId.get(id),listAgents:()=>nodes};
  assert.deepEqual(AgentManagementAuthority.prototype.listAgentSubtree.call(owner,'a0').map(node=>node.id),nodes.map(node=>node.id));
 }
});

test('browser preview uses the same count ceiling and keeps complete counts',async()=>{
 const prior=globalThis.self,messages=[];globalThis.self={postMessage:message=>messages.push(message)};
 try{
  await import('../../apps/web/src/components/agent-package-preview.worker.ts');
  for(const count of [101,AGENT_PACKAGE_MAX_AGENTS,AGENT_PACKAGE_MAX_AGENTS+1]){
   messages.length=0;const pkg=packageFor(count);
   await globalThis.self.onmessage({data:{id:count,blob:new Blob([JSON.stringify(pkg)])}});
   const result=messages.at(-1);
   if(count<=AGENT_PACKAGE_MAX_AGENTS){assert.equal(result.preview.agentCount,count);assert.equal(result.preview.agentTitles.length,count)}
   else assert.match(result.error,/10001.*10000/u);
  }
  for(const field of ['initialInstructions','history']){
   const pkg=packageFor();pkg.agents[0][field]=field==='history'?[{role:'user',text:'\ud800'}]:'\udfff';
   await globalThis.self.onmessage({data:{id:1,blob:new Blob([JSON.stringify(pkg)])}});
   assert.match(messages.at(-1).error,/well-formed Unicode/u);
  }
 }finally{if(prior===undefined)delete globalThis.self;else globalThis.self=prior}
});

test('external conversion guidance requests complete transcript text under the shared byte ceiling',async()=>{
 const {externalAgentImportPrompt}=await import('../../apps/web/src/components/externalAgentImportPrompt.ts');
 const prompt=externalAgentImportPrompt('2026-10-27T00:00:00Z');
 assert.match(prompt,/complete original conversation/u);assert.match(prompt,/256 MiB of UTF-8 bytes/u);
 assert.doesNotMatch(prompt,/100,?000|single message exceeds/u);
 assert.match(prompt,/hidden system\/developer prompts/u);assert.match(prompt,/do not.*partial package/iu);
});
