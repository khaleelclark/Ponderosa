import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,chmod,lstat,realpath,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {mkdirSync,renameSync} from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {exportReviewedUserData,createGitExportCapture,createReviewedNativeGit} from '../../apps/server/dist/portable-reviewed-user-data.js';
import {planReviewedRecoveryRoots,applyReviewedRecoveryRoots} from '../../apps/server/dist/portable-git-recreation.js';
import {AgentStore} from '@ponderosa/agents';
import {AgentWorkingCopyService} from '../../apps/server/dist/agent-working-copy-service.js';

const exec=promisify(execFile);
const git=async(cwd,...args)=>(await exec('git',['--no-optional-locks',...args],{cwd,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();
const packageFor=(manifest,files={},bindings)=>{
  const entries={[".ponderosa-portable-review/user-data.json"]:JSON.stringify(manifest),...files};
  return {schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Git recreation regression',rootRef:'agent',agents:[{ref:'agent',title:'Agent',engine:'codex',workingRootRef:'work',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingFolder:{directories:[],excludedPaths:['.git']},workingFiles:Object.keys(entries).map((name,i)=>({path:name,artifactRef:'file-'+i})),artifacts:Object.entries(entries).map(([name,data],i)=>({ref:'file-'+i,kind:'generated_file',path:name,createdAt:new Date().toISOString(),dataBase64:Buffer.from(data).toString('base64')}))},...(bindings?[{ref:'storage-agent',title:'Storage',engine:'codex',workingRootRef:'storage',managerRef:'agent',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingFolder:{directories:[],excludedPaths:['.']},workingFiles:[]}]:[])],...(bindings?{gitStorageBindings:bindings}:{})};
};
async function initialize(root){await mkdir(root);await git(root,'init','--template=','--initial-branch=main');await git(root,'config','user.name','Portable Test');await git(root,'config','user.email','portable@example.invalid');await writeFile(path.join(root,'file.txt'),'committed\n');await git(root,'add','file.txt');await git(root,'commit','--no-gpg-sign','-m','Initial');}

test('fresh recovery preserves staged work, activates hook metadata and recursively relocates included configuration without running hooks',{skip:process.platform==='win32'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-git-recovery-'));
  try{
    const source=path.join(root,'source'),destination=path.join(root,'destination'),external=path.join(root,'external'),support=path.join(root,'support');await initialize(source);await mkdir(external);
    await writeFile(path.join(source,'file.txt'),'staged\n');await git(source,'add','file.txt');await writeFile(path.join(source,'file.txt'),'working\n');
    const outer='[include]\n path = nested.conf\n[portable]\n outer = yes\n',nested='[portable]\n leaf = retained\n';
    await writeFile(path.join(external,'outer.conf'),outer);await writeFile(path.join(external,'nested.conf'),nested);
    await git(source,'config','include.path',path.join(external,'outer.conf'));
    const hook=path.join(source,'.git','hooks','pre-commit');await mkdir(path.dirname(hook));await writeFile(hook,'#!/bin/sh\ntouch '+JSON.stringify(path.join(root,'hook-ran'))+'\n');await chmod(hook,0o751);
    const manifest=await exportReviewedUserData(source,{git:true,harness:false});
    const pkg=packageFor(manifest,{'file.txt':'working\n'});
    pkg.agents.push({ref:'support-agent',title:'Configuration originals',engine:'codex',managerRef:'agent',workingRootRef:'support',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingFolder:{directories:[],excludedPaths:[]},workingFiles:[{path:'outer.conf',artifactRef:'outer'},{path:'nested.conf',artifactRef:'nested'}],artifacts:[{ref:'outer',kind:'generated_file',path:'outer.conf',createdAt:new Date().toISOString(),dataBase64:Buffer.from(outer).toString('base64')},{ref:'nested',kind:'generated_file',path:'nested.conf',createdAt:new Date().toISOString(),dataBase64:Buffer.from(nested).toString('base64')}]});
    await mkdir(destination);await mkdir(support);await writeFile(path.join(destination,'file.txt'),'working\n');for(const [name,data] of Object.entries({'outer.conf':outer,'nested.conf':nested}))await writeFile(path.join(support,name),data);
    const activation={git:true,harness:false,gitPathMappings:[{source,destination},{source:external,destination:support}]},receipts=[];
    const tasks=planReviewedRecoveryRoots(pkg,{work:destination,support},activation);
    assert.equal(tasks.length,1,'supporting file roots never become invented Git repositories');
    await applyReviewedRecoveryRoots(tasks,activation,receipt=>receipts.push(structuredClone(receipt)));
    assert.equal(await git(destination,'config','--get','portable.leaf'),'retained');
    assert.equal(await git(destination,'config','--get','portable.outer'),'yes');
    assert.equal(await git(destination,'show',':file.txt'),'staged');assert.equal(await readFile(path.join(destination,'file.txt'),'utf8'),'working\n');
    assert.equal((await lstat(path.join(destination,'.git','hooks','pre-commit'))).mode&0o777,0o751);
    assert.equal(await readFile(path.join(support,'outer.conf'),'utf8'),outer,'source include originals remain unchanged');
    await assert.rejects(lstat(path.join(root,'hook-ran')),{code:'ENOENT'});
    assert.deepEqual(receipts.map(receipt=>receipt.state),['applying','completed']);
    await assert.rejects(applyReviewedRecoveryRoots(tasks,activation,()=>{}),/already has native Git/);
    const missing=structuredClone(pkg);missing.agents[1].workingFiles=missing.agents[1].workingFiles.filter(file=>file.path!=='nested.conf');
    assert.throws(()=>planReviewedRecoveryRoots(missing,{work:destination,support},activation),/Include the configured Git file/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('native recreation retains initialized and deinitialized module repositories with fresh worktree pointers',{skip:process.platform==='win32'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-native-modules-'));
  try{
    const child=path.join(root,'child'),source=path.join(root,'source');await initialize(child);await initialize(source);
    await git(source,'-c','protocol.file.allow=always','submodule','add',child,'module');
    await git(source,'config','-f','.gitmodules','submodule.module.url','https://example.invalid/module');await git(source,'config','submodule.module.url','https://example.invalid/module');await git(path.join(source,'module'),'remote','set-url','origin','https://example.invalid/module');
    await git(source,'add','.gitmodules','module');await git(source,'commit','--no-gpg-sign','-m','Add module');
    await writeFile(path.join(source,'module','file.txt'),'uncommitted module work\n');
    const childHead=await git(path.join(source,'module'),'rev-parse','HEAD'),gitmodules=await readFile(path.join(source,'.gitmodules'),'utf8');
    const manifest=await exportReviewedUserData(source,{git:true,harness:false});assert.equal(manifest.git.modules[0].source.initialized,true);
    const destination=path.join(root,'new');await mkdir(destination);await mkdir(path.join(destination,'module'));await writeFile(path.join(destination,'file.txt'),'committed\n');await writeFile(path.join(destination,'.gitmodules'),gitmodules);await writeFile(path.join(destination,'module','file.txt'),'uncommitted module work\n');
    const pkg=packageFor(manifest,{'file.txt':'committed\n','.gitmodules':gitmodules,'module/file.txt':'uncommitted module work\n'}),activation={git:true,harness:false};
    const tasks=planReviewedRecoveryRoots(pkg,{work:destination},activation);await applyReviewedRecoveryRoots(tasks,activation,()=>{});
    assert.equal(await git(path.join(destination,'module'),'rev-parse','HEAD'),childHead);
    assert.equal(await git(path.join(destination,'module'),'rev-parse','--show-toplevel'),path.join(destination,'module'));
    assert.equal(await readFile(path.join(destination,'module','file.txt'),'utf8'),'uncommitted module work\n');
    assert.equal(await readFile(path.join(destination,'module','.git'),'utf8'),'gitdir: ../.git/modules/module\n');
    assert.equal(await git(path.join(destination,'module'),'status','--porcelain=v1'),'M file.txt');
    await git(source,'submodule','deinit','-f','module');
    const inactive=await exportReviewedUserData(source,{git:true,harness:false});assert.equal(inactive.git.modules[0].source.initialized,false);
    const recovery=path.join(root,'inactive');await mkdir(recovery);await mkdir(path.join(recovery,'module'));await writeFile(path.join(recovery,'file.txt'),'committed\n');await writeFile(path.join(recovery,'.gitmodules'),gitmodules);
    await applyReviewedRecoveryRoots(planReviewedRecoveryRoots(packageFor(inactive,{'file.txt':'committed\n','.gitmodules':gitmodules}),{work:recovery},activation),activation,()=>{});
    await assert.rejects(lstat(path.join(recovery,'module','.git')),{code:'ENOENT'});
    assert.equal(await git(recovery,'--git-dir='+path.join(recovery,'.git','modules','module'),'rev-parse','HEAD'),childHead);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a native failure keeps its exact cause when persisting the incomplete receipt also fails',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-git-receipt-'));
  try{
    const source=path.join(root,'source'),destination=path.join(root,'destination');await initialize(source);await mkdir(destination);
    const manifest=await exportReviewedUserData(source,{git:true,harness:false}),pkg=packageFor(manifest,{'file.txt':'committed\n'}),activation={git:true,harness:false};
    const tasks=planReviewedRecoveryRoots(pkg,{work:destination},activation),receipts=[];
    // Simulate an independent destination collision after the preflight, then a storage outage.
    const {mkdirSync}=await import('node:fs');
    await assert.rejects(applyReviewedRecoveryRoots(tasks,activation,receipt=>{
      receipts.push(structuredClone(receipt));
      if(receipt.state==='applying')mkdirSync(path.join(destination,'.git'));
      if(receipt.state==='incomplete')throw new Error('receipt database offline');
    }),error=>error.code==='EEXIST'&&/EEXIST/.test(error.message)&&/receipt database offline/.test(error.message));
    assert.equal(receipts.at(-1).error.code,'EEXIST');assert.match(receipts.at(-1).error.message,/EEXIST/);
    assert.equal((await lstat(path.join(destination,'.git'))).isDirectory(),true,'partial destination preserved');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('mapped common/private recreation rewrites destination pointers and does not adopt source ownership', {skip:process.platform!=='linux'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-mapped-git-')),handles=[];
  let capture;
  try{
    const source=path.join(root,'source'),linked=path.join(root,'linked');await initialize(source);await git(source,'worktree','add','-b','linked',linked);
    await writeFile(path.join(linked,'file.txt'),'selected working tree\n');
    const common=path.join(source,'.git'),privateDir=path.join(common,'worktrees','linked');
    const roots=[];for(const [pathname,ref] of [[linked,'work'],[common,'storage']]){const handle=await open(pathname,'r');handles.push(handle);roots.push({pathname,ref,handle,owner:(await handle.stat({bigint:true})).uid});}
    const bindings=[{id:'common',worktreeRootRef:'work',storageRootRef:'storage',relativePath:'.',role:'common',worktreePath:linked,storagePath:common},{id:'private',worktreeRootRef:'work',storageRootRef:'storage',relativePath:'worktrees/linked',role:'private',worktreePath:linked,storagePath:common}];
    capture=createGitExportCapture(roots,bindings);
    const manifest=await exportReviewedUserData(linked,{git:true,harness:false},capture),data=Buffer.from(JSON.stringify(manifest));capture.bindReview(linked,data);
    const portable=capture.portableBindings(),pkg=packageFor(manifest,{'file.txt':'selected working tree\n'},portable);
    const work=path.join(root,'new-work'),storage=path.join(root,'new-storage');await mkdir(work);await mkdir(storage);await writeFile(path.join(work,'file.txt'),'selected working tree\n');
    const tasks=planReviewedRecoveryRoots(pkg,{work,storage},{git:true,harness:false});
    await applyReviewedRecoveryRoots(tasks,{git:true,harness:false},()=>{});
    assert.equal(await git(work,'branch','--show-current'),'linked');
    const gitDir=await git(work,'rev-parse','--absolute-git-dir');assert.equal(await realpath(gitDir),path.join(storage,'worktrees','linked'));
    assert.equal(await git(work,'config','--get','core.worktree'),work);
    assert.equal(await readFile(path.join(work,'.git'),'utf8'),'gitdir: ../new-storage/worktrees/linked\n');
    assert.equal(await readFile(path.join(storage,'worktrees','linked','gitdir'),'utf8'),'../../../new-work/.git\n');
    assert.equal(await git(linked,'rev-parse','--absolute-git-dir'),privateDir,'source registration unchanged');
    assert.equal(await readFile(path.join(work,'file.txt'),'utf8'),'selected working tree\n');
  }finally{await capture?.close();for(const handle of handles)await handle.close();await rm(root,{recursive:true,force:true});}
});

test('native Separate import owns a fresh independent repository, preserves staged state and leaves destination Shared unchanged',async()=>{
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-owned-separate-')));let store;
 try{
  const source=path.join(base,'source'),shared=path.join(base,'shared'),data=path.join(base,'data'),moduleSource=path.join(base,'module-source');
  await initialize(source);await initialize(shared);await initialize(moduleSource);await mkdir(data);
  await git(source,'-c','protocol.file.allow=always','submodule','add',moduleSource,'child');await git(source,'commit','--no-gpg-sign','-m','Add initialized child');
  await writeFile(path.join(source,'file.txt'),'source staged\n');await git(source,'add','file.txt');await writeFile(path.join(source,'file.txt'),'source working\n');
  await git(source,'tag','retained-source-tag');
  const manifest=await exportReviewedUserData(source,{git:true,harness:false}),pkg=packageFor(manifest,{'file.txt':'source working\n','.gitmodules':await readFile(path.join(source,'.gitmodules'),'utf8'),'child/file.txt':await readFile(path.join(source,'child','file.txt'),'utf8')});
  const oldHead=await git(shared,'rev-parse','HEAD'),oldConfig=await readFile(path.join(shared,'.git','config')),oldIndex=await readFile(path.join(shared,'.git','index'));
  store=new AgentStore(data);const project=store.createProject({label:'Existing Shared',hostPath:shared,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Imported Separate'});
  const agent=store.createAgent(project.id,{title:'Imported owner',engine:'codex',conversationId:chat.id}),service=new AgentWorkingCopyService(data,store);
  let imported;let release=service.beginModeChange(agent.id);
  try{imported=await service.allocateImportedSeparateGit(agent,project);}finally{release();}
  assert.equal(imported.workingCopy.state,'unavailable');assert.equal(imported.workingCopy.repositoryRoot,imported.workingCopy.rootPath);
  release=service.beginModeChange(agent.id);
  try{await assert.rejects(service.setMode(imported,project,'separate_git'),/exact import operation/);}
  finally{release();}
  assert.equal(store.getAgent(agent.id).workingCopy.repositoryRoot,imported.workingCopy.rootPath,'Generic Retry cannot replace independent ownership with Shared authority');
  const files=pkg.agents[0].workingFiles.map(file=>{const artifact=pkg.agents[0].artifacts.find(artifact=>artifact.ref===file.artifactRef),bytes=Buffer.from(artifact.dataBase64,'base64');return {path:file.path,data:bytes,sha256:createHash('sha256').update(bytes).digest('hex')};});
  release=service.beginModeChange(agent.id);
  try{
   const issued=await service.populateImportedRoot(imported,project,files,[],undefined,path.join(imported.workingCopy.rootPath,'.ponderosa-import-backups'),[],'refuse',{git:true,harness:false});
   const {lstat}=await import('node:fs/promises'),copied=await lstat(imported.workingCopy.rootPath,{bigint:true});
   assert.deepEqual(issued,{device:copied.dev.toString(),inode:copied.ino.toString()},'The working-copy service forwards the exact populated-root identity');
   const receipts=[];
   await service.completeImportedGitRoots(project,pkg,{work:imported.workingCopy.rootPath},{git:true,harness:false},receipt=>receipts.push(structuredClone(receipt)),[agent.id]);
   assert.equal(receipts.at(-1).state,'completed');
  }finally{release();}
  const ready=store.getAgent(agent.id),resolved=await service.resolve(ready,project);
  assert.equal(ready.workingCopy.state,'ready');assert.equal(ready.workingCopy.branchOwned,true);
  assert.match(await git(resolved.rootPath,'branch','--show-current'),/^ponderosa\//);
  assert.equal(await git(resolved.rootPath,'show',':file.txt'),'source staged');
  assert.equal(await readFile(path.join(resolved.rootPath,'file.txt'),'utf8'),'source working\n');
  assert.equal(await git(resolved.rootPath,'rev-parse','refs/tags/retained-source-tag'),await git(source,'rev-parse','refs/tags/retained-source-tag'));
  assert.equal(await git(shared,'rev-parse','HEAD'),oldHead);assert.deepEqual(await readFile(path.join(shared,'.git','config')),oldConfig);assert.deepEqual(await readFile(path.join(shared,'.git','index')),oldIndex);
  const childPointer=path.join(resolved.rootPath,'child','.git'),originalPointer=await readFile(childPointer);
  await writeFile(childPointer,'gitdir: /unselected/outside/repository\n');
  await assert.rejects(service.verifyImportedGitRoot(project,createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),resolved.rootPath),/differs/,'Native ownership proof must detect a replaced child .git pointer outside the parent Git directory');
  await writeFile(childPointer,originalPointer);
  const preservedIndex=await readFile(path.resolve(resolved.rootPath,await git(resolved.rootPath,'rev-parse','--git-path','index')));
  const removed=await service.cleanupRetained(agent.id,ready.workingCopy,project);
  assert.equal(removed.state,'removed');assert.equal(removed.repositoryRoot,resolved.rootPath);
  assert.equal(await readFile(path.join(resolved.rootPath,'file.txt'),'utf8'),'source working\n');
  assert.deepEqual(await readFile(path.resolve(resolved.rootPath,await git(resolved.rootPath,'rev-parse','--git-path','index'))),preservedIndex,'Releasing Agent authority preserves original staged data');
  assert.equal(await git(source,'branch','--show-current'),'main');
  await assert.rejects(service.resolve({...ready,workingCopy:{...ready.workingCopy,repositoryRoot:shared}},project),/identity|ownership/);
 }finally{store?.close();await rm(base,{recursive:true,force:true});}
});

test('adoption preserves its primary failure and attempts every incomplete receipt when storage also fails',async()=>{
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-adoption-failure-')));let store;
 const releases=[];
 try{
  const source=path.join(base,'source'),shared=path.join(base,'shared'),data=path.join(base,'data');await initialize(source);await initialize(shared);await mkdir(data);
  const manifest=await exportReviewedUserData(source,{git:true,harness:false}),pkg=packageFor(manifest,{'file.txt':'committed\n'});
  const sibling=structuredClone(pkg.agents[0]);sibling.ref='second';sibling.managerRef='agent';sibling.workingRootRef='second-root';pkg.agents.push(sibling);
  store=new AgentStore(data);const project=store.createProject({label:'Unchanged Shared',hostPath:shared,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Failed physical adoption'}),service=new AgentWorkingCopyService(data,store);
  const ids=[],destinations={};
  for(const node of pkg.agents){
   const agent=store.createAgent(project.id,{title:node.title,engine:'codex',conversationId:chat.id});ids.push(agent.id);releases.push(service.beginModeChange(agent.id));
   const allocated=await service.allocateImportedSeparateGit(agent,project);destinations[node.workingRootRef]=allocated.workingCopy.rootPath;
   const files=node.workingFiles.map(file=>{const data=Buffer.from(node.artifacts.find(artifact=>artifact.ref===file.artifactRef).dataBase64,'base64');return {path:file.path,data,sha256:createHash('sha256').update(data).digest('hex')};});
   await service.populateImportedRoot(allocated,project,files,[],undefined,path.join(allocated.workingCopy.rootPath,'.ponderosa-import-backups'),[],'refuse',{git:true,harness:false});
  }
  const primary=new Error('Exact branch ownership readback failed'),attempted=[];
  service.resolve=async()=>{throw primary;};
  await assert.rejects(service.completeImportedGitRoots(project,pkg,destinations,{git:true,harness:false},receipt=>{
   if(receipt.state==='incomplete'){attempted.push(receipt.ref);throw new Error('Receipt storage offline: '+receipt.ref);}
  },ids),error=>{
   assert.equal(error.code,'ERR_IMPORTED_GIT_ADOPTION_PARTIAL');assert.equal(error.cause,primary);
   assert.equal(error.receiptErrors.length,2);assert.ok(error.receiptErrors.every(failure=>/Receipt storage offline/.test(failure.message)));
   return true;
  });
  assert.deepEqual(attempted.sort(),['second-root','work']);
  for(const root of Object.values(destinations))assert.equal((await lstat(path.join(root,'.git'))).isDirectory(),true,'Native data remains after failed receipt storage');
  await assert.rejects(service.completeImportedGitRoots(project,pkg,destinations,{git:true,harness:false},()=>{throw Error('No replay is authorized');},ids),/exact populated phase/);
 }finally{for(const release of releases)release();store?.close();await rm(base,{recursive:true,force:true});}
});

test('typed contained roots get local parent-child inode receipts before Shared or Separate binding',async()=>{
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-contained-live-')));let store;
 const releases=[];
 try{
  const shared=path.join(base,'shared'),data=path.join(base,'data');await initialize(shared);await mkdir(data);
  store=new AgentStore(data);const project=store.createProject({label:'Parent',hostPath:shared,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Parent'}),service=new AgentWorkingCopyService(data,store);
  const parent=store.createAgent(project.id,{title:'Parent owner',engine:'codex',conversationId:chat.id});releases.push(service.beginModeChange(parent.id));
  const allocated=await service.allocateImportedSeparateGit(parent,project);
  await assert.rejects(service.reserveImportedContainedRoot(allocated,project,'../escape'),/exact canonical/);
  const reservation=await service.reserveImportedContainedRoot(allocated,project,'modules/shared-child');
  const childProject=store.createProject({label:'Contained Shared',hostPath:reservation.rootPath,defaultEngine:'codex'}),childChat=store.createConversation(childProject.id,{title:'Shared child'}),child=store.createAgent(childProject.id,{title:'Shared child owner',engine:'codex',conversationId:childChat.id});releases.push(service.beginModeChange(child.id));
  const bound=await service.bindImportedContainedRoot(child,childProject,structuredClone(reservation),'shared');
  assert.equal((await service.resolve(bound,childProject)).rootPath,reservation.rootPath);
  assert.equal(bound.workingCopy.importedParent.parentAgentId,parent.id);
  assert.deepEqual(await service.inspectPreparedImportedRoot(bound,childProject),{rootPath:reservation.rootPath,phase:'allocated'});
  await service.populateImportedRoot(bound,childProject,[],[],undefined,path.join(base,'backups'),[],'refuse',{git:false,harness:false},undefined,undefined,true);
  assert.equal((await service.inspectPreparedImportedRoot(bound,childProject)).phase,'populated');
  assert.equal(store.getAgent(parent.id).workingCopy.containedRootPreparations[0].phase,'bound');
  const next=await service.reserveImportedContainedRoot(store.getAgent(parent.id),project,'modules/separate-child'),separate=store.createAgent(project.id,{title:'Separate child owner',engine:'codex',conversationId:chat.id});releases.push(service.beginModeChange(separate.id));
  const forged=structuredClone(next);forged.rootPath=shared;
  await assert.rejects(service.bindImportedContainedRoot(separate,project,forged,'separate_git'),/exact local reservation/);
  const separateBound=await service.bindImportedContainedRoot(separate,project,next,'separate_git');
  assert.equal(separateBound.workingCopy.repositoryRoot,next.rootPath);assert.equal(separateBound.workingCopy.importedParent.parentInode,(await lstat(allocated.workingCopy.rootPath,{bigint:true})).ino.toString());
  await service.populateImportedRoot(separateBound,project,[],[],undefined,path.join(base,'separate-backups'),[],'refuse',undefined,undefined,undefined,true);
  await service.completeImportedGitRoots(project,packageFor({}),{child:next.rootPath},undefined,()=>{throw new Error('No native selection should apply source data');},[separate.id]);
  assert.equal((await service.resolve(store.getAgent(separate.id),project)).rootPath,next.rootPath);
  await assert.rejects(lstat(path.join(reservation.rootPath,'.git')),{code:'ENOENT'},'Contained Shared remains an ordinary folder without selected native Git');
  const newService=new AgentWorkingCopyService(data,store),newParentRelease=newService.beginModeChange(parent.id);releases.push(newParentRelease);
  const confirmed=await service.reserveImportedContainedRoot(store.getAgent(parent.id),project,'modules/confirmed-child'),confirmedChild=store.createAgent(project.id,{title:'Confirmed child',engine:'codex',conversationId:chat.id}),confirmedRelease=newService.beginModeChange(confirmedChild.id);
  try{const rebound=await newService.bindImportedContainedRoot(confirmedChild,project,confirmed,'separate_git');assert.equal(rebound.workingCopy.rootPath,confirmed.rootPath);}finally{confirmedRelease();}
  const orphan=await service.reserveImportedContainedRoot(store.getAgent(parent.id),project,'modules/held-child'),held=store.createAgent(project.id,{title:'Held child',engine:'codex',conversationId:chat.id}),heldRelease=newService.beginModeChange(held.id);
  const beforeUnknown=store.getAgent(parent.id);store.updateAgentWorkingCopy(parent.id,{...beforeUnknown.workingCopy,containedRootPreparations:beforeUnknown.workingCopy.containedRootPreparations.map(item=>item.id===orphan.id?{...item,phase:'creating'}:item)});
  try{await assert.rejects(newService.bindImportedContainedRoot(held,project,orphan,'separate_git'),/exact local reservation/);}finally{heldRelease();}
  assert.equal((await lstat(orphan.rootPath)).isDirectory(),true,'Restart uncertainty preserves the allocated directory');
  const raced=await service.reserveImportedContainedRoot(store.getAgent(parent.id),project,'modules/raced-child'),racedChild=store.createAgent(project.id,{title:'Raced child',engine:'codex',conversationId:chat.id});releases.push(service.beginModeChange(racedChild.id));
  const originalUpdate=store.updateAgentWorkingCopy.bind(store);
  store.updateAgentWorkingCopy=(id,copy)=>{const value=originalUpdate(id,copy);if(id===racedChild.id&&copy.importedParent){renameSync(raced.rootPath,raced.rootPath+'-retained');mkdirSync(raced.rootPath);}return value;};
  try{await assert.rejects(service.bindImportedContainedRoot(racedChild,project,raced,'separate_git'),/binding root changed/);}finally{store.updateAgentWorkingCopy=originalUpdate;}
  await assert.rejects(service.resolve(store.getAgent(racedChild.id),project),/unavailable|custody|ownership|changed/i);
  assert.equal(store.getAgent(parent.id).workingCopy.containedRootPreparations.find(item=>item.id===raced.id).phase,'binding','Replacement cannot silently issue new root authority');

 }finally{for(const release of releases)release();store?.close();await rm(base,{recursive:true,force:true});}
});


test('native sharing matches installed Git modes for group, world, exact octal and umask while retaining hook metadata',{skip:process.platform!=='linux'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-git-shared-modes-'));
  try{
    for(const setting of ['group','all','0660','0640','false','true','1','2']){
      const source=path.join(root,'source-'+setting),destination=path.join(root,'new-'+setting),control=path.join(root,'native-'+setting);
      await initialize(source);await git(source,'config','core.sharedRepository',setting);
      const hook=path.join(source,'.git','hooks','pre-commit');await mkdir(path.dirname(hook));
      await writeFile(hook,'#!/bin/sh\necho unexpected > '+JSON.stringify(path.join(root,'hook-ran'))+'\n');await chmod(hook,0o751);
      const manifest=await exportReviewedUserData(source,{git:true,harness:false}),wire=Buffer.from(JSON.stringify(manifest));
      await mkdir(destination);await chmod(destination,0o750);
      await createReviewedNativeGit(destination,wire,createHash('sha256').update(wire).digest('hex'),{git:true,harness:false});
      await mkdir(control);await git(control,'init','--template=','--initial-branch=main','--shared='+setting);
      await git(control,'config','user.name','Portable Test');await git(control,'config','user.email','portable@example.invalid');
      await writeFile(path.join(control,'file.txt'),'committed\n');await git(control,'add','file.txt');await git(control,'commit','--no-gpg-sign','-m','Initial');
      const controlOid=await git(control,'rev-parse','HEAD'),destinationOid=await git(destination,'rev-parse','HEAD');
      for(const name of ['', 'objects','refs','refs/heads','logs','logs/HEAD','HEAD','config','index','refs/heads/main']){
        const actual=await lstat(path.join(destination,'.git',name)),expected=await lstat(path.join(control,'.git',name));
        assert.equal(actual.mode&0o7777,expected.mode&0o7777,setting+' native mode for '+name);
        assert.equal(actual.gid,(await lstat(path.join(destination,'.git'))).gid,'fresh destination group is inherited, never source-adopted');
      }
      assert.equal((await lstat(path.join(destination,'.git','objects',destinationOid.slice(0,2),destinationOid.slice(2)))).mode&0o7777,
        (await lstat(path.join(control,'.git','objects',controlOid.slice(0,2),controlOid.slice(2)))).mode&0o7777,setting+' immutable object mode');
      assert.equal((await lstat(path.join(destination,'.git','hooks','pre-commit'))).mode&0o7777,0o751,'explicit original executable hook mode wins');
      assert.equal((await lstat(destination)).mode&0o7777,0o750,'working-root metadata is left for its separate finalizer');
      await assert.rejects(lstat(path.join(root,'hook-ran')),{code:'ENOENT'});
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('native sharing follows active worktree configuration rather than only the common declaration',{skip:process.platform!=='linux'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-git-worktree-sharing-'));
  try{
    const source=path.join(root,'source'),destination=path.join(root,'new');await initialize(source);
    await git(source,'config','core.sharedRepository','all');await git(source,'config','extensions.worktreeConfig','true');
    await git(source,'config','--worktree','core.sharedRepository','0640');
    const manifest=await exportReviewedUserData(source,{git:true,harness:false}),wire=Buffer.from(JSON.stringify(manifest));await mkdir(destination);
    await createReviewedNativeGit(destination,wire,createHash('sha256').update(wire).digest('hex'),{git:true,harness:false});
    assert.equal(await git(destination,'config','--get','core.sharedRepository'),'0640');
    assert.equal((await lstat(path.join(destination,'.git','config'))).mode&0o7777,0o640);
    assert.equal((await lstat(path.join(destination,'.git'))).mode&0o7777,0o2750);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('native sharing evaluates relocated conditional includes in the fresh native context',{skip:process.platform!=='linux'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-git-conditional-sharing-'));
  try{
    const source=path.join(root,'source'),destination=path.join(root,'new'),external=path.join(root,'external'),support=path.join(root,'support');
    await initialize(source);await mkdir(external);await git(source,'config','core.sharedRepository','all');
    const conditional='[core]\n sharedRepository = 0640\n';await writeFile(path.join(external,'conditional.conf'),conditional);
    await git(source,'config','includeIf.onbranch:main.path',path.join(external,'conditional.conf'));
    const manifest=await exportReviewedUserData(source,{git:true,harness:false}),pkg=packageFor(manifest,{'file.txt':'committed\n'});
    pkg.agents.push({ref:'support-agent',title:'Conditional configuration',engine:'codex',managerRef:'agent',workingRootRef:'support',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingFolder:{directories:[],excludedPaths:[]},workingFiles:[{path:'conditional.conf',artifactRef:'conditional'}],artifacts:[{ref:'conditional',kind:'generated_file',path:'conditional.conf',createdAt:new Date().toISOString(),dataBase64:Buffer.from(conditional).toString('base64')}]});
    await mkdir(destination);await mkdir(support);await writeFile(path.join(support,'conditional.conf'),conditional);await writeFile(path.join(destination,'file.txt'),'committed\n');
    const activation={git:true,harness:false,gitPathMappings:[{source,destination},{source:external,destination:support}]};
    await applyReviewedRecoveryRoots(planReviewedRecoveryRoots(pkg,{work:destination,support},activation),activation,()=>{});
    assert.equal(await git(destination,'config','--get','core.sharedRepository'),'0640');
    assert.equal((await lstat(path.join(destination,'.git','config'))).mode&0o7777,0o640);
    assert.equal((await lstat(path.join(destination,'.git'))).mode&0o7777,0o2750);
  }finally{await rm(root,{recursive:true,force:true});}
});


test('native sharing retains kernel default-ACL creation modes rather than reconstructing them from umask',{skip:process.platform!=='linux'},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-git-shared-acl-'));
  try{
    try{await exec('setfacl',['-m','d:u::rwx,d:g::rwx,d:o::---',root]);}
    catch(error){if(error.code==='ENOENT'||/Operation not supported/.test(String(error.stderr))){t.skip('setfacl/default ACL capability is absent');return;}throw error;}
    const source=path.join(root,'source'),destination=path.join(root,'new'),control=path.join(root,'native');
    await initialize(source);await git(source,'config','core.sharedRepository','group');
    const manifest=await exportReviewedUserData(source,{git:true,harness:false}),wire=Buffer.from(JSON.stringify(manifest));await mkdir(destination);
    await createReviewedNativeGit(destination,wire,createHash('sha256').update(wire).digest('hex'),{git:true,harness:false});
    await mkdir(control);await git(control,'init','--template=','--initial-branch=main','--shared=group');
    for(const name of ['', 'objects','refs','HEAD','config'])assert.equal((await lstat(path.join(destination,'.git',name))).mode&0o7777,
      (await lstat(path.join(control,'.git',name))).mode&0o7777,'kernel ACL-aware native mode for '+name);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('native sharing preflights every inode before changing any mode',{skip:process.platform!=='linux'},async()=>{
  const {applyNativeGitPermissions}=await import('../../apps/server/dist/portable-git-permissions.js');
  const root=await mkdtemp(path.join(tmpdir(),'portable-git-permission-custody-'));
  try{
    const source=path.join(root,'source');await initialize(source);await git(source,'config','core.sharedRepository','group');
    const gitDir=path.join(source,'.git'),config=path.join(gitDir,'config'),head=path.join(gitDir,'HEAD');
    const configStat=await lstat(config,{bigint:true}),headStat=await lstat(head,{bigint:true});
    await assert.rejects(applyNativeGitPermissions({gitDir,worktreePath:source},[],[
      {path:config,device:configStat.dev,inode:configStat.ino,creationMode:0o600},
      {path:head,device:headStat.dev,inode:headStat.ino+1n,creationMode:0o600},
    ]),/identity or owner changed/);
    assert.equal((await lstat(config,{bigint:true})).mode,configStat.mode,'earlier valid node was not changed before the later mismatch');
    assert.equal((await lstat(head,{bigint:true})).mode,headStat.mode,'mismatched node was not changed');
  }finally{await rm(root,{recursive:true,force:true});}
});
