import assert from 'node:assert/strict';
import test from 'node:test';
import {composeBranchChat} from '../../apps/server/dist/branch-package-group.js';
import {composeAgentPackages} from '../../apps/server/dist/compose-agent-packages.js';
const compose=chat=>composeBranchChat(chat,{composeAgents:composeAgentPackages});
const exportedAt='2026-11-01T00:00:00.000Z';
function fixture(){
 const node=ref=>({ref,title:ref,engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingCopyMode:'shared',sourceChat:{ref:'source-chat',title:'Source'},workingFolder:{directories:[],excludedPaths:[]},workingFiles:[{path:'hello.txt',artifactRef:'same-original'}],artifacts:[{ref:'same-original',kind:'document',path:'hello.txt',createdAt:exportedAt,dataBase64:Buffer.from('hello').toString('base64')}],history:[{role:'user',text:'ponderosa://artifact/same-original',attachmentRefs:['same-original'],artifactRefs:{source:'same-original'}}]});
 const entry=(ref,managerRef)=>({ref,...(managerRef?{managerRef}:{}),definition:{schema:'ponderosa.agent-package.v1',kind:'agent',mode:'full',exportedAt,sourceLabel:ref,rootRef:ref,agents:[node(ref)]}});
 return{ref:'chat',title:'Grouped',agents:[entry('root'),entry('child','root')]};
}
test('group composition preserves authored hierarchy and history while deduplicating one Shared folder',async()=>{
 const source=fixture(),before=structuredClone(source),pkg=await compose(source);
 assert.deepEqual(source,before,'composition never rewrites source packages');
 assert.equal(pkg.kind,'organization');assert.equal(pkg.rootRef,'root');assert.equal(pkg.agents[1].managerRef,'root');
 assert.equal(pkg.agents[0].workingRootRef,pkg.agents[1].workingRootRef);
 assert.equal(pkg.agents.filter(a=>a.workingFolder).length,1);assert.equal(pkg.agents.filter(a=>a.workingFiles?.length).length,1);
 assert.equal(new Set(pkg.agents.flatMap(a=>a.artifacts.map(x=>x.ref))).size,2);
 for(const agent of pkg.agents){const ref=agent.artifacts[0].ref;assert.equal(agent.history[0].text,'ponderosa://artifact/'+ref);assert.deepEqual(agent.history[0].attachmentRefs,[ref]);assert.deepEqual(agent.history[0].artifactRefs,{source:ref});}
 assert.deepEqual(await compose(source),pkg,'review digest inputs are stable');
});
test('group composition refuses conflicting Shared bytes and preserves forest roots',async()=>{
 const changed=fixture();changed.agents[1].definition.agents[0].artifacts[0].dataBase64=Buffer.from('different').toString('base64');
 await assert.rejects(()=>compose(changed),/Conflicting Shared working originals/);
 const forest=fixture();delete forest.agents[1].managerRef;const pkg=await compose(forest);assert.deepEqual(pkg.rootRefs,['root','child']);assert.ok(pkg.agents.every(a=>!a.managerRef));assert.equal(pkg.agents[0].workingRootRef,pkg.agents[1].workingRootRef);
});
test('disjoint Shared selected files retain both historical originals and a dedicated folder copy',async()=>{
 const source=fixture();source.agents[1].definition.agents[0].workingFiles[0].path='other.txt';
 const pkg=await compose(source),root=pkg.agents[0],child=pkg.agents[1];
 assert.deepEqual(root.workingFiles.map(x=>x.path),['hello.txt','other.txt']);
 assert.notEqual(root.workingFiles[1].artifactRef,child.history[0].attachmentRefs[0]);
 assert.ok(root.artifacts.some(a=>a.ref===root.workingFiles[1].artifactRef));
});
