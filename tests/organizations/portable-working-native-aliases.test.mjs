import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,open,link,lstat,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {workingNativeAliasEvidence,workingLinkCounts,finalizeWorkingFolderMetadata,createWorkingNativeMetadataEvidence} from '../../apps/server/dist/portable-working-files.js';

const packageWith=(nodes)=>({mode:'full',agents:nodes});
const node=(ref,files,links=[])=>({ref,workingRootRef:ref,workingFiles:files.map(path=>({path,artifactRef:path})),workingFolder:{directories:[],links}});

test('working alias evidence carries the complete selected cross-root component without consulting destination nlink',()=>{
 const pkg=packageWith([node('one',['.husky/pre-commit']),node('two',[],[{path:'shared-script',kind:'hardlink',target:'.husky/pre-commit',targetRootRef:'one'}])]);
 assert.deepEqual(workingNativeAliasEvidence(pkg,{one:'/selected/one',two:'/selected/two'}),{aliases:[{path:'/selected/two/shared-script',target:'/selected/one/.husky/pre-commit',root:'/selected/two',targetRoot:'/selected/one'}]});
 assert.throws(()=>workingNativeAliasEvidence(pkg,{one:'/selected/one'}),/every selected|canonical destination/i);
 const missing=structuredClone(pkg);missing.agents[1].workingFolder.links[0].target='missing';assert.throws(()=>workingNativeAliasEvidence(missing,{one:'/selected/one',two:'/selected/two'}),/regular original/i);
 const cycle=packageWith([node('one',[],[{path:'a',kind:'hardlink',target:'b',targetRootRef:'two'}]),node('two',[],[{path:'b',kind:'hardlink',target:'a',targetRootRef:'one'}])]);assert.throws(()=>workingNativeAliasEvidence(cycle,{one:'/selected/one',two:'/selected/two'}),/cyclic/i);
});

test('ordinary finalization preserves verified Git nanoseconds for a real working hardlink and hook directory',{skip:process.platform!=='linux'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'working-native-alias-'));
 try{
  const directory=path.join(root,'.husky'),file=path.join(directory,'pre-commit'),alias=path.join(root,'shared-script'),data=Buffer.from('#!/bin/sh\nexit 0\n');await mkdir(directory);await writeFile(file,data);await link(file,alias);
  const source=await open(file,'r+');try{await source.chmod(0o751);await source.utimes(1700000000.123456,1700000000.123456);}finally{await source.close();}
  const folder=await open(directory,'r');try{await folder.chmod(0o751);await folder.utimes(1700000000.654321,1700000000.654321);}finally{await folder.close();}
  const before=await lstat(file,{bigint:true}),directoryBefore=await lstat(directory,{bigint:true}),sha256=createHash('sha256').update(data).digest('hex'),proofs=createWorkingNativeMetadataEvidence();
  assert.notEqual(before.mtimeNs%1000000n,0n);assert.notEqual(directoryBefore.mtimeNs%1000000n,0n);
  const proof={device:String(before.dev),inode:String(before.ino),mode:0o751,mtimeNs:String(before.mtimeNs),ctimeNs:String(before.ctimeNs),sha256,expectedLinkCount:'2'};proofs.files.set(file,proof);proofs.files.set(alias,proof);proofs.directories.set(directory,{device:String(directoryBefore.dev),inode:String(directoryBefore.ino),mode:0o751,mtimeNs:String(directoryBefore.mtimeNs),ctimeNs:String(directoryBefore.ctimeNs)});
  const files=[{path:'.husky/pre-commit',data,sha256,mode:0o751,mtime:before.mtime.toISOString()}],directories=[{path:'.husky',mode:0o751,mtime:directoryBefore.mtime.toISOString()}],links=[{path:'shared-script',kind:'hardlink',target:'.husky/pre-commit'}];
  await finalizeWorkingFolderMetadata(root,files,directories,undefined,links,undefined,workingLinkCounts('work',[{ref:'work',links}]),undefined,proofs);
  const after=await lstat(file,{bigint:true});assert.equal(after.mtimeNs,before.mtimeNs);assert.equal((await lstat(directory,{bigint:true})).mtimeNs,directoryBefore.mtimeNs);assert.equal((await lstat(alias,{bigint:true})).ino,after.ino);
  // Keep nlink=2 while replacing the declared alias: a count alone cannot grant it.
  await unlink(alias);await link(file,path.join(root,'unknown-alias'));await writeFile(alias,data);
  await assert.rejects(finalizeWorkingFolderMetadata(root,files,directories,undefined,links,undefined,workingLinkCounts('work',[{ref:'work',links}]),undefined,proofs),/proof|alias|census/i);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('ordinary protected mode000 and ancestor metadata wait for the native descriptor finalization phase',{skip:process.platform!=='linux'},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'working-native-deferred-'));
 try{
  const file=path.join(root,'hook'),data=Buffer.from('#!/bin/sh\nexit 0\n'),sha256=createHash('sha256').update(data).digest('hex');await writeFile(file,data,{mode:0o600});
  const metadata=createWorkingNativeMetadataEvidence();metadata.protectedFiles.set(file,{mode:0,mtimeNs:'1700000000123456000',sha256});
  await finalizeWorkingFolderMetadata(root,[{path:'hook',data,sha256,mode:0,mtime:'2023-11-14T22:13:20.123Z'}],[],{mode:0,mtime:'2023-11-14T22:13:20.000Z'},[],undefined,undefined,undefined,metadata);
  assert.equal((await lstat(file)).mode&0o777,0o600,'the native writer must still be able to verify bytes before exact metadata');
  assert.notEqual((await lstat(root)).mode&0o777,0,'ancestor traversal remains available until the shared native final phase');
  assert.equal(metadata.deferredMetadata.get(root).mode,0);assert.equal(metadata.deferredMetadata.get(root).kind,'directory');
 }finally{await rm(root,{recursive:true,force:true});}
});
