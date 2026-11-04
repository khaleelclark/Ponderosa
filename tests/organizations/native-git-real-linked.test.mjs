import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,realpath,rm,chmod,utimes,link,open} from 'node:fs/promises';
import {lstatSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {exportReviewedUserData,createGitExportCapture,verifyGitExportAssociations} from '../../apps/server/dist/portable-reviewed-user-data.js';
import {planReviewedRecoveryRoots,applyReviewedRecoveryRoots} from '../../apps/server/dist/portable-git-recreation.js';
import {planReviewedGitExternalApplication} from '../../apps/server/dist/portable-git-external-application.js';

const exec=promisify(execFile);
const git=async(cwd,...args)=>(await exec('git',['--no-optional-locks',...args],{cwd,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();
const options={skip:process.platform!=='linux'};
const packageFor=(manifest,working={})=>{
 const entries={'.ponderosa-portable-review/user-data.json':Buffer.from(JSON.stringify(manifest)),...working};
 return {schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Real linked Git regression',rootRef:'agent',agents:[{ref:'agent',title:'Agent',engine:'codex',workingRootRef:'work',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingFolder:{directories:[],excludedPaths:['.git']},workingFiles:Object.keys(entries).map((name,i)=>({path:name,artifactRef:'file-'+i})),artifacts:Object.entries(entries).map(([name,data],i)=>({ref:'file-'+i,kind:'generated_file',path:name,createdAt:new Date().toISOString(),dataBase64:Buffer.from(data).toString('base64')}))}]};
};
async function initialize(root,reftable=false){await mkdir(root);await git(root,'init','--template=','--initial-branch=main',...(reftable?['--ref-format=reftable']:[]));await git(root,'config','user.name','Fixture');await git(root,'config','user.email','fixture@example.invalid');await writeFile(path.join(root,'file.txt'),'committed\n');await git(root,'add','file.txt');await git(root,'commit','--no-gpg-sign','-m','initial');}

for(const includeExclude of [true,false])test('real captured bare dependency preserves '+(includeExclude?'present':'absent')+' controls without a working pointer',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'real-bare-restore-'))),source=path.join(root,'source'),destination=path.join(root,'destination'),dependencies=path.join(root,'dependencies');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await initialize(source);await mkdir(destination);await mkdir(dependencies);
 const bare=path.join(dependencies,'archive.git');await git(root,'clone','--bare','--no-hardlinks',source,bare);
 await writeFile(path.join(bare,'README.txt'),'retained ancillary bytes\n');await git(source,'config','core.hooksPath',dependencies);
 await writeFile(path.join(bare,'info','attributes'),'*.txt text\n');
 await writeFile(path.join(bare,'info','local-extra'),'retained extra\n');
 await writeFile(path.join(bare,'info','sparse-checkout'),'/*.txt\n');
 await chmod(path.join(bare,'info','attributes'),0o600);await utimes(path.join(bare,'info','attributes'),1700000000.123,1700000000.123);
 await chmod(path.join(bare,'info','exclude'),0o640);await utimes(path.join(bare,'info','exclude'),1700000001.456,1700000001.456);
 if(!includeExclude)await rm(path.join(bare,'info','exclude'));
 const sourceHead=await git(source,'rev-parse','HEAD');
 const originalExclude=includeExclude?await readFile(path.join(bare,'info','exclude')):undefined;
 const sourceExclude=includeExclude?await lstat(path.join(bare,'info','exclude'),{bigint:true}):undefined;
 const sourceSparse=await lstat(path.join(bare,'info','sparse-checkout'),{bigint:true});
 const sourceAttributes=await lstat(path.join(bare,'info','attributes'),{bigint:true});
 const manifest=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});
 assert.ok(manifest.gitExternalDependencies.repositories.some(repository=>repository.sourcePath===bare&&repository.bare===true));
 const activation={git:true,harness:false},pkg=packageFor(manifest,{'file.txt':Buffer.from('committed\n')});
 await writeFile(path.join(destination,'file.txt'),'committed\n');
 const noProvenance=structuredClone(manifest);delete noProvenance.gitExternalDependencies.repositories.find(item=>item.sourcePath===bare).git.configurationSourceDirectories;
 assert.throws(()=>planReviewedRecoveryRoots(packageFor(noProvenance,{'file.txt':Buffer.from('committed\n')}),{work:destination},activation),/provenance/);
 const conflicting=structuredClone(manifest),duplicate=conflicting.gitExternalDependencies.files.find(file=>file.sourcePath===path.join(bare,'info','attributes'));
 assert.ok(duplicate,'real capture retained both capsule and external evidence');
 duplicate.dataBase64=Buffer.from('conflicting original\n').toString('base64');
 assert.throws(()=>planReviewedRecoveryRoots(packageFor(conflicting,{'file.txt':Buffer.from('committed\n')}),{work:destination},activation),/control original differs/);
 const info=path.join(bare,'info'),attribute=path.join(info,'attributes'),context={common:path.join(destination,'.git'),private:path.join(destination,'.git'),worktree:destination};
 const plan=value=>planReviewedGitExternalApplication(value,activation,context,[destination],new Map());
 const nullControl=structuredClone(manifest);nullControl.gitExternalDependencies.repositories.find(item=>item.sourcePath===bare).git.infoReview.find(item=>item.path==='info/attributes').dataBase64=null;
 assert.throws(()=>plan(nullControl),/control original differs/);
 const missing=structuredClone(manifest);missing.gitExternalDependencies.files=missing.gitExternalDependencies.files.filter(item=>item.sourcePath!==attribute);
 assert.throws(()=>plan(missing),/control original differs/);
 const omitted=structuredClone(manifest);omitted.gitExternalDependencies.files=omitted.gitExternalDependencies.files.filter(item=>item.sourcePath!==attribute);omitted.gitExternalDependencies.omittedPaths.push(attribute);
 assert.throws(()=>plan(omitted),/control original differs/);
 const alias=structuredClone(manifest);alias.gitExternalDependencies.files=alias.gitExternalDependencies.files.filter(item=>item.sourcePath!==attribute);alias.gitExternalDependencies.links.push({sourcePath:attribute,targetSourcePath:path.join(info,'local-extra'),kind:'hardlink'});
 assert.throws(()=>plan(alias),/external alias requires separate/);
 const ancestor=structuredClone(manifest);ancestor.gitExternalDependencies.directories=ancestor.gitExternalDependencies.directories.filter(item=>item.sourcePath!==info);ancestor.gitExternalDependencies.links.push({sourcePath:info,targetSourcePath:path.join(bare,'hooks'),kind:'symlink'});
 assert.throws(()=>plan(ancestor),/control parent differs/);
 await assert.rejects(lstat(path.join(destination,'.git')),{code:'ENOENT'});
 const tasks=planReviewedRecoveryRoots(pkg,{work:destination},activation);
 const capsule=tasks[0].externalPlan.repositories.find(row=>row.bare===true);assert.ok(capsule);assert.equal(capsule.gitDir,capsule.worktreePath);
 await applyReviewedRecoveryRoots(tasks,activation,()=>{});
 assert.equal(await git(root,'--git-dir='+capsule.gitDir,'rev-parse','--is-bare-repository'),'true');
 assert.equal(await git(root,'--git-dir='+capsule.gitDir,'rev-parse','HEAD'),sourceHead);
 await assert.rejects(lstat(path.join(capsule.gitDir,'.git')),{code:'ENOENT'});
 assert.ok((await lstat(path.join(capsule.gitDir,'objects'))).isDirectory());
 assert.equal(await readFile(path.join(capsule.gitDir,'README.txt'),'utf8'),'retained ancillary bytes\n');
 if(includeExclude){
  const restoredExclude=await lstat(path.join(capsule.gitDir,'info','exclude'),{bigint:true});
  assert.deepEqual(await readFile(path.join(capsule.gitDir,'info','exclude')),originalExclude);
  assert.equal(restoredExclude.mode&0o7777n,sourceExclude.mode&0o7777n);assert.equal(restoredExclude.mtimeNs,sourceExclude.mtimeNs);
  assert.deepEqual(await readFile(path.join(bare,'info','exclude')),originalExclude,'source control original is unchanged');
 }else await assert.rejects(lstat(path.join(capsule.gitDir,'info','exclude')),{code:'ENOENT'});
 const restoredAttributes=await lstat(path.join(capsule.gitDir,'info','attributes'),{bigint:true});
 assert.equal(await readFile(path.join(capsule.gitDir,'info','attributes'),'utf8'),'*.txt text\n');
 assert.equal(restoredAttributes.mode&0o7777n,sourceAttributes.mode&0o7777n);assert.equal(restoredAttributes.mtimeNs,sourceAttributes.mtimeNs);
 assert.equal(await readFile(path.join(capsule.gitDir,'info','local-extra'),'utf8'),'retained extra\n');
 const restoredSparse=await lstat(path.join(capsule.gitDir,'info','sparse-checkout'),{bigint:true});
 assert.equal(await readFile(path.join(capsule.gitDir,'info','sparse-checkout'),'utf8'),'/*.txt\n');
 assert.equal(restoredSparse.mode&0o7777n,sourceSparse.mode&0o7777n);assert.equal(restoredSparse.mtimeNs,sourceSparse.mtimeNs);
 assert.equal(await realpath(capsule.gitDir),capsule.gitDir);
});

test('real linked repository dependency recreates its worktree and shared owned hook view',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'real-linked-restore-'))),source=path.join(root,'source'),destination=path.join(root,'destination'),dependencies=path.join(root,'dependencies'),other=path.join(root,'other'),linked=path.join(dependencies,'capsule');
 let restoredTree;t.after(async()=>{await chmod(dependencies,0o700).catch(()=>{});if(restoredTree)await chmod(restoredTree,0o700).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await initialize(source);await initialize(other);await mkdir(destination);await mkdir(dependencies);
 await git(other,'worktree','add','-b','linked',linked);
 await writeFile(path.join(dependencies,'shared-hook'),'#!/bin/sh\necho linked\n');await link(path.join(dependencies,'shared-hook'),path.join(dependencies,'shared-alias'));
 await git(source,'config','core.hooksPath',dependencies);
 await git(linked,'config','core.hooksPath',dependencies);
 await chmod(path.join(dependencies,'shared-hook'),0o400);await chmod(dependencies,0o500);
 const sourceHead=await git(linked,'rev-parse','HEAD');
 const manifest=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});
 assert.ok(manifest.gitExternalDependencies.repositories.some(repository=>repository.sourcePath===linked));
 const activation={git:true,harness:false},pkg=packageFor(manifest,{'file.txt':Buffer.from('committed\n')});
 await writeFile(path.join(destination,'file.txt'),'committed\n');
 const tasks=planReviewedRecoveryRoots(pkg,{work:destination},activation),capsule=tasks[0].externalPlan.repositories.find(row=>row.sourceWorkingRoot===linked);
 assert.ok(capsule);restoredTree=path.dirname(capsule.worktreePath);
 await applyReviewedRecoveryRoots(tasks,activation,()=>{});
 assert.equal(await git(capsule.worktreePath,'rev-parse','HEAD'),sourceHead);
 assert.match(await readFile(path.join(capsule.gitDir,'info','exclude'),'utf8'),/^\/\.ponderosa-portable-review\/$/m);
 const pointer=(await readFile(path.join(capsule.worktreePath,'.git'),'utf8')).trim();assert.match(pointer,/^gitdir: /);
 assert.equal(await realpath(path.resolve(capsule.worktreePath,pointer.slice(8))),await realpath(capsule.privateDir));
 const hookView=await git(capsule.worktreePath,'config','--path','--get','core.hooksPath');
 assert.equal(await realpath(path.resolve(capsule.worktreePath,hookView)),path.dirname(capsule.worktreePath));
 const shared=path.join(path.dirname(capsule.worktreePath),'shared-hook'),alias=path.join(path.dirname(capsule.worktreePath),'shared-alias');
 const before=await lstat(shared,{bigint:true}),after=await lstat(alias,{bigint:true});
 assert.equal(before.dev,after.dev);assert.equal(before.ino,after.ino);assert.equal(await readFile(shared,'utf8'),'#!/bin/sh\necho linked\n');
 assert.equal(before.mode&0o7777n,0o400n);assert.equal((await lstat(path.dirname(capsule.worktreePath),{bigint:true})).mode&0o7777n,0o500n);
 assert.equal(await git(linked,'rev-parse','HEAD'),sourceHead);
});

test('real mapped linked worktrees share common originals without private recreation rewriting them',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'real-shared-common-'))),source=path.join(root,'source'),first=path.join(root,'first'),second=path.join(root,'second'),common=path.join(source,'.git'),hooks=path.join(root,'hooks');
 const one=path.join(root,'one'),two=path.join(root,'two'),storage=path.join(root,'storage');const handles=[],captures=[];
 t.after(async()=>{for(const capture of captures)await capture.close();for(const handle of handles)await handle.close();await rm(root,{recursive:true,force:true});});
 await initialize(source);await git(source,'worktree','add','-b','first',first);await git(source,'worktree','add','-b','second',second);
 await mkdir(hooks);await writeFile(path.join(hooks,'pre-commit'),'#!/bin/sh\nexit 0\n');await git(source,'config','core.hooksPath',hooks);
 const roots=[];for(const [pathname,ref] of [[first,'one'],[second,'two'],[common,'storage']]){const handle=await open(pathname,'r');handles.push(handle);roots.push({pathname,ref,handle,owner:(await handle.stat({bigint:true})).uid});}
 const bindings=[...[[first,'one','first'],[second,'two','second']].flatMap(([worktreePath,worktreeRootRef,name])=>[
  {id:name+'-common',worktreeRootRef,storageRootRef:'storage',relativePath:'.',role:'common',worktreePath,storagePath:common},
  {id:name+'-private',worktreeRootRef,storageRootRef:'storage',relativePath:'worktrees/'+name,role:'private',worktreePath,storagePath:common}
 ])];
 const capture=createGitExportCapture(roots,bindings);captures.push(capture);await verifyGitExportAssociations(capture);
 const activation={git:true,harness:false},firstManifest=await exportReviewedUserData(first,{...activation,externalGitDependencies:true},capture),secondManifest=await exportReviewedUserData(second,{...activation,externalGitDependencies:true},capture);
 capture.bindReview(first,Buffer.from(JSON.stringify(firstManifest)));capture.bindReview(second,Buffer.from(JSON.stringify(secondManifest)));
 const pkg=packageFor(firstManifest,{'file.txt':Buffer.from('committed\n')}),other=packageFor(secondManifest,{'file.txt':Buffer.from('committed\n')}).agents[0];
 pkg.agents[0].workingRootRef='one';other.ref='second-agent';other.workingRootRef='two';other.managerRef='agent';pkg.agents.push(other,{ref:'storage-agent',title:'Storage',engine:'codex',workingRootRef:'storage',managerRef:'agent',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingFolder:{directories:[],excludedPaths:['.']},workingFiles:[]});pkg.gitStorageBindings=capture.portableBindings();
 for(const dir of [one,two,storage])await mkdir(dir);for(const dir of [one,two])await writeFile(path.join(dir,'file.txt'),'committed\n');
 const tasks=planReviewedRecoveryRoots(pkg,{one,two,storage},activation);assert.equal(tasks.length,2);
 const hookOriginal=tasks[0].externalPlan.activation.gitPathMappings.find(row=>row.source===path.join(hooks,'pre-commit'))?.destination;assert.ok(hookOriginal);
 let commonBefore,commonBytes,hookBefore,hookBytes;await applyReviewedRecoveryRoots(tasks,activation,receipt=>{if(receipt.state==='applying'&&receipt.path===two){commonBefore=lstatSync(path.join(storage,'config'),{bigint:true});commonBytes=readFileSync(path.join(storage,'config'));hookBefore=lstatSync(hookOriginal,{bigint:true});hookBytes=readFileSync(hookOriginal);}});
 assert.ok(commonBefore);const after=await lstat(path.join(storage,'config'),{bigint:true});assert.equal(after.ino,commonBefore.ino);assert.equal(after.mtimeNs,commonBefore.mtimeNs);assert.equal(after.ctimeNs,commonBefore.ctimeNs);assert.deepEqual(await readFile(path.join(storage,'config')),commonBytes);
 assert.equal((await lstat(hookOriginal,{bigint:true})).ino,hookBefore.ino);assert.deepEqual(await readFile(hookOriginal),hookBytes);
 for(const [work,branch] of [[one,'first'],[two,'second']]){assert.equal(await git(work,'branch','--show-current'),branch);const view=await git(work,'config','--path','--get','core.hooksPath');assert.equal(await realpath(path.resolve(work,view)),path.dirname(hookOriginal));}
});

test('nested bare dependencies hold before writes until inherited custody is supported',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'real-nested-bare-'))),source=path.join(root,'source'),destination=path.join(root,'destination'),dependencies=path.join(root,'dependencies');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await initialize(source);await mkdir(destination);await mkdir(dependencies);
 const outer=path.join(dependencies,'outer.git'),inner=path.join(outer,'nested.git');
 await git(root,'clone','--bare','--no-hardlinks',source,outer);
 await git(root,'clone','--bare','--no-hardlinks',source,inner);
 await writeFile(path.join(outer,'hooks','outer-hook'),'outer hook\n');
 await writeFile(path.join(inner,'hooks','inner-hook'),'inner hook\n');
 await git(source,'config','core.hooksPath',dependencies);
 const manifest=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});
 const repositories=manifest.gitExternalDependencies.repositories;
 assert.ok(repositories.some(item=>item.bare&&item.sourcePath===outer));
 assert.ok(repositories.some(item=>item.bare&&item.sourcePath===inner));
 await writeFile(path.join(destination,'file.txt'),'committed\n');
 const activation={git:true,harness:false};
 assert.throws(()=>planReviewedRecoveryRoots(packageFor(manifest,{'file.txt':Buffer.from('committed\n')}),{work:destination},activation),/Nested bare Git capsule requires descriptor-held storage custody/);
 await assert.rejects(lstat(path.join(destination,'.git')),{code:'ENOENT'});
 assert.equal(await readFile(path.join(outer,'hooks','outer-hook'),'utf8'),'outer hook\n');
 assert.equal(await readFile(path.join(inner,'hooks','inner-hook'),'utf8'),'inner hook\n');
});

test('real reftable capsule restores imported private layout and owner hook view',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'real-linked-reftable-'))),source=path.join(root,'source'),destination=path.join(root,'destination'),dependencies=path.join(root,'dependencies'),other=path.join(root,'other'),linked=path.join(dependencies,'capsule');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await initialize(source);await initialize(other,true);await mkdir(destination);await mkdir(dependencies);
 await git(other,'worktree','add','-b','linked',linked);
 await git(linked,'update-ref','refs/worktree/selected-private',await git(linked,'rev-parse','HEAD'));
 await writeFile(path.join(linked,'script'),'#!/bin/sh\nexit 0\n');await link(path.join(linked,'script'),path.join(linked,'hard'));
 await git(source,'config','core.hooksPath',dependencies);await git(linked,'config','core.hooksPath','../../dependencies/capsule');
 const manifest=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});
 const captured=manifest.gitExternalDependencies.repositories.find(repository=>repository.sourcePath===linked);assert.ok(captured?.git.reftableReview?.selectedWorktree);
 const activation={git:true,harness:false},pkg=packageFor(manifest,{'file.txt':Buffer.from('committed\n')});await writeFile(path.join(destination,'file.txt'),'committed\n');
 const tasks=planReviewedRecoveryRoots(pkg,{work:destination},activation),capsule=tasks[0].externalPlan.repositories.find(row=>row.sourceWorkingRoot===linked);assert.ok(capsule);
 assert.equal(capsule.privateDir,path.join(capsule.gitDir,'worktrees','imported'));
 const child=tasks[0].configuration.modules.find(row=>row.gitDir===capsule.gitDir);
 assert.ok(child?.configuration.external.links.some(row=>row.context==='worktree'&&row.targetContext==='owner'&&row.kind==='symlink'));
 await applyReviewedRecoveryRoots(tasks,activation,()=>{});
 assert.equal(await readFile(path.join(capsule.worktreePath,'.git'),'utf8'),'gitdir: '+path.relative(capsule.worktreePath,capsule.privateDir).split(path.sep).join('/')+'\n');
 const view=await git(capsule.worktreePath,'config','--get','core.hooksPath');
 assert.match(view,/^\.ponderosa-portable-review\/active-git-hooks\//);assert.equal(await realpath(path.resolve(capsule.worktreePath,view)),capsule.worktreePath);
 const original=await lstat(path.join(capsule.worktreePath,'script'),{bigint:true}),alias=await lstat(path.join(capsule.worktreePath,'hard'),{bigint:true});assert.equal(original.ino,alias.ino);assert.equal(original.nlink,2n);
 assert.match(await readFile(path.join(capsule.gitDir,'info','exclude'),'utf8'),/^\/\.ponderosa-portable-review\/$/m);
});

test('real mapped private hook views retain the shared common originals',options,async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'real-shared-common-'))),source=path.join(root,'source'),first=path.join(root,'source','wt','nested','first'),second=path.join(root,'source','wt','nested','second'),common=path.join(source,'.git'),hooks=path.join(root,'hooks');
 const one=path.join(root,'one'),two=path.join(root,'two'),storage=path.join(root,'storage');const handles=[],captures=[];
 t.after(async()=>{for(const capture of captures)await capture.close();for(const handle of handles)await handle.close();await rm(root,{recursive:true,force:true});});
 await initialize(source);await git(source,'worktree','add','-b','first',first);await git(source,'worktree','add','-b','second',second);
 await mkdir(hooks);await writeFile(path.join(hooks,'pre-commit'),'#!/bin/sh\nexit 0\n');
 await chmod(path.join(hooks,'pre-commit'),0o751);await utimes(path.join(hooks,'pre-commit'),1700000001.456,1700000001.456);
 await chmod(hooks,0o750);await utimes(hooks,1700000000.123,1700000000.123);
 await git(source,'config','core.hooksPath','../../../../hooks');
 const roots=[];for(const [pathname,ref] of [[first,'one'],[second,'two'],[common,'storage']]){const handle=await open(pathname,'r');handles.push(handle);roots.push({pathname,ref,handle,owner:(await handle.stat({bigint:true})).uid});}
 const bindings=[...[[first,'one','first'],[second,'two','second']].flatMap(([worktreePath,worktreeRootRef,name])=>[
  {id:name+'-common',worktreeRootRef,storageRootRef:'storage',relativePath:'.',role:'common',worktreePath,storagePath:common},
  {id:name+'-private',worktreeRootRef,storageRootRef:'storage',relativePath:'worktrees/'+name,role:'private',worktreePath,storagePath:common}
 ])];
 const capture=createGitExportCapture(roots,bindings);captures.push(capture);await verifyGitExportAssociations(capture);
 const activation={git:true,harness:false},firstManifest=await exportReviewedUserData(first,{...activation,externalGitDependencies:true},capture),secondManifest=await exportReviewedUserData(second,{...activation,externalGitDependencies:true},capture);
 capture.bindReview(first,Buffer.from(JSON.stringify(firstManifest)));capture.bindReview(second,Buffer.from(JSON.stringify(secondManifest)));
 const pkg=packageFor(firstManifest,{'file.txt':Buffer.from('committed\n')}),other=packageFor(secondManifest,{'file.txt':Buffer.from('committed\n')}).agents[0];
 pkg.agents[0].workingRootRef='one';other.ref='second-agent';other.workingRootRef='two';other.managerRef='agent';pkg.agents.push(other,{ref:'storage-agent',title:'Storage',engine:'codex',workingRootRef:'storage',managerRef:'agent',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingFolder:{directories:[],excludedPaths:['.']},workingFiles:[]});pkg.gitStorageBindings=capture.portableBindings();
 for(const dir of [one,two,storage])await mkdir(dir);for(const dir of [one,two])await writeFile(path.join(dir,'file.txt'),'committed\n');
 const tasks=planReviewedRecoveryRoots(pkg,{one,two,storage},activation);assert.equal(tasks.length,2);
 const hookOriginal=tasks[0].externalPlan.activation.gitPathMappings.find(row=>row.source===path.join(hooks,'pre-commit'))?.destination;assert.ok(hookOriginal);
 const expectedRoots={};for(const directory of [one,two,storage]){const stat=await lstat(directory,{bigint:true});expectedRoots[directory]={device:String(stat.dev),inode:String(stat.ino),directories:{}};}
 let commonBefore,commonBytes,hookBefore,hookBytes,dirBefore,checked=false;
 await applyReviewedRecoveryRoots(tasks,activation,receipt=>{if(receipt.state==='applying'&&receipt.path===two){commonBefore=lstatSync(path.join(storage,'config'),{bigint:true});commonBytes=readFileSync(path.join(storage,'config'));hookBefore=lstatSync(hookOriginal,{bigint:true});hookBytes=readFileSync(hookOriginal);dirBefore=lstatSync(path.dirname(hookOriginal),{bigint:true});}},expectedRoots,undefined,()=>{
  const file=lstatSync(hookOriginal,{bigint:true}),dir=lstatSync(path.dirname(hookOriginal),{bigint:true});
  for(const key of ['ino','mode','mtimeNs','ctimeNs'])assert.equal(file[key],hookBefore[key],key);
  for(const key of ['mode','mtimeNs'])assert.equal(dir[key],dirBefore[key],key);checked=true;
 });assert.equal(checked,true);
 assert.ok(commonBefore);const after=await lstat(path.join(storage,'config'),{bigint:true});assert.equal(after.ino,commonBefore.ino);assert.equal(after.mtimeNs,commonBefore.mtimeNs);assert.equal(after.ctimeNs,commonBefore.ctimeNs);assert.deepEqual(await readFile(path.join(storage,'config')),commonBytes);
 assert.equal((await lstat(hookOriginal,{bigint:true})).ino,hookBefore.ino);assert.deepEqual(await readFile(hookOriginal),hookBytes);
 for(const [work,branch] of [[one,'first'],[two,'second']]){
  assert.equal(await git(work,'branch','--show-current'),branch);const view=await git(work,'config','--path','--get','core.hooksPath');
  assert.match(view,/^\.ponderosa-portable-review\/active-git-hooks\//);
  assert.equal(await realpath(path.resolve(work,view)),path.dirname(hookOriginal));
  assert.equal(await realpath(path.join(storage,'worktrees',branch,view)),path.dirname(hookOriginal));
 }
 const sourceFile=await lstat(path.join(hooks,'pre-commit'),{bigint:true}),sourceDir=await lstat(hooks,{bigint:true}),restoredFile=await lstat(hookOriginal,{bigint:true}),restoredDir=await lstat(path.dirname(hookOriginal),{bigint:true});
 assert.equal(restoredFile.mode&0o7777n,sourceFile.mode&0o7777n);assert.equal(restoredFile.mtimeNs,sourceFile.mtimeNs);assert.equal(restoredDir.mode&0o7777n,sourceDir.mode&0o7777n);assert.equal(restoredDir.mtimeNs,sourceDir.mtimeNs);
});
