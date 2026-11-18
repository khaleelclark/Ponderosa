import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {withFixture} from '../shared/fixture.mjs';
import {validatePortableAgentPackage} from '../../apps/server/dist/portable-agent-package-validation.js';
const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},stamp='2026-11-03T00:00:00.000Z';
function node(ref,root,mode='shared',folder,files=[]){
 return {ref,title:ref,engine:'codex',managementPermissions:permissions,workingCopyMode:mode,workingRootRef:root,...(ref!=='parent'?{managerRef:'parent'}:{}),...(folder?{workingFolder:folder}:{}),workingFiles:files.map((file,i)=>({path:file.path,artifactRef:ref+'-file-'+i,mode:0o640,mtime:stamp})),artifacts:files.map((file,i)=>({ref:ref+'-file-'+i,kind:'document',path:file.path,createdAt:stamp,dataBase64:Buffer.from(file.data).toString('base64')}))};
}
const pkg=agents=>({schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:stamp,sourceLabel:'Exact generic live roots',rootRef:'parent',agents});
const folder=(excludedPaths=[],links=[])=>({directories:[],excludedPaths,links});
async function destination(f){const chat=await f.createChat('Unused live destination'),project=f.ok(await f.api('GET','/api/projects/'+chat.projectId));return {chat,project};}
async function imported(f,d,value,choices){return f.api('POST','/api/projects/'+d.project.id+'/import-agents',{package:value,conversationId:d.chat.id,engineMapping:{codex:'codex'},...choices},{'idempotency-key':randomUUID()});}
test('folder manifest and sole originals on different Agents populate their common live root once',{skip:process.platform==='win32'},async t=>withFixture(t,async f=>{
 const d=await destination(f),ref=randomUUID(),value=pkg([node('parent',ref,'shared',folder([],[{path:'alias',kind:'hardlink',target:'original'}])),node('files',ref,'shared',undefined,[{path:'original',data:'one exact original'}])]);
 assert.doesNotThrow(()=>validatePortableAgentPackage(value));
 const result=f.ok(await imported(f,d,value,{workingRootDestinations:{[ref]:path.join(f.root,'recover-one')},workingFilesActivation:{sharedRoot:d.project.hostPath}}));
 assert.equal(result.liveWorkingRoots.length,1);assert.equal(result.liveWorkingRoots[0].agentIds.length,2);assert.equal(await readFile(path.join(d.project.hostPath,'original'),'utf8'),'one exact original');
 assert.equal((await lstat(path.join(d.project.hostPath,'original'))).ino,(await lstat(path.join(d.project.hostPath,'alias'))).ino);
 await f.reopen();assert.equal(await readFile(path.join(d.project.hostPath,'alias'),'utf8'),'one exact original');
}));
for(const [parentMode,childMode] of [['shared','separate_git'],['separate_git','shared'],['separate_git','separate_git']])test('generic typed nesting preserves '+parentMode+' parent / '+childMode+' child exactly',{skip:process.platform==='win32'},async t=>withFixture(t,async f=>{
 const d=await destination(f),parent=randomUUID(),child=randomUUID(),value={...pkg([node('parent',parent,parentMode,folder(['child']),[{path:'parent.txt',data:'parent bytes'}]),node('child',child,childMode,folder([],[{path:'parent-alias',kind:'hardlink',target:'parent.txt',targetRootRef:parent}]),[{path:'child.txt',data:'child bytes'}])]),workingRootNesting:[{parentRootRef:parent,childRootRef:child,path:'child'}]};
 const recovery=path.join(f.root,'recover-parent'),choices={workingRootDestinations:{[parent]:recovery,[child]:path.join(recovery,'child')},workingFilesActivation:parentMode==='shared'||childMode==='shared'?{sharedRoot:d.project.hostPath}:{}};
 const result=f.ok(await imported(f,d,value,choices)),roots=Object.fromEntries(result.liveWorkingRoots.map(root=>[root.ref,root]));
 assert.equal(roots[child].path,path.join(roots[parent].path,'child'));assert.equal(await readFile(path.join(roots[child].path,'child.txt'),'utf8'),'child bytes');assert.equal((await lstat(path.join(roots[parent].path,'parent.txt'))).ino,(await lstat(path.join(roots[child].path,'parent-alias'))).ino);
 const agents=f.ok(await f.api('GET','/api/projects/'+d.project.id+'/agents'));
 for(const agent of agents){const expected=agent.id===result.rootAgentId?parentMode:childMode;assert.equal(agent.workingCopy.mode,expected);if(expected==='separate_git'){assert.equal(agent.workingCopy.state,'ready');assert.equal(agent.workingCopy.repositoryRoot,agent.workingCopy.rootPath);assert.equal(agent.workingCopy.branchOwned,true);}}
 if(childMode==='shared'){assert.equal(f.ok(await f.api('GET','/api/projects/'+d.project.id)).hostPath,roots[child].path);const replay=f.ok(await f.api('GET','/api/conversations/'+d.chat.id));assert.equal(replay.conversation?.workingDirectory??replay.workingDirectory,roots[child].path);}
 await f.reopen();assert.equal(await readFile(path.join(roots[child].path,'parent-alias'),'utf8'),'parent bytes');
}));
test('mode override cannot collapse distinct nested source roots and refusal precedes writes',async t=>withFixture(t,async f=>{
 const d=await destination(f),parent=randomUUID(),child=randomUUID(),value={...pkg([node('parent',parent,'shared',folder(['child'])),node('child',child,'separate_git',folder(),[{path:'child.txt',data:'child'}])]),workingRootNesting:[{parentRootRef:parent,childRootRef:child,path:'child'}]},recovery=path.join(f.root,'refused-recovery');
 const response=await imported(f,d,value,{workingCopyMode:'shared',workingRootDestinations:{[parent]:recovery,[child]:path.join(recovery,'child')},workingFilesActivation:{sharedRoot:d.project.hostPath}});
 assert.equal(response.status,400);assert.match(response.body.error,/Distinct source roots|membership/);await assert.rejects(lstat(recovery),error=>error.code==='ENOENT');
}));
test('nested exclusion validation aggregates original files even when folder owner differs',()=>{
 const parent=randomUUID(),child=randomUUID(),value={...pkg([node('parent',parent,'shared',folder(['child'])),node('files',parent,'shared',undefined,[{path:'child/overlap',data:'must refuse'}]),node('child',child,'separate_git',folder())]),workingRootNesting:[{parentRootRef:parent,childRootRef:child,path:'child'}]};
 assert.throws(()=>validatePortableAgentPackage(value),/excluded parent boundary|duplicate originals/);
});

test('legacy selected Shared folder receipt retains colocated no-data organization members',{skip:process.platform==='win32'},async t=>withFixture(t,async f=>{
 const d=await destination(f),value=pkg([node('parent','temporary','shared',folder(),[{path:'original',data:'legacy original'}]),node('child','temporary','shared')]);
 for(const agent of value.agents)delete agent.workingRootRef;
 const result=f.ok(await imported(f,d,value,{workingFilesDestination:path.join(f.root,'legacy-recovery'),workingFilesActivation:{sharedRoot:d.project.hostPath}}));
 assert.equal(result.liveWorkingRoots.length,1);assert.equal(result.liveWorkingRoots[0].agentIds.length,2);assert.equal(await readFile(path.join(d.project.hostPath,'original'),'utf8'),'legacy original');
}));
