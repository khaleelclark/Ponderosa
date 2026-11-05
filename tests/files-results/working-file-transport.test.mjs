import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore,makeWorkingFileTransportPart} from '../../packages/agents/dist/index.js';

test('host-issued complete working-file parts stay internal but retained for export and cleanup',t=>{
 const root=mkdtempSync(join(tmpdir(),'working-part-catalog-'));
 let store=new AgentStore(root);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const project=store.createProject({label:'Parts',hostPath:root,defaultEngine:'codex',chatOwned:true});
 const agent=store.createAgent(project.id,{conversationId:project.lastConversationId,title:'Owner',engine:'codex'});
 const file={path:'large.bin',parts:{schema:'ponderosa.working-file-parts.v1',refs:['part-1','part-2'],byteLength:64*1024*1024+2,sha256:'a'.repeat(64)}};
 const artifact=(id,size)=>({id,projectId:project.id,agentId:agent.id,originAgentId:agent.id,kind:'document',path:'imported/'+id,summary:id,createdAt:'2026-11-05T00:00:00.000Z',mediaType:'application/vnd.ponderosa.working-file-part.v1',visibility:'project',pinned:true,size,sha256:'b'.repeat(64)});
 const parts=[artifact('part-1',32*1024*1024+1),artifact('part-2',32*1024*1024+1)];
 const marked=parts.map((item,index)=>({artifact:item,transportPart:makeWorkingFileTransportPart(file,index,'operation-1')}));
 assert.throws(()=>store.recordProjectArtifacts(marked.slice(0,1)),/Incomplete working-file transport association/);
 store.recordProjectArtifacts(marked);
 const ordinary={...artifact('ordinary',3),mediaType:'application/vnd.ponderosa.working-file-part.v1'};
 store.recordProjectArtifact(ordinary);
 assert.deepEqual(store.getProjectArtifacts(project.id).map(a=>a.id).sort(),['ordinary','part-1','part-2']);
 assert.deepEqual(store.getProjectArtifactPage(project.id,{limit:50}).items.map(a=>a.id),['ordinary'],'ordinary user media type remains visible');
 assert.deepEqual(store.getProjectContextArtifacts(project.id).map(a=>a.id),['ordinary']);
 for(const id of ['part-1','part-2']){
  assert.equal(store.isWorkingFileTransportPart(project.id,id),true);
  assert.equal(store.projectArtifactIsOrganizationVisible(project.id,id),false);
  assert.equal(store.operatorCanReadProjectArtifact(project.id,id),false);
  assert.equal(store.agentCanReadProjectArtifact(project.id,id,agent.id),false);
 }
 assert.equal(store.projectArtifactIsOrganizationVisible(project.id,'ordinary'),true);
 store.recordProjectArtifacts(marked);
 const changed=structuredClone(marked);changed.forEach(entry=>entry.transportPart.fileSha256='c'.repeat(64));
 assert.throws(()=>store.recordProjectArtifacts(changed),/immutable/);
 assert.throws(()=>store.recordProjectArtifacts([{artifact:{...ordinary,transportPart:marked[0].transportPart}}]),/Invalid host/);
 store.close();store=new AgentStore(root);
 assert.deepEqual(store.getProjectArtifactPage(project.id,{limit:50}).items.map(a=>a.id),['ordinary']);
 assert.deepEqual(store.getProjectArtifacts(project.id).map(a=>a.id).sort(),['ordinary','part-1','part-2']);
});
