import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,link,symlink,readlink,lstat,realpath,rename,chmod,rm,open,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fstatSync} from 'node:fs';
import {promisify} from 'node:util';
import {exportReviewedUserData,createGitExportCapture} from '../../apps/server/dist/portable-reviewed-user-data.js';
import {planReviewedRecoveryRoots,applyReviewedRecoveryRoots} from '../../apps/server/dist/portable-git-recreation.js';
import {getNativeGitExternalGraph} from '../../apps/server/dist/portable-git-external-application.js';
import {inventoryWorkingFolder,createWorkingNativeMetadataEvidence} from '../../apps/server/dist/portable-working-files.js';

const exec=promisify(execFile);
const git=async(cwd,...args)=>exec('git',['--no-optional-locks',...args],{cwd,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}});
const options={skip:process.platform!=='linux'};
const data=Buffer.from('#!/bin/sh\nexit 0\n');
const exactNs=1700000000123456789n;
const setExactMtime=async(target,symlink=false)=>exec('touch',[...(symlink?['-h']:[]),'-m','-d','@1700000000.123456789','--',target]);
const identity=stat=>({device:stat.dev.toString(),inode:stat.ino.toString()});
const destinationIdentity=async destination=>({...identity(await lstat(destination,{bigint:true})),directories:{hooks:identity(await lstat(path.join(destination,'hooks'),{bigint:true}))}});
const packageFor=(manifest,working={},bindings)=>{
 const files={'.ponderosa-portable-review/user-data.json':Buffer.from(JSON.stringify(manifest)),...working};
 return {schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Real Git graph custody regression',rootRef:'agent',agents:[{ref:'agent',title:'Agent',engine:'codex',workingRootRef:'work',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingFolder:{directories:[],excludedPaths:['.git']},workingFiles:Object.keys(files).map((name,index)=>({path:name,artifactRef:'file-'+index})),artifacts:Object.entries(files).map(([name,bytes],index)=>({ref:'file-'+index,kind:'generated_file',path:name,createdAt:new Date().toISOString(),dataBase64:Buffer.from(bytes).toString('base64')}))},...(bindings?[{ref:'storage-agent',title:'Storage',engine:'codex',workingRootRef:'storage',managerRef:'agent',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingFolder:{directories:[],excludedPaths:['.']},workingFiles:[]}]:[])],...(bindings?{gitStorageBindings:bindings}:{})};
};
async function fixture(t,worktree=false,selectedWorktree=false,extensions={}){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'native-real-graph-'))),source=path.join(root,'source'),destination=path.join(root,'destination');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(source);await mkdir(destination);
 await git(source,'init','--template=','--initial-branch=main');await git(source,'config','core.sharedRepository','group');
 const sourceHooks=worktree?path.join(source,'hooks'):path.join(source,'.git','hooks');
 await mkdir(sourceHooks);await writeFile(path.join(sourceHooks,'script'),data);await chmod(path.join(sourceHooks,'script'),0o751);
 if(!worktree){
  await link(path.join(sourceHooks,'script'),path.join(sourceHooks,'hard'));
  await symlink('script',path.join(sourceHooks,'symbol'));
  if(extensions.dangling)await symlink('missing',path.join(sourceHooks,'dangling'));
  await chmod(sourceHooks,0o2750);
  await setExactMtime(path.join(sourceHooks,'script'));
  await setExactMtime(path.join(sourceHooks,'symbol'),true);
  if(extensions.restrictive){await chmod(path.join(sourceHooks,'script'),0o400);await chmod(sourceHooks,0o500);}
  await setExactMtime(sourceHooks);
 } else {
  await git(source,'config','core.hooksPath','hooks');
  await mkdir(path.join(destination,'hooks'));await writeFile(path.join(destination,'hooks','script'),data);
 }
 let selected;
 if(selectedWorktree){
  const sourceSelected=path.join(source,'.hooks'),destinationSelected=path.join(destination,'.hooks');
  await mkdir(sourceSelected);await writeFile(path.join(sourceSelected,'run'),data);
  await chmod(path.join(sourceSelected,'run'),0o700);await link(path.join(sourceSelected,'run'),extensions.crossAlias?path.join(source,'shared-script'):path.join(sourceSelected,'hard'));
  await symlink('run',path.join(sourceSelected,'symbol'));await chmod(sourceSelected,0o750);
  await setExactMtime(path.join(sourceSelected,'run'));
  await setExactMtime(path.join(sourceSelected,'symbol'),true);
  await setExactMtime(sourceSelected);
  await git(source,'config','core.hooksPath','.hooks');
  await mkdir(destinationSelected);await writeFile(path.join(destinationSelected,'run'),data);
  await link(path.join(destinationSelected,'run'),extensions.crossAlias?path.join(destination,'shared-script'):path.join(destinationSelected,'hard'));
  await symlink('run',path.join(destinationSelected,'symbol'));
  selected={sourceFile:await lstat(path.join(sourceSelected,'run'),{bigint:true}),sourceDir:await lstat(sourceSelected,{bigint:true}),sourceLink:await lstat(path.join(sourceSelected,'symbol'),{bigint:true}),destinationFile:await lstat(path.join(destinationSelected,'run'),{bigint:true}),destinationDir:await lstat(destinationSelected,{bigint:true})};
 }
 const sourceFile=await lstat(path.join(sourceHooks,'script'),{bigint:true});
 const sourceDir=await lstat(sourceHooks,{bigint:true});
 const sourceLink=worktree?undefined:await lstat(path.join(sourceHooks,'symbol'),{bigint:true});
 const selection={git:true,harness:false,externalGitDependencies:true};
 const inventory=extensions.crossAlias?await inventoryWorkingFolder(source,selection):undefined;
 const manifest=await exportReviewedUserData(source,selection);
 const working=worktree?{'hooks/script':data}:selectedWorktree?(extensions.crossAlias?{'.hooks/run':data}:{'.hooks/run':data,'.hooks/hard':data}):{};
 const activation={git:true,harness:false},pkg=packageFor(manifest,working);
 if(inventory)pkg.agents[0].workingFolder.links=inventory.links;
 const tasks=planReviewedRecoveryRoots(pkg,{work:destination},activation);
 assert.equal(tasks.length,1);
 const graph=getNativeGitExternalGraph(tasks[0].configuration,{gitDir:path.join(destination,'.git'),privateDir:path.join(destination,'.git'),worktreePath:destination});
 return {root,source,destination,sourceHooks,sourceFile,sourceDir,sourceLink,selected,manifest,activation,tasks,graph,apply:(expected,beforeFinalize)=>applyReviewedRecoveryRoots(tasks,activation,()=>{},expected,undefined,beforeFinalize)};
}

test('real reviewed default hook graph restores exact alias and metadata evidence',options,async t=>{
 const f=await fixture(t,false,true);
 assert.equal(f.sourceFile.mtimeNs,exactNs);assert.equal(f.sourceLink.mtimeNs,exactNs);assert.equal(f.sourceDir.mtimeNs,exactNs);
 assert.equal(f.selected.sourceFile.mtimeNs,exactNs);assert.equal(f.selected.sourceLink.mtimeNs,exactNs);assert.equal(f.selected.sourceDir.mtimeNs,exactNs);
 const original=f.graph.files.find(node=>node.path.endsWith('/hooks/hard')||node.path.endsWith('/hooks/script'));
 assert.ok(original,'the real planner issues an owned original');
 const selectedPath=path.join(f.destination,'.hooks');
 assert.ok(f.graph.files.some(node=>node.path===path.join(selectedPath,'hard')||node.path===path.join(selectedPath,'run')),'the selected working original is planned separately');
 const issued={...identity(await lstat(f.destination,{bigint:true})),directories:{'.hooks':identity(f.selected.destinationDir)}};
 await f.apply({[f.destination]:issued});
 const target=path.join(f.destination,'.git','hooks'),file=await lstat(path.join(target,'script'),{bigint:true}),hard=await lstat(path.join(target,'hard'),{bigint:true}),dir=await lstat(target,{bigint:true}),symbol=await lstat(path.join(target,'symbol'),{bigint:true});
 assert.equal(file.dev,hard.dev);assert.equal(file.ino,hard.ino);assert.equal(file.nlink,2n);
 assert.equal(file.mode&0o7777n,f.sourceFile.mode&0o7777n);assert.equal(file.mtimeNs,f.sourceFile.mtimeNs);
 assert.equal(dir.mode&0o7777n,f.sourceDir.mode&0o7777n);assert.equal(dir.mtimeNs,f.sourceDir.mtimeNs);
 assert.equal(await readlink(path.join(target,'symbol')),'script');assert.equal(symbol.mtimeNs,f.sourceLink.mtimeNs);
 assert.deepEqual(await readFile(path.join(target,'script')),data);
 const reused=await lstat(path.join(selectedPath,'run'),{bigint:true}),selectedHard=await lstat(path.join(selectedPath,'hard'),{bigint:true});
 const selectedDir=await lstat(selectedPath,{bigint:true}),selectedSymbol=await lstat(path.join(selectedPath,'symbol'),{bigint:true});
 assert.equal(reused.dev,f.selected.destinationFile.dev);assert.equal(reused.ino,f.selected.destinationFile.ino);
 assert.equal(reused.ino,selectedHard.ino);assert.equal(reused.nlink,2n);assert.equal(reused.mode&0o7777n,f.selected.sourceFile.mode&0o7777n);assert.equal(reused.mtimeNs,f.selected.sourceFile.mtimeNs);
 assert.equal(selectedDir.mode&0o7777n,f.selected.sourceDir.mode&0o7777n);assert.equal(selectedDir.mtimeNs,f.selected.sourceDir.mtimeNs);
 assert.equal(await readlink(path.join(selectedPath,'symbol')),'run');assert.equal(selectedSymbol.mtimeNs,f.selected.sourceLink.mtimeNs);
 assert.deepEqual(await readFile(path.join(selectedPath,'run')),data);
});

test('real reviewed worktree hook requires original root custody before creating Git',options,async t=>{
 const f=await fixture(t,true),target=path.join(f.destination,'hooks','script');
 assert.ok(f.graph.files.some(file=>file.path===target),'the locally issued plan chooses the selected working original');
 await assert.rejects(f.apply(),/original issued import-root identity/);
 await assert.rejects(lstat(path.join(f.destination,'.git')),{code:'ENOENT'});
 await assert.rejects(f.apply({[f.destination]:{device:'0',inode:'0'}}),/identity|custody/);
 await assert.rejects(lstat(path.join(f.destination,'.git')),{code:'ENOENT'});
 assert.deepEqual(await readFile(target),data);
});

test('real reviewed worktree hook refuses changed destination bytes and retains metadata',options,async t=>{
 const f=await fixture(t,true),target=path.join(f.destination,'hooks','script'),issued=await destinationIdentity(f.destination);
 await writeFile(target,'different local bytes');
 const before=await lstat(target,{bigint:true});
 await assert.rejects(f.apply({[f.destination]:issued}),/original differs|bytes differ/);
 const after=await lstat(target,{bigint:true});
 assert.equal(after.ino,before.ino);assert.equal(after.mode,before.mode);assert.equal(after.mtimeNs,before.mtimeNs);
 assert.equal(await readFile(target,'utf8'),'different local bytes');
});

test('real reviewed worktree hook refuses undeclared existing hardlink custody',options,async t=>{
 const f=await fixture(t,true),target=path.join(f.destination,'hooks','script'),alias=path.join(f.destination,'undeclared-alias');
 await link(target,alias);const issued=await destinationIdentity(f.destination),before=await lstat(target,{bigint:true});
 await assert.rejects(f.apply({[f.destination]:issued}),/aliases outside its complete declared graph/);
 const after=await lstat(target,{bigint:true});
 assert.equal(after.ino,before.ino);assert.equal(after.mode,before.mode);assert.equal(after.mtimeNs,before.mtimeNs);
 assert.deepEqual(await readFile(alias),data);
});

test('real reviewed worktree hook refuses a replaced byte-phase directory',options,async t=>{
 const f=await fixture(t,true),target=path.join(f.destination,'hooks'),retained=path.join(f.destination,'retained-hooks');
 const issued=await destinationIdentity(f.destination);
 await rename(target,retained);await mkdir(target);await writeFile(path.join(target,'script'),data);
 const before=await lstat(target,{bigint:true}),fileBefore=await lstat(path.join(target,'script'),{bigint:true});
 await assert.rejects(f.apply({[f.destination]:issued}),/lost its original byte-phase custody|identity|custody/);
 const after=await lstat(target,{bigint:true}),fileAfter=await lstat(path.join(target,'script'),{bigint:true});
 assert.equal(after.ino,before.ino);assert.equal(after.mode,before.mode);assert.equal(after.mtimeNs,before.mtimeNs);
 assert.equal(fileAfter.mode,fileBefore.mode);assert.equal(fileAfter.mtimeNs,fileBefore.mtimeNs);
 assert.deepEqual(await readFile(path.join(retained,'script')),data);assert.deepEqual(await readFile(path.join(target,'script')),data);
});

test('real reviewed dangling hook retains only its captured absent target',options,async t=>{
 const f=await fixture(t,false,false,{dangling:true});
 const dangling=path.join(f.destination,'.git','hooks','dangling'),missing=path.join(f.destination,'.git','hooks','missing');
 assert.ok(f.manifest.gitExternalDependencies.absentPaths.includes(path.join(f.sourceHooks,'missing')),'source absence is captured');
 assert.ok(f.graph.absentPaths.some(node=>node.path===missing),'issued plan names the same owned absent destination');
 assert.ok(f.graph.links.some(node=>node.path===dangling&&node.target===missing),'issued plan binds the passive alias to that absence');
 await f.apply();
 assert.equal(await readlink(dangling),'missing');
 await assert.rejects(lstat(missing),{code:'ENOENT'});
});

test('real reviewed working alias receives one exact native file proof',options,async t=>{
 const f=await fixture(t,false,true,{crossAlias:true});
 const target=path.join(f.destination,'.hooks','run'),alias=path.join(f.destination,'shared-script');
 const issued={...identity(await lstat(f.destination,{bigint:true})),directories:{'.hooks':identity(f.selected.destinationDir)}};
 assert.ok(f.tasks[0].workingAliases.some(row=>row.path===alias&&row.target===target),'the selected working alias is part of the issued task');
 await f.apply({[f.destination]:issued});
 const actual=await lstat(alias,{bigint:true}),original=await lstat(target,{bigint:true});
 assert.equal(actual.dev,original.dev);assert.equal(actual.ino,original.ino);assert.equal(actual.ino,f.selected.destinationFile.ino);
 assert.equal(actual.nlink,2n);assert.equal(actual.mtimeNs,f.selected.sourceFile.mtimeNs);assert.equal(actual.mode&0o7777n,f.selected.sourceFile.mode&0o7777n);
 const proof=f.tasks[0].configuration.fileProofs.get(alias);
 assert.equal(proof.inode,actual.ino.toString());assert.equal(proof.expectedLinkCount,'2');assert.equal(proof.mtimeNs,f.selected.sourceFile.mtimeNs.toString());
 assert.equal(f.tasks[0].configuration.nativeMetadata.protectedFiles.get(alias).mtimeNs,f.selected.sourceFile.mtimeNs.toString());
 assert.deepEqual(await readFile(alias),data);
});

test('real root hook reference preserves original root identity and metadata',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'native-real-root-hook-'))),source=path.join(root,'source'),destination=path.join(root,'destination');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(source);await mkdir(destination);
 await git(source,'init','--template=','--initial-branch=main');
 await mkdir(path.join(source,'support'));await writeFile(path.join(source,'support','script'),data);await chmod(path.join(source,'support','script'),0o751);
 await mkdir(path.join(source,'.git','hooks'));
 // Capture the selected working file first, then its Git-owned hardlink. This
 // is a real cross-scope inode, not an injected native-plan node.
 await symlink(path.join(source,'support','script'),path.join(source,'.git','hooks','a-source'));
 await link(path.join(source,'support','script'),path.join(source,'.git','hooks','from-working-root'));
 await symlink(source,path.join(source,'.git','hooks','root'));
 await git(source,'config','core.hooksPath',source);
 await setExactMtime(path.join(source,'support','script'));
 await chmod(source,0o700);await setExactMtime(source);
 const capturedRoot=await lstat(source,{bigint:true}),capturedFile=await lstat(path.join(source,'support','script'),{bigint:true});
 await mkdir(path.join(destination,'support'));await writeFile(path.join(destination,'support','script'),data);
 const originalFile=await lstat(path.join(destination,'support','script'),{bigint:true}),originalRoot=await lstat(destination,{bigint:true}),originalSupport=await lstat(path.join(destination,'support'),{bigint:true});
 const manifest=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});
 const activation={git:true,harness:false},pkg=packageFor(manifest,{'support/script':data});
 const tasks=planReviewedRecoveryRoots(pkg,{work:destination},activation);
 const graph=getNativeGitExternalGraph(tasks[0].configuration,{gitDir:path.join(destination,'.git'),privateDir:path.join(destination,'.git'),worktreePath:destination});
 assert.ok(graph.rootMetadata.some(node=>node.path===destination),'root metadata originates in the reviewed selected worktree');
 const rootView=graph.links.find(node=>node.kind==='symlink'&&node.target===destination);
 assert.ok(rootView,'the production planner issues a reference to the selected root');
 const crossLink=graph.links.find(node=>node.kind==='hardlink'&&node.path===path.join(destination,'.git','hooks','from-working-root')&&node.target===path.join(destination,'support','script'));
 assert.ok(crossLink,'the captured Git-owned hardlink targets the selected working original');
 const issued={...identity(originalRoot),directories:{support:identity(originalSupport)}};
 await applyReviewedRecoveryRoots(tasks,activation,()=>{},{[destination]:issued});
 const afterRoot=await lstat(destination,{bigint:true}),afterFile=await lstat(path.join(destination,'support','script'),{bigint:true});
 assert.equal(afterRoot.dev,originalRoot.dev);assert.equal(afterRoot.ino,originalRoot.ino);
 assert.equal(afterRoot.mode&0o7777n,capturedRoot.mode&0o7777n);assert.equal(afterRoot.mtimeNs,capturedRoot.mtimeNs);
 assert.equal(afterFile.dev,originalFile.dev);assert.equal(afterFile.ino,originalFile.ino);assert.deepEqual(await readFile(path.join(destination,'support','script')),data);
 const cross=await lstat(crossLink.path,{bigint:true});assert.equal(cross.dev,afterFile.dev);assert.equal(cross.ino,afterFile.ino);assert.equal(afterFile.nlink,2n);
 assert.equal(afterFile.mode&0o7777n,capturedFile.mode&0o7777n);assert.equal(afterFile.mtimeNs,capturedFile.mtimeNs);
 assert.equal(await realpath(rootView.path),destination);
});

test('real reviewed repositories defer shared native metadata until every task is ready',options,async t=>{
 const first=await fixture(t,false,false,{restrictive:true}),second=await fixture(t,false,false,{restrictive:true});
 try{
 const scope={},metadata=createWorkingNativeMetadataEvidence(),firstConfig=first.tasks[0].configuration,secondConfig=second.tasks[0].configuration;
 for(const config of [firstConfig,secondConfig]){config.nativeMetadataScope=scope;config.deferNativeMetadata=true;}
 const firstNode=first.graph.files.find(node=>node.path.endsWith('/hooks/script')||node.path.endsWith('/hooks/hard'));
 assert.ok(firstNode,'the real first plan contains a default hook original');
 await applyReviewedRecoveryRoots(first.tasks,first.activation,()=>{},undefined,metadata);
 const firstFile=firstNode.path;
 assert.notEqual((await lstat(firstFile,{bigint:true})).mode&0o400n,0n,'the first held original remains readable while another task is pending');
 await applyReviewedRecoveryRoots(second.tasks,second.activation,()=>{},undefined,metadata);
 assert.equal(firstConfig.prepareNativeMetadata,secondConfig.prepareNativeMetadata);
 assert.equal(firstConfig.finalizeNativeMetadata,secondConfig.finalizeNativeMetadata);
 await firstConfig.prepareNativeMetadata();
 // A later ordinary-working metadata consumer attaches a callback to the
 // already-issued shared scope; the native graph itself is never changed.
 let invoked=0;
 metadata.deferredMetadata.set(firstFile,{kind:'file',mode:Number(first.sourceFile.mode&0o7777n),mtimeNs:first.sourceFile.mtimeNs.toString(),apply:held=>{
  const observed=fstatSync(held.fd,{bigint:true});assert.equal(observed.dev,held.expectedDevice);assert.equal(observed.ino,held.expectedInode);
  assert.equal(observed.nlink,2n);assert.equal(held.expectedLinkCount,2n);invoked++;
 }});
 await firstConfig.finalizeNativeMetadata();
 assert.equal(invoked,1);
 for(const f of [first,second]){
  const node=f.graph.files.find(item=>item.path.endsWith('/hooks/script')||item.path.endsWith('/hooks/hard'));
  const file=await lstat(node.path,{bigint:true}),directory=await lstat(path.dirname(node.path),{bigint:true});
  assert.equal(file.mode&0o7777n,f.sourceFile.mode&0o7777n);assert.equal(file.mtimeNs,f.sourceFile.mtimeNs);
  assert.equal(directory.mode&0o7777n,f.sourceDir.mode&0o7777n);assert.equal(directory.mtimeNs,f.sourceDir.mtimeNs);
 }
 await assert.rejects(firstConfig.finalizeNativeMetadata(),/cannot be replayed/);
 await assert.rejects(firstConfig.prepareNativeMetadata(),/cannot be replayed/);
 }finally{
  for(const f of [first,second]){
   await chmod(f.sourceHooks,0o700).catch(()=>{});
   await chmod(path.join(f.destination,'.git','hooks'),0o700).catch(()=>{});
  }
 }
});

test('relative-dot hook capture keeps exact owner Git storage and relocates both contexts safely',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'native-dot-hook-'))),source=path.join(root,'source'),destination=path.join(root,'destination');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(source);await mkdir(destination);await git(source,'init','--template=','--initial-branch=main');
 const workHook=Buffer.from('#!/bin/sh\n# worktree hook\n'),gitHook=Buffer.from('#!/bin/sh\n# gitdir hook\n');
 await writeFile(path.join(source,'pre-commit'),workHook);await writeFile(path.join(source,'.git','pre-commit'),gitHook);
 await git(source,'config','core.hooksPath','.');await git(source,'config','credential.helper','fixture-secret-helper');
 const configAlias=path.join(source,'.git','prepare-commit-msg');
 await link(path.join(source,'.git','config'),configAlias);
 await assert.rejects(exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true}),/bounded regular original/);
 await unlink(configAlias);
 const manifest=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});
 const family=manifest.gitExternalDependencies,ownerGit=path.join(source,'.git');
 assert.ok(family.bindings.some(row=>row.kind==='hooks'&&row.rawValue==='.'&&row.context==='worktree'&&row.resolvedPath===source));
 assert.ok(family.bindings.some(row=>row.kind==='hooks'&&row.rawValue==='.'&&row.context==='gitdir'&&row.resolvedPath===ownerGit));
 assert.ok(!family.repositories?.some(row=>row.sourcePath===ownerGit),'owner Git storage is not recaptured as a bare repository');
 assert.ok(!family.files.some(row=>row.sourcePath===path.join(ownerGit,'config')),'Git config remains in the sanitized Git capsule');
 assert.doesNotMatch(JSON.stringify(manifest),/fixture-secret-helper/);
 await writeFile(path.join(destination,'pre-commit'),workHook);
 const activation={git:true,harness:false},tasks=planReviewedRecoveryRoots(packageFor(manifest,{'pre-commit':workHook}),{work:destination},activation);
 const context={gitDir:path.join(destination,'.git'),privateDir:path.join(destination,'.git'),worktreePath:destination};
 const graph=getNativeGitExternalGraph(tasks[0].configuration,context),gitFile=graph.files.find(row=>row.data.equals(gitHook));
 assert.ok(gitFile,'the exact Git-directory hook has a planner-issued destination');
 const before=await lstat(path.join(destination,'pre-commit'),{bigint:true});
 const rootIdentity=identity(await lstat(destination,{bigint:true}));
 await applyReviewedRecoveryRoots(tasks,activation,()=>{},{[destination]:rootIdentity});
 const after=await lstat(path.join(destination,'pre-commit'),{bigint:true});
 assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);assert.deepEqual(await readFile(path.join(destination,'pre-commit')),workHook);
 assert.deepEqual(await readFile(gitFile.path),gitHook);
 // Inspect the restored configuration without running hooks: relative values
 // must resolve to the captured original in each native Git execution context.
 const hookSetting=(await git(destination,'config','--get','core.hooksPath')).stdout.trim();
 const workContext=await realpath(path.resolve(destination,hookSetting));
 const gitContext=await realpath(path.resolve(destination,'.git',hookSetting));
 assert.deepEqual(await readFile(path.join(workContext,'pre-commit')),workHook);
 assert.deepEqual(await readFile(path.join(gitContext,'pre-commit')),gitHook);
 await assert.rejects(lstat(path.join(gitContext,'config')),{code:'ENOENT'});
});

test('relative-dot hooks retain initialized and dormant module storage without recapturing native controls',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'native-dot-modules-'))),source=path.join(root,'source'),child=path.join(root,'child');
 t.after(()=>rm(root,{recursive:true,force:true}));
 const initialize=async dir=>{await mkdir(dir);await git(dir,'init','--template=','--initial-branch=main');await git(dir,'config','user.name','Fixture');await git(dir,'config','user.email','fixture@example.invalid');await writeFile(path.join(dir,'file.txt'),'committed\n');await git(dir,'add','file.txt');await git(dir,'commit','--no-gpg-sign','-m','Initial');};
 await initialize(child);await initialize(source);
 await git(source,'-c','protocol.file.allow=always','submodule','add',child,'module');
 await git(source,'config','-f','.gitmodules','submodule.module.url','https://example.invalid/module');
 await git(source,'config','submodule.module.url','https://example.invalid/module');
 await git(path.join(source,'module'),'remote','set-url','origin','https://example.invalid/module');
 await git(source,'add','.gitmodules','module');await git(source,'commit','--no-gpg-sign','-m','Add module');
 const gitmodules=await readFile(path.join(source,'.gitmodules')),childHead=(await git(path.join(source,'module'),'rev-parse','HEAD')).stdout.trim();
 const workHook=Buffer.from('worktree hook\n'),gitHook=Buffer.from('gitdir hook\n');
 await writeFile(path.join(source,'pre-commit'),workHook);await writeFile(path.join(source,'.git','pre-commit'),gitHook);
 await git(source,'config','core.hooksPath','.');
 for(const initialized of [true,false]){
  if(!initialized)await git(source,'submodule','deinit','-f','module');
  const manifest=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});
  assert.equal(manifest.git.modules.length,1);assert.equal(manifest.git.modules[0].source.initialized,initialized);
  const ownerGit=path.join(source,'.git'),moduleStorage=path.join(ownerGit,'modules');
  assert.ok(!manifest.gitExternalDependencies.repositories?.some(row=>row.sourcePath===ownerGit||row.sourcePath.startsWith(moduleStorage+path.sep)));
  assert.ok(manifest.gitExternalDependencies.files.filter(row=>row.sourcePath.startsWith(moduleStorage+path.sep)).every(row=>row.sourcePath.startsWith(path.join(moduleStorage,'module','hooks')+path.sep)),'only the separately declared child hook tree is captured');
  const destination=path.join(root,initialized?'active':'dormant');await mkdir(destination);await mkdir(path.join(destination,'module'));
  await writeFile(path.join(destination,'file.txt'),'committed\n');await writeFile(path.join(destination,'.gitmodules'),gitmodules);await writeFile(path.join(destination,'pre-commit'),workHook);
  const working={'file.txt':Buffer.from('committed\n'),'.gitmodules':gitmodules,'pre-commit':workHook};
  if(initialized){await writeFile(path.join(destination,'module','file.txt'),'committed\n');working['module/file.txt']=Buffer.from('committed\n');}
  const activation={git:true,harness:false},tasks=planReviewedRecoveryRoots(packageFor(manifest,working),{work:destination},activation);
  const issued={...identity(await lstat(destination,{bigint:true})),directories:{module:identity(await lstat(path.join(destination,'module'),{bigint:true}))}};
  await applyReviewedRecoveryRoots(tasks,activation,()=>{},{[destination]:issued});
  assert.deepEqual(await readFile(path.join(destination,'pre-commit')),workHook);
  if(initialized)assert.equal((await git(path.join(destination,'module'),'rev-parse','HEAD')).stdout.trim(),childHead);
  else {
   await assert.rejects(lstat(path.join(destination,'module','.git')),{code:'ENOENT'});
   assert.equal((await git(destination,'--git-dir='+path.join(destination,'.git','modules','module'),'rev-parse','HEAD')).stdout.trim(),childHead);
  }
 }
});

test('relative-dot hooks in linked worktrees retain private controls and relocate both contexts',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'native-dot-linked-'))),source=path.join(root,'source'),linked=path.join(root,'linked'),work=path.join(root,'new-work'),storage=path.join(root,'new-storage'),handles=[];
 let capture;
 t.after(async()=>{await capture?.close();for(const handle of handles)await handle.close();await rm(root,{recursive:true,force:true});});
 await mkdir(source);await git(source,'init','--template=','--initial-branch=main');await git(source,'config','user.name','Fixture');await git(source,'config','user.email','fixture@example.invalid');
 await writeFile(path.join(source,'file.txt'),'committed\n');await git(source,'add','file.txt');await git(source,'commit','--no-gpg-sign','-m','Initial');await git(source,'worktree','add','-b','linked',linked);
 const common=path.join(source,'.git'),privateDir=path.join(common,'worktrees','linked');
 const workHook=Buffer.from('linked worktree hook\n'),gitHook=Buffer.from('linked private hook\n');
 await writeFile(path.join(linked,'pre-commit'),workHook);await writeFile(path.join(privateDir,'pre-commit'),gitHook);await git(source,'config','core.hooksPath','.');
 const roots=[];for(const [pathname,ref] of [[linked,'work'],[common,'storage']]){const handle=await open(pathname,'r');handles.push(handle);roots.push({pathname,ref,handle,owner:(await handle.stat({bigint:true})).uid});}
 const bindings=[{id:'common',worktreeRootRef:'work',storageRootRef:'storage',relativePath:'.',role:'common',worktreePath:linked,storagePath:common},{id:'private',worktreeRootRef:'work',storageRootRef:'storage',relativePath:'worktrees/linked',role:'private',worktreePath:linked,storagePath:common}];
 await git(source,'config','--unset','core.hooksPath');capture=createGitExportCapture(roots,bindings);
 await assert.rejects(exportReviewedUserData(linked,{git:true,harness:false,externalGitDependencies:true},capture),/Unsupported selected Git storage/);
 await capture.close();await git(source,'config','core.hooksPath','.');
 const configAlias=path.join(privateDir,'prepare-commit-msg');await link(path.join(common,'config'),configAlias);capture=createGitExportCapture(roots,bindings);
 await assert.rejects(exportReviewedUserData(linked,{git:true,harness:false,externalGitDependencies:true},capture),/bounded regular original/);
 await capture.close();await unlink(configAlias);
 const unknown=path.join(privateDir,'sequencer');await writeFile(unknown,'unrecognized operation state');capture=createGitExportCapture(roots,bindings);
 await assert.rejects(exportReviewedUserData(linked,{git:true,harness:false,externalGitDependencies:true},capture),/Unsupported selected Git storage/);
 await capture.close();await unlink(unknown);
 for(const value of ['./','./.']){
  await git(source,'config','core.hooksPath',value);capture=createGitExportCapture(roots,bindings);
  const alternate=await exportReviewedUserData(linked,{git:true,harness:false,externalGitDependencies:true},capture);
  assert.ok(alternate.gitExternalDependencies.files.some(row=>row.sourcePath===path.join(privateDir,'pre-commit')));
  await capture.close();
 }
 await git(source,'config','core.hooksPath','.');capture=createGitExportCapture(roots,bindings);
 const manifest=await exportReviewedUserData(linked,{git:true,harness:false,externalGitDependencies:true},capture),review=Buffer.from(JSON.stringify(manifest));capture.bindReview(linked,review);
 const family=manifest.gitExternalDependencies;
 assert.ok(family.bindings.some(row=>row.kind==='hooks'&&row.rawValue==='.'&&row.context==='worktree'&&row.resolvedPath===linked));
 assert.ok(family.bindings.some(row=>row.kind==='hooks'&&row.rawValue==='.'&&row.context==='gitdir'&&row.resolvedPath===privateDir));
 assert.ok(!family.repositories?.some(row=>row.sourcePath===privateDir||row.sourcePath===common));
 for(const name of ['commondir','gitdir','locked','HEAD','index'])assert.ok(!family.files.some(row=>row.sourcePath===path.join(privateDir,name)),'native private control must not be a hook payload: '+name);
 await mkdir(work);await mkdir(storage);await writeFile(path.join(work,'file.txt'),'committed\n');await writeFile(path.join(work,'pre-commit'),workHook);
 const portable=capture.portableBindings(),activation={git:true,harness:false},pkg=packageFor(manifest,{'file.txt':Buffer.from('committed\n'),'pre-commit':workHook},portable);
 const tasks=planReviewedRecoveryRoots(pkg,{work,storage},activation),rootIdentity=identity(await lstat(work,{bigint:true})),storageIdentity=identity(await lstat(storage,{bigint:true}));
 await applyReviewedRecoveryRoots(tasks,activation,()=>{},{[work]:rootIdentity,[storage]:storageIdentity});
 const hookSetting=(await git(work,'config','--get','core.hooksPath')).stdout.trim(),privateDest=path.join(storage,'worktrees','linked');
 const workContext=await realpath(path.resolve(work,hookSetting)),gitContext=await realpath(path.resolve(privateDest,hookSetting));
 assert.deepEqual(await readFile(path.join(workContext,'pre-commit')),workHook);
 assert.deepEqual(await readFile(path.join(gitContext,'pre-commit')),gitHook);
 await assert.rejects(lstat(path.join(gitContext,'gitdir')),{code:'ENOENT'});
 assert.equal(await realpath((await git(work,'rev-parse','--absolute-git-dir')).stdout.trim()),privateDest);
});

test('native Git hook paths cannot expose an unselected included config through a hardlink',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'native-dot-include-alias-'))),source=path.join(root,'source'),config=path.join(root,'external.conf');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(source);await git(source,'init','--template=','--initial-branch=main');
 await writeFile(config,'[credential]\n helper = fixture-hidden-secret\n');
 await mkdir(path.join(source,'.git','hooks'));
 for(const value of ['.','./','./.','hooks']){
  await git(source,'config','core.hooksPath',value);
  await git(source,'config','--replace-all','include.path',config);
  const hookPath=path.join(source,'.git',value==='hooks'?'hooks':'','pre-commit');
  await link(config,hookPath);
  await assert.rejects(exportReviewedUserData(source,{git:true,harness:false}),/hardlinks require every original alias|bounded regular original/);
  const selected=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});
  assert.doesNotMatch(JSON.stringify(selected),/fixture-hidden-secret/);
  const configFile=selected.gitExternalDependencies.files.find(row=>row.sourcePath===hookPath);
  assert.ok(configFile?.config&&configFile.removedSecretFields,'the shared original must be sanitized as configuration: '+value);
  assert.ok(selected.gitExternalDependencies.links.some(row=>row.sourcePath===config&&row.targetSourcePath===hookPath&&row.kind==='hardlink'));
  await unlink(hookPath);
 }
});

test('working hook paths cannot expose an unselected included config through a hardlink',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'working-hook-include-alias-'))),source=path.join(root,'source'),config=path.join(root,'external.conf'),hooks=path.join(source,'hooks');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(source);await git(source,'init','--template=','--initial-branch=main');await mkdir(hooks);
 await git(source,'config','core.hooksPath','hooks');
 await writeFile(config,'[credential]\n helper = fixture-hidden-secret\n');await link(config,path.join(hooks,'pre-commit'));
 await git(source,'config','--add','include.path',config);
 await assert.rejects(exportReviewedUserData(source,{git:true,harness:false}),/hardlinks require every original alias/);
 const selected=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});
 assert.doesNotMatch(JSON.stringify(selected),/fixture-hidden-secret/);
 assert.ok(selected.gitExternalDependencies.files.some(row=>row.config&&row.removedSecretFields));
});

test('external hook paths cannot expose an excluded config through a hardlink',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'external-hook-include-alias-'))),source=path.join(root,'source'),privateDir=path.join(root,'.ssh'),config=path.join(privateDir,'external.conf'),hooks=path.join(root,'external-hooks');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(source);await mkdir(privateDir);await mkdir(hooks);await git(source,'init','--template=','--initial-branch=main');
 await git(source,'config','core.hooksPath',hooks);
 await writeFile(config,'[credential]\n helper = fixture-hidden-secret\n');await link(config,path.join(hooks,'pre-commit'));
 await git(source,'config','--add','include.path',config);
 await assert.rejects(exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true}),/hardlinks require every original alias/);
});

test('an unvisited selected-working hardlink is held until its alias has dependency custody',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'unvisited-selected-alias-'))),source=path.join(root,'source');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(source);await git(source,'init','--template=','--initial-branch=main');await mkdir(path.join(source,'.git','hooks'));
 const working=path.join(source,'working-original');await writeFile(working,'selected working content\n');
 await link(working,path.join(source,'.git','hooks','pre-commit'));
 await assert.rejects(exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true}),/hardlinks require every original alias/);
 assert.equal(await readFile(working,'utf8'),'selected working content\n');
});
