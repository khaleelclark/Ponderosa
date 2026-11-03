import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,link,symlink,readlink,lstat,realpath,rename,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fstatSync} from 'node:fs';
import {exportReviewedUserData,reviewedGitConfiguration,createReviewedRecoveryGit,parseReviewedGitConfiguration} from '../../apps/server/dist/portable-reviewed-user-data.js';

const exec=promisify(execFile),git=async(cwd,...args)=>(await exec('git',['--no-optional-locks',...args],{cwd,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();
const options={skip:process.platform!=='linux'};
async function fixture(){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'native-external-writer-'))),source=path.join(root,'source'),destination=path.join(root,'destination');await mkdir(source);await mkdir(destination);
 await git(source,'init','--template=','--initial-branch=main');await git(source,'config','core.sharedRepository','group');
 const manifest=await exportReviewedUserData(source,{git:true,harness:false}),original=Buffer.from(JSON.stringify(manifest)),sha256=createHash('sha256').update(original).digest('hex'),activation={git:true,harness:false};
 const ns='1700000000123456789',data=Buffer.from('#!/bin/sh\nexit 0\n');
 const external={directories:[{path:'ponderosa-external',mode:0o700,mtimeNs:ns},{path:'ponderosa-external/capsule',mode:0o2750,mtimeNs:ns}],files:[{path:'ponderosa-external/capsule/script',data,mode:0o751,mtimeNs:ns}],links:[{path:'ponderosa-external/capsule/hard',target:'ponderosa-external/capsule/script',kind:'hardlink',mtimeNs:ns},{path:'ponderosa-external/capsule/symbol',target:'ponderosa-external/capsule/script',kind:'symlink',mtimeNs:ns}]};
 return {root,source,destination,manifest,external,ns,data,configuration:()=>({...reviewedGitConfiguration(manifest,activation),external}),apply:configuration=>createReviewedRecoveryGit(destination,original,sha256,activation,undefined,configuration),dispose:()=>rm(root,{recursive:true,force:true})};
}

test('native external graph preserves aliases and exact source metadata after Git sharing',options,async()=>{
 const f=await fixture();try{
  await mkdir(path.join(f.destination,'.hooks'));await writeFile(path.join(f.destination,'.hooks/run'),f.data);await link(path.join(f.destination,'.hooks/run'),path.join(f.destination,'.hooks/hard'));await symlink('run',path.join(f.destination,'.hooks/symbol'));
  const rootIdentity=await lstat(f.destination,{bigint:true}),original=await lstat(path.join(f.destination,'.hooks/run'),{bigint:true});
  const hooks=await lstat(path.join(f.destination,'.hooks'),{bigint:true});
  f.external.worktreeIdentity={device:rootIdentity.dev.toString(),inode:rootIdentity.ino.toString(),directories:{'.hooks':{device:hooks.dev.toString(),inode:hooks.ino.toString()}}};
  f.external.directories.push({path:'.hooks',context:'worktree',mode:0o750,mtimeNs:f.ns});
  f.external.files.push({path:'.hooks/run',context:'worktree',data:f.data,mode:0o700,mtimeNs:f.ns});
  f.external.links.push({path:'.hooks/hard',context:'worktree',target:'.hooks/run',targetContext:'worktree',kind:'hardlink',mtimeNs:f.ns},{path:'.hooks/symbol',context:'worktree',target:'.hooks/run',targetContext:'worktree',kind:'symlink',mtimeNs:f.ns});
  await f.apply(f.configuration());
  const base=path.join(f.destination,'.git/ponderosa-external/capsule'),file=await lstat(path.join(base,'script'),{bigint:true}),hard=await lstat(path.join(base,'hard'),{bigint:true});
  assert.equal(file.ino,hard.ino);assert.equal(file.nlink,2n);assert.equal(file.mode&0o7777n,0o751n);assert.equal(file.mtimeNs,BigInt(f.ns));
  const directory=await lstat(base,{bigint:true});assert.equal(directory.mode&0o7777n,0o2750n);assert.equal(directory.mtimeNs,BigInt(f.ns),'Directory timestamps are finalized after aliases and sharing');
  assert.equal(await readlink(path.join(base,'symbol')),'script');assert.equal((await lstat(path.join(base,'symbol'),{bigint:true})).mtimeNs,BigInt(f.ns),'Symlink nanoseconds use the exact native held-link helper');
  const reused=await lstat(path.join(f.destination,'.hooks/run'),{bigint:true});assert.equal(reused.dev,original.dev);assert.equal(reused.ino,original.ino);assert.equal(reused.nlink,2n);assert.equal(reused.mode&0o7777n,0o700n);assert.equal(reused.mtimeNs,BigInt(f.ns));assert.deepEqual(await readFile(path.join(f.destination,'.hooks/run')),f.data);
  assert.equal((await lstat(path.join(f.destination,'.hooks/symbol'),{bigint:true})).mtimeNs,BigInt(f.ns));
 }finally{await f.dispose();}
});

test('worktree placement requires its original issued identity before any Git creation',options,async()=>{
 const f=await fixture();try{
  f.external.files.push({path:'hook',context:'worktree',data:f.data,mode:0o700,mtimeNs:f.ns});
  await assert.rejects(f.apply(f.configuration()),/original issued import-root identity/);await assert.rejects(lstat(path.join(f.destination,'.git')),{code:'ENOENT'});
  f.external.worktreeIdentity={device:'0',inode:'0'};await assert.rejects(f.apply(f.configuration()),/original import-root custody/);await assert.rejects(lstat(path.join(f.destination,'.git')),{code:'ENOENT'});
 }finally{await f.dispose();}
});

test('equal-only worktree reuse refuses changed bytes and preserves the original destination',options,async()=>{
 const f=await fixture();try{
  const target=path.join(f.destination,'hook');await writeFile(target,'different local bytes');const before=await lstat(target,{bigint:true}),root=await lstat(f.destination,{bigint:true});
  f.external.worktreeIdentity={device:root.dev.toString(),inode:root.ino.toString()};f.external.files.push({path:'hook',context:'worktree',data:f.data,mode:0o700,mtimeNs:f.ns});
  await assert.rejects(f.apply(f.configuration()),/original differs|bytes differ/);assert.equal(await readFile(target,'utf8'),'different local bytes');const after=await lstat(target,{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.mode,before.mode);assert.equal(after.mtimeNs,before.mtimeNs);
 }finally{await f.dispose();}
});

test('an undeclared existing hardlink cannot grant metadata authority over a reused original',options,async()=>{
 const f=await fixture();try{
  const target=path.join(f.destination,'hook');await writeFile(target,f.data);await link(target,path.join(f.destination,'undeclared-alias'));const before=await lstat(target,{bigint:true}),root=await lstat(f.destination,{bigint:true});
  f.external.worktreeIdentity={device:root.dev.toString(),inode:root.ino.toString()};f.external.files.push({path:'hook',context:'worktree',data:f.data,mode:0o700,mtimeNs:f.ns});
  await assert.rejects(f.apply(f.configuration()),/aliases outside its complete declared graph/);const after=await lstat(target,{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.mode,before.mode);assert.equal(after.mtimeNs,before.mtimeNs);assert.deepEqual(await readFile(path.join(f.destination,'undeclared-alias')),f.data);
 }finally{await f.dispose();}
});

test('external alias paths and targets cannot escape or name an undeclared original',options,async()=>{
 const f=await fixture();try{
  f.external.links.push({path:'outside',target:'../outside',kind:'symlink'});await assert.rejects(f.apply(f.configuration()),/contained relative path/);await assert.rejects(lstat(path.join(f.destination,'.git')),{code:'ENOENT'});
  f.external.links.at(-1).target='missing';await assert.rejects(f.apply(f.configuration()),/named original closure/);await assert.rejects(lstat(path.join(f.destination,'.git')),{code:'ENOENT'});
 }finally{await f.dispose();}
});


test('a replaced worktree child directory cannot gain final-metadata custody through equal bytes',options,async()=>{
 const f=await fixture();try{
  const target=path.join(f.destination,'hooks'),retained=path.join(f.destination,'retained-hooks');await mkdir(target);await writeFile(path.join(target,'run'),f.data);
  const root=await lstat(f.destination,{bigint:true}),issued=await lstat(target,{bigint:true});
  f.external.worktreeIdentity={device:root.dev.toString(),inode:root.ino.toString(),directories:{hooks:{device:issued.dev.toString(),inode:issued.ino.toString()}}};
  f.external.directories.push({path:'hooks',context:'worktree',mode:0o700,mtimeNs:f.ns});f.external.files.push({path:'hooks/run',context:'worktree',data:f.data,mode:0o700,mtimeNs:f.ns});
  await rename(target,retained);await mkdir(target);await writeFile(path.join(target,'run'),f.data);const before=await lstat(target,{bigint:true}),fileBefore=await lstat(path.join(target,'run'),{bigint:true});
  await assert.rejects(f.apply(f.configuration()),/lost its original byte-phase custody/);
  const after=await lstat(target,{bigint:true}),fileAfter=await lstat(path.join(target,'run'),{bigint:true});assert.equal(after.mode,before.mode);assert.equal(after.mtimeNs,before.mtimeNs);assert.equal(fileAfter.mode,fileBefore.mode);assert.equal(fileAfter.mtimeNs,fileBefore.mtimeNs);
  assert.deepEqual(await readFile(path.join(retained,'run')),f.data);assert.deepEqual(await readFile(path.join(target,'run')),f.data);
 }finally{await f.dispose();}
});


test('linked repository capsules reuse owned native layout and borrow only declared top-owner hook trees',options,async()=>{
 const f=await fixture();try{
  const gitDir=path.join(f.destination,'.git/ponderosa-repositories/repository'),worktreePath=path.join(f.destination,'.git/ponderosa-external/capsule');
  const childConfiguration={...reviewedGitConfiguration(f.manifest,{git:true,harness:false}),external:{directories:[],files:[],links:[{path:'.ponderosa-portable-review/active-git-hooks/view',context:'worktree',target:'ponderosa-external/capsule',targetContext:'owner',kind:'symlink'}]}};
  const configuration={...f.configuration(),modules:[{gitDir,worktreePath,initialized:true,value:f.manifest,activation:{git:true,harness:false},configuration:childConfiguration,layout:{commonDir:gitDir,privateDir:path.join(gitDir,'worktrees/imported'),writeCommon:true}}]};
  await f.apply(configuration);
  assert.equal(await readFile(path.join(worktreePath,'.git'),'utf8'),'gitdir: '+path.relative(worktreePath,path.join(gitDir,'worktrees/imported')).split(path.sep).join('/')+'\n');
  const view=path.join(worktreePath,'.ponderosa-portable-review/active-git-hooks/view');assert.equal(await realpath(view),worktreePath,'The child hook view is a passive alias of its named, parent-owned source tree');
  const original=await lstat(path.join(worktreePath,'script'),{bigint:true}),alias=await lstat(path.join(worktreePath,'hard'),{bigint:true});assert.equal(original.ino,alias.ino);assert.equal(original.nlink,2n);
  assert.match(await readFile(path.join(gitDir,'info/exclude'),'utf8'),/^\/\.ponderosa-portable-review\/$/m);
 }finally{await f.dispose();}
});

test('owner context cannot write nodes or target undeclared and nonregular originals',options,async()=>{
 const f=await fixture();try{
  f.external.files.push({path:'forbidden',context:'owner',data:f.data,mode:0o700,mtimeNs:f.ns});await assert.rejects(f.apply(f.configuration()),/reference-only declared closure/);await assert.rejects(lstat(path.join(f.destination,'.git')),{code:'ENOENT'});f.external.files.pop();
  f.external.links.push({path:'bad-view',target:'missing',targetContext:'owner',kind:'symlink'});await assert.rejects(f.apply(f.configuration()),/named declared original target/);await assert.rejects(lstat(path.join(f.destination,'.git')),{code:'ENOENT'});
  f.external.links.at(-1).target='ponderosa-external/capsule';f.external.links.at(-1).kind='hardlink';await assert.rejects(f.apply(f.configuration()),/named declared original target/);await assert.rejects(lstat(path.join(f.destination,'.git')),{code:'ENOENT'});
 }finally{await f.dispose();}
});


test('private-only linked initialization keeps common originals immutable and creates only its own hook view',options,async()=>{
 const f=await fixture();try{
  const common=path.join(f.root,'common'),second=path.join(f.root,'second');await mkdir(common);await mkdir(second);
  f.external.links.push({path:'.ponderosa-portable-review/active-git-hooks/view',context:'private',target:'ponderosa-external/capsule',targetContext:'owner',kind:'symlink'});
  const original=Buffer.from(JSON.stringify(f.manifest)),sha256=createHash('sha256').update(original).digest('hex'),activation={git:true,harness:false};
  const firstLayout={commonDir:common,privateDir:path.join(common,'worktrees/first'),writeCommon:true};
  await createReviewedRecoveryGit(f.destination,original,sha256,activation,firstLayout,f.configuration());
  const commonFile=path.join(common,'ponderosa-external/capsule/script'),before=await lstat(commonFile,{bigint:true}),beforeDirectory=await lstat(path.dirname(commonFile),{bigint:true});
  const secondLayout={commonDir:common,privateDir:path.join(common,'worktrees/second'),writeCommon:false};
  await createReviewedRecoveryGit(second,original,sha256,activation,secondLayout,f.configuration());
  const after=await lstat(commonFile,{bigint:true}),afterDirectory=await lstat(path.dirname(commonFile),{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.mode,before.mode);assert.equal(after.mtimeNs,before.mtimeNs);assert.equal(after.ctimeNs,before.ctimeNs);assert.equal(afterDirectory.mtimeNs,beforeDirectory.mtimeNs);assert.equal(afterDirectory.mode,beforeDirectory.mode);
  for(const layout of [firstLayout,secondLayout])assert.equal(await realpath(path.join(layout.privateDir,'.ponderosa-portable-review/active-git-hooks/view')),path.join(common,'ponderosa-external/capsule'));
 }finally{await f.dispose();}
});


test('restrictive recursive source modes wait until global verification and captured cross-scope hardlinks exist',options,async()=>{
 const f=await fixture();let locked;try{
  const gitDir=path.join(f.destination,'.git/ponderosa-repositories/child'),worktreePath=path.join(f.destination,'.git/ponderosa-external/capsule');locked=path.join(gitDir,'hooks');
  const childConfiguration={...reviewedGitConfiguration(f.manifest,{git:true,harness:false}),external:{directories:[{path:'hooks',mode:0,mtimeNs:f.ns}],files:[{path:'hooks/unreadable',data:f.data,mode:0,mtimeNs:f.ns}],links:[{path:'hooks/captured-parent-alias',target:'ponderosa-external/capsule/script',targetContext:'owner',kind:'hardlink',mtimeNs:f.ns}]}};
  const configuration={...f.configuration(),modules:[{gitDir,worktreePath,initialized:true,value:f.manifest,activation:{git:true,harness:false},configuration:childConfiguration,layout:{commonDir:gitDir,privateDir:path.join(gitDir,'worktrees/imported'),writeCommon:true}}]};
  await f.apply(configuration);
  assert.equal((await lstat(locked,{bigint:true})).mode&0o7777n,0n,'Child directory mode is restored only after parent verification completes');
  await chmod(locked,0o700);const file=await lstat(path.join(locked,'unreadable'),{bigint:true});assert.equal(file.mode&0o7777n,0n);assert.equal(file.mtimeNs,BigInt(f.ns));
  const source=await lstat(path.join(worktreePath,'script'),{bigint:true}),alias=await lstat(path.join(locked,'captured-parent-alias'),{bigint:true});assert.equal(source.ino,alias.ino);assert.equal(source.dev,alias.dev);assert.equal(source.nlink,3n);
  assert.ok(configuration.directoryProofs.has(locked));assert.equal(configuration.directoryProofs,childConfiguration.directoryProofs,'Recursive scopes publish the same exact issued directory map');
 }finally{if(locked)await chmod(locked,0o700).catch(()=>{});await f.dispose();}
});


test('one shared metadata scope waits for all tasks and composes callbacks on the exact held descriptors',options,async()=>{
 const f=await fixture();let locked;try{
  const scope={},first={...f.configuration(),nativeMetadataScope:scope,deferNativeMetadata:true};
  f.external.files[0].mode=0;f.external.directories[1].mode=0;locked=path.join(f.destination,'.git/ponderosa-external/capsule');
  await f.apply(first);const second=path.join(f.root,'second');await mkdir(second);
  const configuration={...f.configuration(),nativeMetadataScope:scope,deferNativeMetadata:true},original=Buffer.from(JSON.stringify(f.manifest)),sha256=createHash('sha256').update(original).digest('hex');
  await createReviewedRecoveryGit(second,original,sha256,{git:true,harness:false},undefined,configuration);
  assert.equal(first.prepareNativeMetadata,configuration.prepareNativeMetadata);assert.equal(first.finalizeNativeMetadata,configuration.finalizeNativeMetadata);
  assert.equal((await lstat(path.join(locked,'script'),{bigint:true})).mode&0o400n,0o400n,'Collecting another task cannot seal the first');
  await first.prepareNativeMetadata();const target=path.join(locked,'script');let invoked=0;
  first.nativeMetadata.deferredMetadata.set(target,{kind:'file',mode:0,mtimeNs:f.ns,apply:held=>{const stat=fstatSync(held.fd,{bigint:true});assert.equal(stat.dev,held.expectedDevice);assert.equal(stat.ino,held.expectedInode);assert.equal(stat.nlink,2n);assert.equal(stat.mode&0o400n,0o400n);invoked++;}});
  await first.finalizeNativeMetadata();assert.equal(invoked,1);assert.equal(first.fileProofs.get(target).mode,0);assert.equal(first.fileProofs.get(target).mtimeNs,f.ns);assert.match(first.fileProofs.get(target).ctimeNs,/^[0-9]+$/);
  await assert.rejects(first.finalizeNativeMetadata(),/cannot be replayed/);await assert.rejects(first.prepareNativeMetadata(),/cannot be replayed/);
  await chmod(locked,0o700);await chmod(path.join(second,'.git/ponderosa-external/capsule'),0o700);
 }finally{if(locked)await chmod(locked,0o700).catch(()=>{});await chmod(path.join(f.root,'second/.git/ponderosa-external/capsule'),0o700).catch(()=>{});await f.dispose();}
});

test('fully issued plain-working aliases count once and receive the native precision proof',options,async()=>{
 const f=await fixture();try{
  await mkdir(path.join(f.destination,'.hooks'));const target=path.join(f.destination,'.hooks/run'),alias=path.join(f.destination,'shared-script');await writeFile(target,f.data);await link(target,alias);
  const root=await lstat(f.destination,{bigint:true}),hooks=await lstat(path.dirname(target),{bigint:true}),identity={device:root.dev.toString(),inode:root.ino.toString(),directories:{'.hooks':{device:hooks.dev.toString(),inode:hooks.ino.toString()}}};
  f.external.worktreeIdentity=identity;f.external.files.push({path:'.hooks/run',context:'worktree',data:f.data,mode:0o751,mtimeNs:f.ns});
  const configuration={...f.configuration(),workingAliases:[{path:alias,target,rootPath:f.destination,identity}]};await f.apply(configuration);
  const actual=await lstat(alias,{bigint:true});assert.equal(actual.nlink,2n);assert.equal(actual.mtimeNs,BigInt(f.ns));assert.equal(configuration.fileProofs.get(alias).inode,actual.ino.toString());assert.equal(configuration.fileProofs.get(alias).expectedLinkCount,'2');assert.equal(configuration.nativeMetadata.protectedFiles.get(alias).mtimeNs,f.ns);
 }finally{await f.dispose();}
});


test('passive symlinks preserve only explicitly declared absent destinations',options,async()=>{
 const f=await fixture();try{
  f.external.absentPaths=[{path:'ponderosa-external/capsule/missing'}];f.external.links.push({path:'ponderosa-external/capsule/dangling',target:'ponderosa-external/capsule/missing',kind:'symlink'});
  await f.apply(f.configuration());const linkPath=path.join(f.destination,'.git/ponderosa-external/capsule/dangling');assert.equal(await readlink(linkPath),'missing');await assert.rejects(lstat(path.join(path.dirname(linkPath),'missing')),{code:'ENOENT'});
 }finally{await f.dispose();}
});

test('top-worktree references and metadata-only root anchors use the original issued root',options,async()=>{
 const f=await fixture();try{
  const source=path.join(f.destination,'support');await mkdir(source);await writeFile(path.join(source,'script'),f.data);const root=await lstat(f.destination,{bigint:true}),directory=await lstat(source,{bigint:true});
  f.external.worktreeIdentity={device:root.dev.toString(),inode:root.ino.toString(),directories:{support:{device:directory.dev.toString(),inode:directory.ino.toString()}}};
  f.external.rootMetadata={context:'worktree',mode:0o700,mtimeNs:f.ns};f.external.files.push({path:'support/script',context:'worktree',data:f.data,mode:0o751,mtimeNs:f.ns});
  f.external.links.push({path:'ponderosa-external/capsule/from-working-root',target:'support/script',targetContext:'ownerWorktree',kind:'hardlink',mtimeNs:f.ns},{path:'.ponderosa-portable-review/active-git-hooks/root',context:'worktree',target:'.',targetContext:'worktree',kind:'symlink'});
  await f.apply(f.configuration());const original=await lstat(path.join(source,'script'),{bigint:true}),alias=await lstat(path.join(f.destination,'.git/ponderosa-external/capsule/from-working-root'),{bigint:true});assert.equal(original.ino,alias.ino);assert.equal(original.nlink,2n);assert.equal((await lstat(f.destination,{bigint:true})).mtimeNs,BigInt(f.ns));assert.equal(await realpath(path.join(f.destination,'.ponderosa-portable-review/active-git-hooks/root')),f.destination);
 }finally{await f.dispose();}
});

test('explicit bare repository capsules retain their root layout and never create a working pointer',options,async()=>{
 const f=await fixture();try{
  const value=structuredClone(f.manifest),bytes=Buffer.from(value.git.configurationOriginalReview[0].dataBase64,'base64').toString('utf8').replace(/bare[ \t]*=[ \t]*false/,'bare = true'),parsed=parseReviewedGitConfiguration(Buffer.from(bytes));
  value.git.configurationOriginalReview[0].dataBase64=parsed.data.toString('base64');value.git.configurationReview=parsed.items;
  const relative='ponderosa-repositories/bare',gitDir=path.join(f.destination,'.git',relative);f.external.directories.push({path:'ponderosa-repositories',mode:0o700,mtimeNs:f.ns},{path:relative,mode:0o750,mtimeNs:f.ns});
  const configuration={...f.configuration(),modules:[{gitDir,worktreePath:gitDir,initialized:false,bare:true,value,activation:{git:true,harness:false},configuration:reviewedGitConfiguration(value,{git:true,harness:false})}]};
  await f.apply(configuration);assert.equal(await git(gitDir,'rev-parse','--is-bare-repository'),'true');await assert.rejects(lstat(path.join(gitDir,'.git')),{code:'ENOENT'});assert.ok((await lstat(path.join(gitDir,'objects'))).isDirectory());
 }finally{await f.dispose();}
});
