import {inventoryWorkingFolder,exportWorkingFiles,importWorkingFiles} from '../../apps/server/dist/portable-working-files.js';
import {decodePortableArtifactData} from '../../apps/server/dist/agent-package-codec.js';
import {captureRetainedReviewOriginal} from '../../apps/server/dist/portable-reviewed-user-data.js';
import {generatedHookName,generatedHookIdentity} from '../../apps/server/dist/portable-generated-hook-proof.js';
import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readlink,readdir,unlink,chmod,lstat,realpath,open,rm,symlink} from 'node:fs/promises';
import {tmpdir,homedir,userInfo} from 'node:os';
import {mkdirSync,renameSync} from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {exportReviewedUserData,parseReviewedUserData,recreateReviewedGit,createGitExportCapture,createReviewedNativeGit,createReviewedRecoveryGit} from '../../apps/server/dist/portable-reviewed-user-data.js';
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
    const inactive=await exportReviewedUserData(source,{git:true,harness:false});assert.equal(inactive.git.modules[0].source.initialized,false);assert.equal(inactive.git.modules[0].source.coreWorktree,null);
    const direct=path.join(root,'direct-without-module-plan');await mkdir(direct);
    const inactiveBytes=Buffer.from(JSON.stringify(inactive)),inactiveHash=createHash('sha256').update(inactiveBytes).digest('hex');
    await assert.rejects(createReviewedNativeGit(direct,inactiveBytes,inactiveHash,activation),/complete exact reviewed recreation plan|locally issued dependency plan/);
    await assert.rejects(lstat(path.join(direct,'.git')),{code:'ENOENT'});
    const recovery=path.join(root,'inactive');await mkdir(recovery);await mkdir(path.join(recovery,'module'));await writeFile(path.join(recovery,'file.txt'),'committed\n');await writeFile(path.join(recovery,'.gitmodules'),gitmodules);
    const missing=packageFor(inactive,{'file.txt':'committed\n'}),changed=packageFor(inactive,{'file.txt':'committed\n','.gitmodules':gitmodules+'\n# changed\n'});
    assert.throws(()=>planReviewedRecoveryRoots(missing,{work:recovery},activation),/exact selected \.gitmodules/);
    assert.throws(()=>planReviewedRecoveryRoots(changed,{work:recovery},activation),/exact selected \.gitmodules/);
    const divergent={...activation,gitPathMappings:[{source:inactive.git.modules[0].source.worktreePath,destination:path.join(recovery,'different')}]};
    assert.throws(()=>planReviewedRecoveryRoots(packageFor(inactive,{'file.txt':'committed\n','.gitmodules':gitmodules}),{work:recovery},divergent),/destination must follow|mapping/i);
    await assert.rejects(lstat(path.join(recovery,'.git')),{code:'ENOENT'});
    await applyReviewedRecoveryRoots(planReviewedRecoveryRoots(packageFor(inactive,{'file.txt':'committed\n','.gitmodules':gitmodules}),{work:recovery},activation),activation,()=>{});
    await assert.rejects(lstat(path.join(recovery,'module','.git')),{code:'ENOENT'});
    assert.doesNotMatch(await readFile(path.join(recovery,'.git','modules','module','config'),'utf8'),/worktree\s*=/i,'Dormant module native config must omit core.worktree');
    assert.equal(await git(recovery,'--git-dir='+path.join(recovery,'.git','modules','module'),'rev-parse','HEAD'),childHead);
    const roundtrip=await exportReviewedUserData(recovery,{git:true,harness:false});
    assert.equal(roundtrip.git.modules[0].source.initialized,false);
    assert.equal(roundtrip.git.modules[0].source.coreWorktree,null);
    assert.equal(roundtrip.git.modules[0].source.dormantAssociation.gitlinkOid,childHead);
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
  await git(source,'-c','protocol.file.allow=always','submodule','add',moduleSource,'child');
  await git(source,'config','-f','.gitmodules','submodule.child.url','https://example.invalid/child');await git(source,'config','submodule.child.url','https://example.invalid/child');await git(path.join(source,'child'),'remote','set-url','origin','https://example.invalid/child');
  await git(source,'add','.gitmodules');await git(source,'commit','--no-gpg-sign','-m','Add initialized child');
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
   assert.deepEqual({device:issued.device,inode:issued.inode},{device:copied.dev.toString(),inode:copied.ino.toString()},'The working-copy service forwards the exact populated-root identity');
   assert.ok(Object.keys(issued.directories??{}).length>0,'Nested directory identities are retained');
   for(const [relative,identity] of Object.entries(issued.directories)){const actual=await lstat(path.join(imported.workingCopy.rootPath,relative),{bigint:true});assert.deepEqual(identity,{device:actual.dev.toString(),inode:actual.ino.toString()});}
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
  await service.populateImportedRoot(bound,childProject,[],[],undefined,path.join(reservation.rootPath,'.ponderosa-import-backups'),[],'refuse',{git:false,harness:false},undefined,undefined,true);
  assert.equal((await service.inspectPreparedImportedRoot(bound,childProject)).phase,'populated');
  assert.equal(store.getAgent(parent.id).workingCopy.containedRootPreparations[0].phase,'bound');
  const next=await service.reserveImportedContainedRoot(store.getAgent(parent.id),project,'modules/separate-child'),separate=store.createAgent(project.id,{title:'Separate child owner',engine:'codex',conversationId:chat.id});releases.push(service.beginModeChange(separate.id));
  const forged=structuredClone(next);forged.rootPath=shared;
  await assert.rejects(service.bindImportedContainedRoot(separate,project,forged,'separate_git'),/exact local reservation/);
  const separateBound=await service.bindImportedContainedRoot(separate,project,next,'separate_git');
  assert.equal(separateBound.workingCopy.repositoryRoot,next.rootPath);assert.equal(separateBound.workingCopy.importedParent.parentInode,(await lstat(allocated.workingCopy.rootPath,{bigint:true})).ino.toString());
  await service.populateImportedRoot(separateBound,project,[],[],undefined,path.join(next.rootPath,'.ponderosa-import-backups'),[],'refuse',undefined,undefined,undefined,true);
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
      await applyReviewedRecoveryRoots(planReviewedRecoveryRoots(packageFor(manifest),{work:destination},{git:true,harness:false}),{git:true,harness:false},()=>{});
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
    await applyReviewedRecoveryRoots(planReviewedRecoveryRoots(packageFor(manifest),{work:destination},{git:true,harness:false}),{git:true,harness:false},()=>{});
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
    await applyReviewedRecoveryRoots(planReviewedRecoveryRoots(packageFor(manifest),{work:destination},{git:true,harness:false}),{git:true,harness:false},()=>{});
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

test('native recovery refuses replaced original roots before creating Git metadata',async()=>{
 const {rename}=await import('node:fs/promises');
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-git-original-root-')));
 try{
  const source=path.join(base,'source'),destination=path.join(base,'destination'),retained=path.join(base,'retained');
  await initialize(source);await mkdir(destination);await writeFile(path.join(destination,'file.txt'),'committed\n');
  const manifest=await exportReviewedUserData(source,{git:true,harness:false}),pkg=packageFor(manifest,{'file.txt':'committed\n'}),activation={git:true,harness:false};
  const tasks=planReviewedRecoveryRoots(pkg,{work:destination},activation),identity=await lstat(destination,{bigint:true});
  await rename(destination,retained);await mkdir(destination);
  await assert.rejects(applyReviewedRecoveryRoots(tasks,activation,()=>{},{
   [destination]:{device:String(identity.dev),inode:String(identity.ino)},
  }),/original issued identity/);
  await assert.rejects(lstat(path.join(destination,'.git')),error=>error.code==='ENOENT');
  assert.equal(await readFile(path.join(retained,'file.txt'),'utf8'),'committed\n');
 }finally{await rm(base,{recursive:true,force:true});}
});

test('native Git configuration failures retain their exact redacted cause',async()=>{
 const {applyNativeGitPermissions}=await import('../../apps/server/dist/portable-git-permissions.js');
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-git-config-cause-'))),root=path.join(base,'repository');
 try{
  await initialize(root);await writeFile(path.join(root,'.git','config'),'[malformed section\n');
  await assert.rejects(applyNativeGitPermissions({gitDir:path.join(root,'.git'),worktreePath:root},[],[]),error=>{
   assert.equal(error.code,'ERR_GIT_SHARED_CONFIGURATION');assert.match(error.message,/bad config|config.*line/i);assert.ok(error.cause);return true;
  });
 }finally{await rm(base,{recursive:true,force:true});}
});

test('live native held-open rejects replacement after service precheck before any native write',async()=>{
 const {promises:hostFs}=await import('@ponderosa/native-host/fs'),{rename}=await import('node:fs/promises');
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-live-original-open-')));let store,restore;
 try{
  const source=path.join(base,'source'),shared=path.join(base,'shared'),data=path.join(base,'data');await initialize(source);await initialize(shared);await mkdir(data);
  const manifest=await exportReviewedUserData(source,{git:true,harness:false}),pkg=packageFor(manifest),bytes=Buffer.from(JSON.stringify(manifest));
  store=new AgentStore(data);const project=store.createProject({label:'Existing',hostPath:shared,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Fresh Separate'}),agent=store.createAgent(project.id,{title:'Owner',engine:'codex',conversationId:chat.id}),service=new AgentWorkingCopyService(data,store),release=service.beginModeChange(agent.id);
  try{
   const created=await service.allocateImportedSeparateGit(agent,project),root=created.workingCopy.rootPath,retained=root+'-retained',originalOpen=hostFs.open;let replaced=false;
   await service.populateImportedRoot(created,project,[{path:'.ponderosa-portable-review/user-data.json',data:bytes,sha256:createHash('sha256').update(bytes).digest('hex')}],[],undefined,path.join(root,'.ponderosa-import-backups'),[],'refuse',undefined,undefined,{work:root},true,true);
   // Only the native helper uses this object seam; service precheck uses its
   // existing named lstat/realpath imports and has already verified original custody.
   hostFs.open=async function(name,...args){if(name===root&&!replaced){replaced=true;await rename(root,retained);await mkdir(root);}return originalOpen.call(this,name,...args);};restore=()=>{hostFs.open=originalOpen;};
   await assert.rejects(service.completeImportedGitRoots(project,pkg,{work:root},{git:true,harness:false},()=>{throw new Error('No native applying receipt may precede original held-open custody');},[agent.id]),error=>/original issued identity/.test(String(error.cause?.message)));
   restore();restore=undefined;assert.equal(replaced,true);await assert.rejects(lstat(path.join(root,'.git')),error=>error.code==='ENOENT');assert.equal(await readFile(path.join(retained,'.ponderosa-portable-review/user-data.json'),'utf8'),bytes.toString());assert.equal(store.getAgent(agent.id).workingCopy.state,'unavailable');
  }finally{release();}
 }finally{restore?.();store?.close();await rm(base,{recursive:true,force:true});}
});

test('native hook graph requires exact issued source, destination and untampered plan before writes',{skip:process.platform==='win32'},async()=>{
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-issued-hook-plan-')));
 try{
  const source=path.join(base,'source');await initialize(source);
  const hook=path.join(source,'.git','hooks','pre-commit'),marker=path.join(base,'hook-ran');
  await mkdir(path.dirname(hook),{recursive:true});
  await writeFile(hook,'#!/bin/sh\necho ran > '+JSON.stringify(marker)+'\n',{mode:0o751});await chmod(hook,0o751);
  const manifest=await exportReviewedUserData(source,{git:true,harness:false}),wire=Buffer.from(JSON.stringify(manifest));
  const hash=createHash('sha256').update(wire).digest('hex'),activation={git:true,harness:false},pkg=packageFor(manifest);
  const direct=path.join(base,'direct');await mkdir(direct);
  await assert.rejects(createReviewedNativeGit(direct,wire,hash,activation),/locally issued dependency plan/);
  await assert.rejects(createReviewedRecoveryGit(direct,wire,hash,activation),/locally issued dependency plan/);
  assert.deepEqual(await readdir(direct),[]);

  const forgedRoot=path.join(base,'forged');await mkdir(forgedRoot);
  const forged=planReviewedRecoveryRoots(pkg,{work:forgedRoot},activation)[0];
  forged.configuration={...forged.configuration};
  await assert.rejects(applyReviewedRecoveryRoots([forged],activation,()=>{}),/dependency plan/);
  assert.deepEqual(await readdir(forgedRoot),[]);

  const foreignRoot=path.join(base,'foreign-custody');await mkdir(foreignRoot);
  const foreign=planReviewedRecoveryRoots(pkg,{work:foreignRoot},activation)[0],foreignStat=await lstat(foreignRoot,{bigint:true});
  foreign.configuration.external.worktreeIdentity={device:String(foreignStat.dev),inode:String(foreignStat.ino)};
  await assert.rejects(applyReviewedRecoveryRoots([foreign],activation,()=>{}),/original issued root/);
  assert.deepEqual(await readdir(foreignRoot),[]);

  const missingFamily=structuredClone(manifest);delete missingFamily.gitExternalDependencies;
  const missingWire=Buffer.from(JSON.stringify(missingFamily)),missingHash=createHash('sha256').update(missingWire).digest('hex');
  const graphRoot=path.join(base,'unreviewed-graph');await mkdir(graphRoot);
  const graphConfig={common:Buffer.alloc(0),private:null,targets:[],includes:[],external:{directories:[],files:[],links:[]}};
  await assert.rejects(createReviewedNativeGit(graphRoot,missingWire,missingHash,activation,graphConfig),/lacks reviewed source evidence/);
  assert.deepEqual(await readdir(graphRoot),[]);

  const tamperedRoot=path.join(base,'tampered');await mkdir(tamperedRoot);
  const tampered=planReviewedRecoveryRoots(pkg,{work:tamperedRoot},activation)[0];
  const original=tampered.configuration.external.files.find(file=>file.path.endsWith('pre-commit'));
  assert.ok(original,'captured hook must be in the issued dependency graph');original.data[0]^=1;
  await assert.rejects(applyReviewedRecoveryRoots([tampered],activation,()=>{}),/dependency plan/);
  assert.deepEqual(await readdir(tamperedRoot),[]);

  const wrongRoot=path.join(base,'wrong');await mkdir(wrongRoot);
  const wrong=planReviewedRecoveryRoots(pkg,{work:wrongRoot},activation)[0];
  const otherRoot=path.join(base,'other');await mkdir(otherRoot);wrong.destination=otherRoot;
  await assert.rejects(applyReviewedRecoveryRoots([wrong],activation,()=>{}),/dependency plan/);
  assert.deepEqual(await readdir(otherRoot),[]);

  const custodyRoot=path.join(base,'custody');await mkdir(custodyRoot);
  const custody=planReviewedRecoveryRoots(pkg,{work:custodyRoot},activation)[0],st=await lstat(custodyRoot,{bigint:true});
  await assert.rejects(applyReviewedRecoveryRoots([custody],activation,receipt=>{
   if(receipt.state==='applying')custody.configuration.external.worktreeIdentity={device:String(st.dev),inode:String(st.ino+1n)};
  },{[custodyRoot]:{device:String(st.dev),inode:String(st.ino)}}),/dependency plan/);
  assert.deepEqual(await readdir(custodyRoot),[]);

  const collisionRoot=path.join(base,'collision');await mkdir(collisionRoot);
  const collision=planReviewedRecoveryRoots(pkg,{work:collisionRoot},activation)[0],collisionStat=await lstat(collisionRoot,{bigint:true});
  const collisionIdentity={device:String(collisionStat.dev),inode:String(collisionStat.ino)};
  await mkdir(path.join(collisionRoot,'.git'));
  await assert.rejects(applyReviewedRecoveryRoots([collision],activation,()=>{throw Error('No receipt is permitted before preflight');},{[collisionRoot]:collisionIdentity}),/already has native Git/);
  await rm(path.join(collisionRoot,'.git'),{recursive:true});
  await applyReviewedRecoveryRoots([collision],activation,()=>{},{[collisionRoot]:collisionIdentity});
  assert.equal(await readFile(path.join(collisionRoot,'.git','hooks','pre-commit'),'utf8'),await readFile(hook,'utf8'));

  await mkdir(path.join(source,'.husky'));await writeFile(path.join(source,'.husky','pre-commit'),'#!/bin/sh\nexit 0\n');
  await git(source,'config','core.hooksPath','.husky');
  const scopedManifest=await exportReviewedUserData(source,{git:true,harness:false});
  const scopedRoot=path.join(base,'worktree-no-custody');await mkdir(scopedRoot);await mkdir(path.join(scopedRoot,'.husky'));
  await writeFile(path.join(scopedRoot,'.husky','pre-commit'),'#!/bin/sh\nexit 0\n');
  const scopedTasks=planReviewedRecoveryRoots(packageFor(scopedManifest,{'.husky/pre-commit':'#!/bin/sh\nexit 0\n'}),{work:scopedRoot},activation);
  await assert.rejects(applyReviewedRecoveryRoots(scopedTasks,activation,()=>{throw Error('Unexpected receipt');}),/original issued import-root identity/);
  assert.deepEqual(await readdir(scopedRoot),['.husky']);

  const restored=path.join(base,'restored');await mkdir(restored);
  await applyReviewedRecoveryRoots(planReviewedRecoveryRoots(pkg,{work:restored},activation),activation,()=>{});
  assert.equal(await readFile(path.join(restored,'.git','hooks','pre-commit'),'utf8'),await readFile(hook,'utf8'));
  assert.equal((await lstat(path.join(restored,'.git','hooks','pre-commit'))).mode&0o777,0o751);
  await assert.rejects(lstat(marker),{code:'ENOENT'});
 }finally{await rm(base,{recursive:true,force:true});}
});

test('Git dependency JSON refuses hidden duplicate credentials on export and import', {skip:process.platform==='win32'},async()=>{
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-git-duplicate-json-')));
 try{
  const source=path.join(base,'source'),hooks=path.join(source,'hooks');await initialize(source);await mkdir(hooks);
  await git(source,'config','core.hooksPath','hooks');
  const file=path.join(hooks,'pre-commit');
  for(const bad of ['{"user":{"apiKey":"SYNTHETIC_SECRET"},"u\\u0073er":{}}',JSON.stringify({encoded:'{"user":{"apiKey":"SYNTHETIC_SECRET"},"user":{}}'}),JSON.stringify('{"user":{"apiKey":"SYNTHETIC_SECRET"},"user":{}}')]){
   await writeFile(file,bad);await assert.rejects(exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true}),/duplicate object keys/);
  }
  await writeFile(file,'{"safe":true}');const manifest=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});
  const entry=manifest.gitExternalDependencies.files.find(row=>row.sourcePath===file);assert.ok(entry);
  entry.dataBase64=Buffer.from('{"user":{"apiKey":"SYNTHETIC_SECRET"},"user":{}}').toString('base64');
  assert.throws(()=>parseReviewedUserData(Buffer.from(JSON.stringify(manifest))),/duplicate object keys/);
 }finally{await rm(base,{recursive:true,force:true});}
});

test('provider JSON preserves exact nonsecret bytes while excluding known credential fields',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'portable-provider-json-bytes-')));
 try{
  await mkdir(path.join(root,'.claude'));
  const file=path.join(root,'.claude','settings.json'),original='{  "permissions" : { "allow" : ["Read"] }, "note":"🌲" }\n';
  await writeFile(file,original);
  let value=await exportReviewedUserData(root,{git:false,harness:true}),entry=value.providerFiles.find(file=>file.path==='.claude/settings.json');
  assert.equal(entry.removedSecretFields,false);assert.equal(Buffer.from(entry.dataBase64,'base64').toString('utf8'),original);
  await writeFile(file,'{ "apiKey": "SYNTHETIC_PRIVATE_KEY", "permissions": { "allow": ["Read"] } }\n');
  value=await exportReviewedUserData(root,{git:false,harness:true});entry=value.providerFiles.find(file=>file.path==='.claude/settings.json');
  const sanitized=Buffer.from(entry.dataBase64,'base64').toString('utf8');assert.equal(entry.removedSecretFields,true);
  assert.doesNotMatch(sanitized,/SYNTHETIC_PRIVATE_KEY|apiKey/);assert.deepEqual(JSON.parse(sanitized),{permissions:{allow:['Read']}});
  for(const ambiguous of ['{"user":{"apiKey":"SYNTHETIC_SECRET"},"u\\u0073er":{}}',JSON.stringify({value:'{"user":{"apiKey":"SYNTHETIC_SECRET"},"user":{}}'})]){
   await writeFile(file,ambiguous);
   await assert.rejects(exportReviewedUserData(root,{git:false,harness:true}),/duplicate object keys/);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('harness-only Separate activation ignores Git refs carried in the same original manifest',async()=>{
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-harness-only-owned-')));let store;
 try{
  const source=path.join(base,'source'),shared=path.join(base,'shared'),data=path.join(base,'data');await initialize(source);await initialize(shared);await mkdir(data);await mkdir(path.join(source,'.claude'));await writeFile(path.join(source,'.claude','settings.json'),'{"permissions":{"allow":[]}}\n');await git(source,'tag','unrequested-source-tag');
  const manifest=await exportReviewedUserData(source,{git:true,harness:true}),pkg=packageFor(manifest),bytes=Buffer.from(JSON.stringify(manifest)),activation={git:false,harness:true};
  store=new AgentStore(data);const project=store.createProject({label:'Existing',hostPath:shared,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Harness only'}),agent=store.createAgent(project.id,{title:'Owner',engine:'codex',conversationId:chat.id}),service=new AgentWorkingCopyService(data,store),release=service.beginModeChange(agent.id);
  try{
   const created=await service.allocateImportedSeparateGit(agent,project),root=created.workingCopy.rootPath;
   await service.populateImportedRoot(created,project,[{path:'.ponderosa-portable-review/user-data.json',data:bytes,sha256:createHash('sha256').update(bytes).digest('hex')}],[],undefined,path.join(root,'.ponderosa-import-backups'),[],'refuse',undefined,undefined,{work:root},true,true);
   await assert.rejects(lstat(path.join(root,'.claude')),error=>error.code==='ENOENT');
   const receipts=[];await service.completeImportedGitRoots(project,pkg,{work:root},activation,receipt=>receipts.push(structuredClone(receipt)),[agent.id]);
   assert.equal(store.getAgent(agent.id).workingCopy.state,'ready');assert.equal(await readFile(path.join(root,'.claude','settings.json'),'utf8'),'{"permissions":{"allow":[]}}\n');
   await assert.rejects(git(root,'rev-parse','--verify','refs/tags/unrequested-source-tag'));
   assert.equal(receipts.at(-1).state,'completed');assert.deepEqual(receipts.at(-1).selection,{git:false,harness:true});assert.equal(await git(source,'tag','--list','unrequested-source-tag'),'unrequested-source-tag');
  }finally{release();}
 }finally{store?.close();await rm(base,{recursive:true,force:true});}
});

test('live native adoption seals and rechecks configured closed hardlink/symlink dependencies',{skip:process.platform==='win32'},async()=>{
 const {symlink,link,unlink}=await import('node:fs/promises'),{getNativeGitExternalGraph}=await import('../../apps/server/dist/portable-git-external-application.js');
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-native-owned-aliases-')));let store;
 try{
  const source=path.join(base,'source'),shared=path.join(base,'shared'),hooks=path.join(base,'configured-hooks'),data=path.join(base,'data');await initialize(source);await initialize(shared);await mkdir(hooks);await mkdir(data);
  await writeFile(path.join(hooks,'pre-commit'),'#!/bin/sh\nexit 0\n',{mode:0o750});await link(path.join(hooks,'pre-commit'),path.join(hooks,'same-hook'));await symlink('pre-commit',path.join(hooks,'symbolic-hook'));await git(source,'config','core.hooksPath',hooks);
  const manifest=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true}),pkg=packageFor(manifest),bytes=Buffer.from(JSON.stringify(manifest)),activation={git:true,harness:false};
  store=new AgentStore(data);const project=store.createProject({label:'Existing',hostPath:shared,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Owned alias dependencies'}),agent=store.createAgent(project.id,{title:'Owner',engine:'codex',conversationId:chat.id}),service=new AgentWorkingCopyService(data,store),release=service.beginModeChange(agent.id);
  try{
   const created=await service.allocateImportedSeparateGit(agent,project),root=created.workingCopy.rootPath;
   await service.populateImportedRoot(created,project,[{path:'.ponderosa-portable-review/user-data.json',data:bytes,sha256:createHash('sha256').update(bytes).digest('hex')}],[],undefined,path.join(root,'.ponderosa-import-backups'),[],'refuse',undefined,undefined,{work:root},true,true);
   const task=planReviewedRecoveryRoots(pkg,{work:root},activation)[0],graph=getNativeGitExternalGraph(task.configuration,{gitDir:root+'/.git',worktreePath:root});assert.ok(graph.links.some(link=>link.kind==='hardlink'));assert.ok(graph.links.some(link=>link.kind==='symlink'));
   await service.completeImportedGitRoots(project,pkg,{work:root},activation,()=>{},[agent.id]);assert.equal(store.getAgent(agent.id).workingCopy.state,'ready');
   const sha256=createHash('sha256').update(bytes).digest('hex');await service.verifyImportedGitRoot(project,sha256,root);
   const hard=graph.links.find(link=>link.kind==='hardlink');assert.equal((await lstat(hard.path)).ino,(await lstat(hard.target)).ino);
   const foreign=path.join(base,'undeclared-outside-hardlink');await link(hard.target,foreign);await assert.rejects(service.verifyImportedGitRoot(project,sha256,root),/hardlinked|count|graph/);await unlink(foreign);
   const symbolic=graph.links.find(link=>link.kind==='symlink');assert.equal(await readFile(symbolic.path,'utf8'),'#!/bin/sh\nexit 0\n');assert.equal(await readFile(path.join(hooks,'pre-commit'),'utf8'),'#!/bin/sh\nexit 0\n');
  }finally{release();}
 }finally{store?.close();await rm(base,{recursive:true,force:true});}
});

test('configured dependency source capture is explicit, complete and keeps credential stores excluded',{skip:process.platform==='win32'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-external-capture-'));
  try{
    const source=path.join(root,'source'),external=path.join(root,'configured');await initialize(source);await mkdir(external);
    await writeFile(path.join(external,'outer.conf'),'[include]\n path = nested.conf\n[portable]\n external = retained\n');
    await writeFile(path.join(external,'nested.conf'),'[portable]\n nested = retained\n');
    await mkdir(path.join(external,'hooks'));await writeFile(path.join(external,'hooks','pre-commit'),'#!/bin/sh\nexit 0\n');await chmod(path.join(external,'hooks','pre-commit'),0o751);
    await writeFile(path.join(external,'hooks','helper.bin'),Buffer.from([0,255,1,128]));
    await mkdir(path.join(external,'linked'));await writeFile(path.join(external,'linked','hook.sh'),'#!/bin/sh\nexit 0\n');await writeFile(path.join(external,'linked','unreferenced.txt'),'unrelated');await symlink('../linked/hook.sh',path.join(external,'hooks','post-commit'));
    await writeFile(path.join(external,'attributes'),'*.txt text\n');await writeFile(path.join(external,'excludes'),'scratch/\n');
    await git(source,'config','include.path',path.join(external,'outer.conf'));await git(source,'config','core.hooksPath',path.join(external,'hooks'));await git(source,'config','core.attributesFile',path.join(external,'attributes'));await git(source,'config','core.excludesFile',path.join(external,'excludes'));
    const inert=await exportReviewedUserData(source,{git:true,harness:false});assert.equal(inert.gitExternalDependencies.sourceWorkingRoot,source);assert.ok(inert.gitExternalDependencies.omittedPaths.includes(path.join(external,'outer.conf')));assert.ok(!inert.gitExternalDependencies.files.some(file=>file.sourcePath.startsWith(external+'/')));
    const value=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true}),family=value.gitExternalDependencies;
    assert.equal(value.selection.externalGitDependencies,true);assert.equal(family.omittedPaths.length,0);assert.ok(family.files.some(file=>file.sourcePath===path.join(external,'nested.conf')&&file.config));
    const hook=family.files.find(file=>file.sourcePath===path.join(external,'hooks','pre-commit'));assert.equal(hook.mode,0o751);assert.equal(Buffer.from(family.files.find(file=>file.sourcePath===path.join(external,'hooks','helper.bin')).dataBase64,'base64')[1],255);
    assert.ok(family.bindings.every(binding=>path.isAbsolute(binding.contextSourcePath)));assert.deepEqual(parseReviewedUserData(Buffer.from(JSON.stringify(value))).gitExternalDependencies,family);
    assert.ok(family.files.some(file=>file.sourcePath===path.join(external,'linked','hook.sh')));assert.ok(!family.files.some(file=>file.sourcePath===path.join(external,'linked','unreferenced.txt')));
    const forged=structuredClone(value);forged.gitExternalDependencies.links.push({sourcePath:path.join(external,'alias'),targetSourcePath:path.join(external,'missing'),kind:'hardlink'});assert.throws(()=>parseReviewedUserData(Buffer.from(JSON.stringify(forged))),/link|target|graph|dependency/i);
    const missingBinding=structuredClone(value);missingBinding.gitExternalDependencies.bindings.shift();assert.throws(()=>parseReviewedUserData(Buffer.from(JSON.stringify(missingBinding))),/binding/i);
    const badParent=structuredClone(value),leaf=badParent.gitExternalDependencies.files.find(file=>!file.config);badParent.gitExternalDependencies.files.push({...leaf,sourcePath:leaf.sourcePath+'/nested'});assert.throws(()=>parseReviewedUserData(Buffer.from(JSON.stringify(badParent))),/parent|topology/i);
    const keyMaterial=structuredClone(value);keyMaterial.gitExternalDependencies.files.push({sourcePath:path.join(external,'hooks','secret.key'),dataBase64:Buffer.from('opaque').toString('base64'),mode:0o600,mtimeNs:'0'});assert.throws(()=>parseReviewedUserData(Buffer.from(JSON.stringify(keyMaterial))),/key material/i);
    const cycle=structuredClone(value);cycle.gitExternalDependencies.links.push({sourcePath:path.join(external,'hooks','cycle-a'),targetSourcePath:path.join(external,'hooks','cycle-b'),kind:'symlink',mtimeNs:'0'},{sourcePath:path.join(external,'hooks','cycle-b'),targetSourcePath:path.join(external,'hooks','cycle-a'),kind:'symlink',mtimeNs:'0'});parseReviewedUserData(Buffer.from(JSON.stringify(cycle)));
    const hardCycle=structuredClone(cycle);for(const alias of hardCycle.gitExternalDependencies.links.filter(alias=>alias.sourcePath.includes('/cycle-')))alias.kind='hardlink';assert.throws(()=>parseReviewedUserData(Buffer.from(JSON.stringify(hardCycle))),/hardlink|target/i);
    const unrelated=path.join(root,'unrelated');await initialize(unrelated);const unrelatedValue=await exportReviewedUserData(unrelated,{git:true,harness:false}),disconnected=structuredClone(value),other=unrelatedValue.gitExternalDependencies;
    for(const key of ['files','directories','links','absentPaths','omittedPaths','bindings'])disconnected.gitExternalDependencies[key].push(...other[key]);disconnected.gitExternalDependencies.directories.push({sourcePath:unrelated,mode:0o700,mtimeNs:'0',root:true});disconnected.gitExternalDependencies.repositories=[{sourcePath:unrelated,git:unrelatedValue.git,originals:unrelatedValue.providerFiles}];assert.throws(()=>parseReviewedUserData(Buffer.from(JSON.stringify(disconnected))),/capsule|repository|disconnected|closure/i);
    const named='~'+userInfo().username+'/'+path.relative(homedir(),path.join(external,'outer.conf'));await git(source,'config','include.path',named);await git(source,'config','core.attributesFile','%(prefix)/ponderosa-absent-'+path.basename(root));
    const expanded=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});assert.ok(expanded.gitExternalDependencies.bindings.some(binding=>binding.rawValue===named&&binding.resolvedPath===path.join(external,'outer.conf')));assert.ok(expanded.gitExternalDependencies.bindings.some(binding=>binding.rawValue.startsWith('%(prefix)')&&path.isAbsolute(binding.resolvedPath)));parseReviewedUserData(Buffer.from(JSON.stringify(expanded)));
    await mkdir(path.join(external,'.aws'));await writeFile(path.join(external,'.aws','credentials'),'private');await git(source,'config','include.path',path.join(external,'.aws','credentials'));
    const excluded=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});assert.ok(excluded.gitExternalDependencies.omittedPaths.includes(path.join(external,'.aws','credentials')));assert.ok(!excluded.gitExternalDependencies.files.some(file=>file.sourcePath.includes('/.aws/')));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('replacement after local branch readiness but before first native seal stays unavailable and never replays',async()=>{
 const {rename,cp}=await import('node:fs/promises'),base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-native-first-seal-')));let store;
 try{
  const source=path.join(base,'source'),shared=path.join(base,'shared'),data=path.join(base,'data');await initialize(source);await initialize(shared);await mkdir(data);
  const manifest=await exportReviewedUserData(source,{git:true,harness:false}),pkg=packageFor(manifest),bytes=Buffer.from(JSON.stringify(manifest));
  store=new AgentStore(data);const project=store.createProject({label:'Existing',hostPath:shared,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Seal custody'}),agent=store.createAgent(project.id,{title:'Owner',engine:'codex',conversationId:chat.id}),service=new AgentWorkingCopyService(data,store),release=service.beginModeChange(agent.id);
  try{
   const created=await service.allocateImportedSeparateGit(agent,project),root=created.workingCopy.rootPath,retained=root+'-retained';
   await service.populateImportedRoot(created,project,[{path:'.ponderosa-portable-review/user-data.json',data:bytes,sha256:createHash('sha256').update(bytes).digest('hex')}],[],undefined,path.join(root,'.ponderosa-import-backups'),[],'refuse',undefined,undefined,{work:root},true,true);
   const originalResolve=service.resolve.bind(service);let replaced=false;
   service.resolve=async(...args)=>{const observed=await originalResolve(...args);if(!replaced&&args[0].id===agent.id&&args[0].workingCopy.state==='ready'){replaced=true;await rename(root,retained);await cp(retained,root,{recursive:true,verbatimSymlinks:true});}return observed;};
   await assert.rejects(service.completeImportedGitRoots(project,pkg,{work:root},{git:true,harness:false},()=>{},[agent.id]),error=>/custody changed/.test(String(error.cause?.message)));
   assert.equal(replaced,true);assert.equal(store.getAgent(agent.id).workingCopy.state,'unavailable');assert.equal(await readFile(path.join(retained,'.ponderosa-portable-review/user-data.json'),'utf8'),bytes.toString());
   await assert.rejects(service.completeImportedGitRoots(project,pkg,{work:root},{git:true,harness:false},()=>{throw new Error('Never replay uncertain native actions');},[agent.id]),/exact populated phase/);
  }finally{release();}
 }finally{store?.close();await rm(base,{recursive:true,force:true});}
});


test('retained-original export ignores only exact generated hook links backed by canonical local proof', {skip:process.platform==='win32'},async()=>{
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-retained-hook-proof-')));
 try{
  const source=path.join(base,'source'),destination=path.join(base,'restored');await initialize(source);await mkdir(path.join(source,'user-hooks'));await writeFile(path.join(source,'user-hooks','pre-commit'),'#!/bin/sh\nexit 0\n');await git(source,'config','core.hooksPath','user-hooks');
  const manifest=await exportReviewedUserData(source,{git:true,harness:false}),original=Buffer.from(JSON.stringify(manifest)),selection={git:true,harness:false,source:'retained_originals'};
  const binding=manifest.gitExternalDependencies.bindings.find(binding=>binding.kind==='hooks'&&!binding.default&&binding.context==='worktree');assert.ok(binding,'Fixture must contain an actual relative hook declaration');
  await mkdir(destination);const review=path.join(destination,'.ponderosa-portable-review'),namespace=path.join(review,'active-git-hooks');await mkdir(review);await mkdir(namespace);await writeFile(path.join(review,'user-data.json'),original);
  const name=generatedHookName(binding.sourceConfigPath,binding.rawValue),text='../../hook-target',pathname=path.join(namespace,name);await mkdir(path.join(destination,'hook-target'));await symlink(text,pathname);
  const observedRoot=await lstat(destination,{bigint:true}),proof={schema:'ponderosa.generated-hook-namespace.v1',operationId:'fixture-local-completed-import',sourceOriginalSha256:createHash('sha256').update(original).digest('hex'),root:{device:observedRoot.dev.toString(),inode:observedRoot.ino.toString()},namespace:generatedHookIdentity(await lstat(namespace,{bigint:true})),links:[{name,text,identity:generatedHookIdentity(await lstat(pathname,{bigint:true}))}]};
  // Reorder stored keys as a canonical serializer may do; identity comparison is by value.
  proof.namespace=Object.fromEntries(Object.entries(proof.namespace).sort());proof.links[0].identity=Object.fromEntries(Object.entries(proof.links[0].identity).sort());
  const inventory=await inventoryWorkingFolder(destination,selection);
  assert.ok(inventory.excludedPaths.includes('.ponderosa-portable-review/active-git-hooks'));
  const reexport=proof=>exportWorkingFiles(destination,inventory.paths,64*1024*1024,inventory.links,selection,{data:original,canonicalGeneratedHooksProof:proof},undefined,undefined,inventory);
  await assert.rejects(reexport(),/canonical local creation-operation proof/,'Inventory admission cannot bypass canonical hook authority');
  const exported=await reexport(proof),retained=exported.artifacts.find(item=>item.path==='.ponderosa-portable-review/user-data.json');
  assert.deepEqual(Buffer.from(retained.dataBase64,'base64'),original,'Re-export carries canonical originals, never generated Git state');
  assert.deepEqual(exported.files.map(file=>file.path).sort(),[
   '.ponderosa-portable-review/current-git-evidence/manifest.json',
   '.ponderosa-portable-review/user-data.json',
  ],'Only the canonical original and its inert evidence manifest are exported');
  const evidenceFile=exported.files.find(file=>file.path==='.ponderosa-portable-review/current-git-evidence/manifest.json');
  const evidenceArtifact=exported.artifacts.find(item=>item.ref===evidenceFile.artifactRef);
  const evidence=JSON.parse((await decodePortableArtifactData(evidenceArtifact)).data);
  assert.deepEqual(evidence,{
   version:1,
   originalSha256:createHash('sha256').update(original).digest('hex'),
   namespaces:[],
   generatedObservations:[
    {name:'git-repository',state:'absent',nodes:[]},
    {name:'provider-files',state:'absent',nodes:[]},
   ],
  });
  await exported.verify();assert.equal(await readlink(pathname),text);
  await writeFile(path.join(review,'unrecognized-user-file'),'preserve unknown bytes');
  await assert.rejects(inventoryWorkingFolder(destination,selection),/Unknown retained review namespace/);
  assert.equal(await readFile(path.join(review,'unrecognized-user-file'),'utf8'),'preserve unknown bytes');
  await unlink(path.join(review,'unrecognized-user-file'));
  const captured=await captureRetainedReviewOriginal(destination,selection,original,proof);assert.deepEqual(captured.data,original);await captured.verify();
  await assert.rejects(captureRetainedReviewOriginal(destination,selection,original),/canonical local creation-operation proof/,'Editable working-root state cannot authorize its own exclusion');
  const foreign=structuredClone(proof);foreign.root.inode=(BigInt(foreign.root.inode)+1n).toString();await assert.rejects(captureRetainedReviewOriginal(destination,selection,original,foreign),/root differs/);
  const otherOriginal=structuredClone(proof);otherOriginal.sourceOriginalSha256='0'.repeat(64);await assert.rejects(captureRetainedReviewOriginal(destination,selection,original,otherOriginal),/canonical original/);
  await writeFile(path.join(namespace,'manifest.json'),JSON.stringify(proof));
  await assert.rejects(reexport(proof),/identity|contents/,'Whole-folder re-export must refuse unexported additions inside the generated namespace');
  await assert.rejects(captureRetainedReviewOriginal(destination,selection,original),/canonical local creation-operation proof/,'A forged receipt file is never used as authority');
  await assert.rejects(captureRetainedReviewOriginal(destination,selection,original,proof),/identity|contents/,'Unknown files remain visible and preserved');assert.equal(await readFile(path.join(namespace,'manifest.json'),'utf8'),JSON.stringify(proof));
  await unlink(path.join(namespace,'manifest.json'));
  // A real issuer would observe final creation state once; this is a fixture of
  // that trusted input, while store issuer/lookup tests cover canonical authority.
  const refreshed={...proof,namespace:generatedHookIdentity(await lstat(namespace,{bigint:true}))};
  const next=await captureRetainedReviewOriginal(destination,selection,original,refreshed);
  await unlink(pathname);await symlink('../../../outside-ignored-target',pathname);
  await assert.rejects(reexport(refreshed),/identity|changed/,'Whole-folder re-export must refuse changed generated aliases');
  await assert.rejects(next.verify(),/identity|changed/);assert.equal(await readlink(pathname),'../../../outside-ignored-target','Verifier preserves unknown replacement links');
  assert.deepEqual(await readFile(path.join(review,'user-data.json')),original,'Canonical source bytes are never mutated');
 }finally{await rm(base,{recursive:true,force:true});}
});

test('retained Git current evidence preserves edits and originals across two inert exports', {skip:process.platform==='win32'},async()=>{
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-current-git-evidence-')));
 try{
  const source=path.join(base,'source'),root=path.join(base,'retained'),destination=path.join(base,'destination'),second=path.join(base,'second');
  await initialize(source);const original=Buffer.from(JSON.stringify(await exportReviewedUserData(source,{git:true,harness:false})));
  const selection={git:true,harness:false,source:'retained_originals'},review=path.join(root,'.ponderosa-portable-review');
  await mkdir(root);await mkdir(review);await writeFile(path.join(review,'user-data.json'),original);
  await mkdir(path.join(review,'external-git'));await mkdir(path.join(review,'native-git-common'));await mkdir(path.join(review,'native-git-common','empty'));
  await writeFile(path.join(review,'external-git','edited.review'),'current inert user edit\n');
  await writeFile(path.join(review,'native-git-common','config'),'[core]\n\trepositoryformatversion = 0\n');
  await writeFile(path.join(review,'native-git-common','table'),'current reference evidence\n');
  await symlink('edited.review',path.join(review,'external-git','alias'));
  const capture=async folder=>{const inv=await inventoryWorkingFolder(folder,selection);return exportWorkingFiles(folder,inv.paths,64*1024*1024,inv.links,selection,{data:original},undefined,undefined,inv);};
  const entries=async result=>{const map=new Map(result.artifacts.map(artifact=>[artifact.ref,artifact]));return Promise.all(result.files.map(async file=>{const decoded=await decodePortableArtifactData(map.get(file.artifactRef));return {...file,data:decoded.data,sha256:decoded.sha256};}));};
  const first=await capture(root),input=await entries(first),saved=input.find(file=>file.path==='.ponderosa-portable-review/user-data.json');
  assert.deepEqual(saved.data,original,'canonical imported original is unchanged');
  const evidence=input.find(file=>file.path==='.ponderosa-portable-review/current-git-evidence/manifest.json'),current=JSON.parse(evidence.data);
  assert.equal(current.originalSha256,createHash('sha256').update(original).digest('hex'));
  assert.deepEqual(current.namespaces.map(item=>item.name),['external-git','native-git-common']);
  assert.equal(current.namespaces[0].links[0].path,'alias');
  const damaged=input.map(file=>({...file,data:Buffer.from(file.data)})),bad=damaged.find(file=>file.path===evidence.path);const forged=JSON.parse(bad.data);forged.originalSha256='0'.repeat(64);bad.data=Buffer.from(JSON.stringify(forged));bad.sha256=createHash('sha256').update(bad.data).digest('hex');
  await assert.rejects(importWorkingFiles(path.join(base,'forged'),damaged),/association/);
  await importWorkingFiles(destination,input);
  assert.deepEqual(await readFile(path.join(destination,'.ponderosa-portable-review','user-data.json')),original);
  const restored=path.join(destination,'.ponderosa-portable-review','current-git-evidence');
  assert.equal(await readFile(path.join(restored,'external-git','edited.review'),'utf8'),'current inert user edit\n');
  assert.equal(await readFile(path.join(restored,'native-git-common','table'),'utf8'),'current reference evidence\n');
  assert.equal((await lstat(path.join(restored,'external-git','edited.review'))).mode&0o777,0o600);
  await assert.rejects(lstat(path.join(restored,'external-git','alias')),{code:'ENOENT'});
  assert.equal((await lstat(path.join(restored,'native-git-common','empty'))).isDirectory(),true);
  // A source change after capture must invalidate the returned export proof.
  const firstProof=await capture(root),edited=path.join(review,'external-git','edited.review');
  await writeFile(edited,'later source edit\n');await assert.rejects(firstProof.verify(),/changed/);await writeFile(edited,'current inert user edit\n');
  const namespaceProof=await capture(root),newNamespace=path.join(review,'current-git-evidence');await mkdir(newNamespace);
  await assert.rejects(namespaceProof.verify(),/changed/);await rm(newNamespace,{recursive:true});
  // Generated original trees cannot be silently omitted if a user edited them.
  const generated=path.join(destination,'.ponderosa-portable-review','git-repository'),extra=path.join(generated,'private-edited-name');
  await writeFile(extra,'SYNTHETIC_SECRET_NOT_IN_ERROR');
  await assert.rejects(capture(destination),error=>{assert.match(error.message,/Generated review contents changed/);assert.doesNotMatch(error.message,/private-edited-name|SYNTHETIC_SECRET/);return true;});
  assert.equal(await readFile(extra,'utf8'),'SYNTHETIC_SECRET_NOT_IN_ERROR');await unlink(extra);
  const provider=path.join(destination,'.ponderosa-portable-review','provider-files'),providerEntries=await readdir(provider);
  const providerFile=path.join(provider,providerEntries.find(name=>name.endsWith('.review'))),providerOriginal=await readFile(providerFile);
  await writeFile(providerFile,'modified generated provider data');
  await assert.rejects(capture(destination),/Generated review contents changed/);
  assert.equal(await readFile(providerFile,'utf8'),'modified generated provider data');await writeFile(providerFile,providerOriginal);
  const again=await capture(destination),againInput=await entries(again);await importWorkingFiles(second,againInput);
  assert.deepEqual(await readFile(path.join(second,'.ponderosa-portable-review','user-data.json')),original);
  assert.equal(await readFile(path.join(second,'.ponderosa-portable-review','current-git-evidence','current-git-evidence','external-git','edited.review'),'utf8'),'current inert user edit\n');
  await writeFile(path.join(review,'external-git','credential.review'),'API_KEY=SYNTHETIC_SECRET_DONT_EXPORT');
  await assert.rejects(capture(root),/secret|credential/i);
  assert.equal(await readFile(path.join(review,'external-git','credential.review'),'utf8'),'API_KEY=SYNTHETIC_SECRET_DONT_EXPORT');
  for(const value of [Buffer.from('prefix\0Authorization: Bearer SYNTHETIC_BINARY_SECRET'),Buffer.concat([Buffer.from([255,254]),Buffer.from('\nextraheader=Basic SYNTHETIC_BINARY_SECRET')]),Buffer.from('A\0P\0I\0_\0K\0E\0Y\0=\0S\0Y\0N\0T\0H\0E\0T\0I\0C')]){
   await writeFile(path.join(review,'external-git','credential.review'),value);
   await assert.rejects(capture(root),error=>{assert.match(error.message,/credential|opaque binary/i);assert.doesNotMatch(error.message,/SYNTHETIC|credential.review/);return true;});
   assert.deepEqual(await readFile(path.join(review,'external-git','credential.review')),value);
  }
  await unlink(path.join(review,'external-git','credential.review'));
  const opaque=path.join(review,'native-git-common','table');await writeFile(opaque,Buffer.from([0,1,2,3,255]));
  await assert.rejects(capture(root),/opaque binary data/);assert.deepEqual(await readFile(opaque),Buffer.from([0,1,2,3,255]));
  const nativeFs=(await import('@ponderosa/native-host/fs')).promises,originalRealpath=nativeFs.realpath;
  const inspectInventory=await inventoryWorkingFolder(root,selection),namespace=path.join(review,'external-git');
  nativeFs.realpath=async (...args)=>{if(args[0]===namespace)throw new Error('EACCES synthetic-private-source-path');return originalRealpath(...args);};
  try{await assert.rejects(exportWorkingFiles(root,inspectInventory.paths,64*1024*1024,inspectInventory.links,selection,{data:original},undefined,undefined,inspectInventory),error=>{assert.match(error.message,/cannot be inspected/);assert.doesNotMatch(error.message,/synthetic-private-source-path/);return true;});}
  finally{nativeFs.realpath=originalRealpath;}
  await writeFile(path.join(review,'external-git','private-name.json'),'{invalid');
  await assert.rejects(capture(root),error=>{assert.match(error.message,/cannot be safely captured/);assert.doesNotMatch(error.message,/private-name/);return true;});
 }finally{await rm(base,{recursive:true,force:true});}
});

test('an internally deferred direct plan stays direct after a confirmed preflight-only failure',{skip:process.platform==='win32'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-direct-scope-'));
  try{
    const source=path.join(root,'source'),destination=path.join(root,'destination');await initialize(source);await mkdir(destination);
    const manifest=await exportReviewedUserData(source,{git:true,harness:false}),activation={git:true,harness:false},tasks=planReviewedRecoveryRoots(packageFor(manifest,{'file.txt':'committed\n'}),{work:destination},activation);
    const stat=await lstat(destination,{bigint:true}),identity={device:String(stat.dev),inode:String(stat.ino)},receipts=[];
    await assert.rejects(applyReviewedRecoveryRoots(tasks,activation,()=>{}, {[destination]:{...identity,inode:String(stat.ino+1n)}}),/original issued identity/);
    await assert.rejects(lstat(path.join(destination,'.git')),{code:'ENOENT'});
    await applyReviewedRecoveryRoots(tasks,activation,receipt=>receipts.push(structuredClone(receipt)),{[destination]:identity});
    assert.deepEqual(receipts.map(receipt=>receipt.state),['applying','completed']);
  }finally{await rm(root,{recursive:true,force:true});}
});


test('native planning compares transported hook originals above the config-only one-MiB bound',{skip:process.platform==='win32'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-large-hook-plan-'));
  try{
    const source=path.join(root,'source'),destination=path.join(root,'destination');await initialize(source);await mkdir(path.join(source,'.husky'));
    const hook='echo retained\n'.repeat(100000);await writeFile(path.join(source,'.husky','pre-commit'),hook);await git(source,'config','core.hooksPath','.husky');
    const manifest=await exportReviewedUserData(source,{git:true,harness:false}),tasks=planReviewedRecoveryRoots(packageFor(manifest,{'.husky/pre-commit':hook}),{work:destination},{git:true,harness:false});
    assert.equal(tasks[0].configuration.external.files.find(file=>file.path==='.husky/pre-commit').data.length,Buffer.byteLength(hook));
  }finally{await rm(root,{recursive:true,force:true});}
});


test('retained generated hook proof distinguishes a declared dangling source alias from an absent hook path', {skip:process.platform==='win32'},async()=>{
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-retained-dangling-hook-')));
 try{
  const source=path.join(base,'source'),destination=path.join(base,'restored');await initialize(source);
  await symlink('missing-hooks',path.join(source,'dangling-hooks'));await git(source,'config','core.hooksPath','dangling-hooks');
  const manifest=await exportReviewedUserData(source,{git:true,harness:false}),original=Buffer.from(JSON.stringify(manifest)),selection={git:true,harness:false,source:'retained_originals'};
  const family=manifest.gitExternalDependencies,binding=family.bindings.find(binding=>binding.kind==='hooks'&&!binding.default&&binding.context==='worktree');
  assert.ok(binding);assert.ok(family.links.some(link=>link.sourcePath===binding.resolvedPath),'Fixture retains its actual source alias');assert.ok(family.absentPaths.some(name=>name.endsWith('/missing-hooks')),'Fixture retains the negative alias target');assert.ok(!family.absentPaths.includes(binding.resolvedPath),'The alias itself exists');
  await mkdir(destination);const review=path.join(destination,'.ponderosa-portable-review'),namespace=path.join(review,'active-git-hooks');await mkdir(review);await mkdir(namespace);await writeFile(path.join(review,'user-data.json'),original);
  const name=generatedHookName(binding.sourceConfigPath,binding.rawValue),text='../../owned-dangling-alias';await symlink(text,path.join(namespace,name));
  const root=await lstat(destination,{bigint:true}),proof={schema:'ponderosa.generated-hook-namespace.v1',operationId:'fixture-dangling-source-import',sourceOriginalSha256:createHash('sha256').update(original).digest('hex'),root:{device:root.dev.toString(),inode:root.ino.toString()},namespace:generatedHookIdentity(await lstat(namespace,{bigint:true})),links:[{name,text,identity:generatedHookIdentity(await lstat(path.join(namespace,name),{bigint:true}))}]};
  const captured=await captureRetainedReviewOriginal(destination,selection,original,proof);await captured.verify();assert.deepEqual(captured.data,original);assert.equal(await readlink(path.join(namespace,name)),text);
 }finally{await rm(base,{recursive:true,force:true});}
});

test('synthetic repeated Git recreation produces identical file content',async()=>{
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'portable-recreation-compare-')));
 try{
  const source=path.join(base,'src');await initialize(source);
  const original=await exportReviewedUserData(source,{git:true,harness:false});
  const a=path.join(base,'a'),b=path.join(base,'b');await recreateReviewedGit(a,original.git);await recreateReviewedGit(b,original.git);
  const walk=async root=>{const result=[];const descend=async rel=>{for(const ent of (await readdir(path.join(root,rel),{withFileTypes:true})).sort((x,y)=>x.name.localeCompare(y.name))){const name=path.join(rel,ent.name),full=path.join(root,name),st=await lstat(full);if(st.isDirectory()){result.push([name,'dir',st.mode&0o777]);await descend(name);}else if(st.isFile())result.push([name,'file',st.mode&0o777,createHash('sha256').update(await readFile(full)).digest('hex')]);else if(st.isSymbolicLink())result.push([name,'symlink',await readlink(full)]);else throw Error('unsupported');}};await descend('');return result;};
  assert.deepEqual(await walk(a),await walk(b));
 }finally{await rm(base,{recursive:true,force:true});}
});
