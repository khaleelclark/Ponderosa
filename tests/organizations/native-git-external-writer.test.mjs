import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,link,symlink,readlink,lstat,realpath,rename,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fstatSync} from 'node:fs';
import {exportReviewedUserData,reviewedGitConfiguration,createReviewedRecoveryGit} from '../../apps/server/dist/portable-reviewed-user-data.js';

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
