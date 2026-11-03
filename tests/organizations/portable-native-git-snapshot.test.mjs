import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,link,symlink,lstat,rename,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promises as hostFs} from '@ponderosa/native-host/fs';
import {snapshotImportedNativeGit,importedNativeGitStorage} from '../../apps/server/dist/portable-native-git-snapshot.js';
async function graphFixture(){
 const root=await mkdtemp(path.join(tmpdir(),'native-snapshot-graph-')),gitDir=path.join(root,'.git'),owned=path.join(gitDir,'owned');await mkdir(gitDir);await mkdir(owned,{mode:0o750});await writeFile(path.join(gitDir,'HEAD'),'ref: refs/heads/main\n');await writeFile(path.join(gitDir,'config'),'[core]\n repositoryformatversion = 0\n');
 const data=Buffer.from('one declared original');await writeFile(path.join(owned,'original'),data,{mode:0o640});await link(path.join(owned,'original'),path.join(owned,'hard'));await symlink('original',path.join(owned,'symbolic'));await symlink('cycle-b',path.join(owned,'cycle-a'));await symlink('cycle-a',path.join(owned,'cycle-b'));
 const file=await lstat(path.join(owned,'original'),{bigint:true}),directory=await lstat(owned,{bigint:true});
 const configuration={common:Buffer.from(''),private:null,targets:[],includes:[],external:{directories:[{path:'owned',mode:Number(directory.mode)&0o7777,mtimeNs:directory.mtimeNs.toString()}],files:[{path:'owned/original',data,mode:Number(file.mode)&0o7777,mtimeNs:file.mtimeNs.toString()}],links:[{path:'owned/hard',target:'owned/original',kind:'hardlink'},{path:'owned/symbolic',target:'owned/original',kind:'symlink'},{path:'owned/cycle-a',target:'owned/cycle-b',kind:'symlink'},{path:'owned/cycle-b',target:'owned/cycle-a',kind:'symlink'}]}};
 return {root,gitDir,owned,configuration,storage:importedNativeGitStorage(root,configuration)};
}
test('native proof admits only the declared closed alias graph, with exact bytes and complete inode groups',{skip:process.platform==='win32'},async()=>{
 const f=await graphFixture();try{
  const proof=await snapshotImportedNativeGit(f.root,[f.root],f.storage,f.configuration);
  assert.equal((await snapshotImportedNativeGit(f.root,[f.root],f.storage,undefined,proof.external)).snapshot,proof.snapshot);
  assert.equal(proof.external.files[0].sha256,createHash('sha256').update('one declared original').digest('hex'));assert.equal(proof.external.files[0].data,undefined,'Proof retains hashes rather than a second payload buffer');
  await link(path.join(f.owned,'original'),path.join(f.root,'outside-alias'));
  await assert.rejects(snapshotImportedNativeGit(f.root,[f.root],f.storage,undefined,proof.external),/hardlinked|count|graph/);await unlink(path.join(f.root,'outside-alias'));
  await symlink('owned/original',path.join(f.gitDir,'undeclared-alias'));
  await assert.rejects(snapshotImportedNativeGit(f.root,[f.root],f.storage,undefined,proof.external),/Unexpected native symlink/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('native proof refuses changed declared target or contents without following outside aliases',{skip:process.platform==='win32'},async()=>{
 const f=await graphFixture();const originalOpen=hostFs.open;let outsideOpened=false;try{
  const proof=await snapshotImportedNativeGit(f.root,[f.root],f.storage,f.configuration),outside=path.join(f.root,'outside-original');await writeFile(outside,'must stay private');
  await unlink(path.join(f.owned,'symbolic'));await symlink('../..'+path.sep+'outside-original',path.join(f.owned,'symbolic'));
  proof.external.directories[0].mtimeNs=(await lstat(f.owned,{bigint:true})).mtimeNs.toString();
  hostFs.open=async function(name,...args){if(name===outside)outsideOpened=true;return originalOpen.call(this,name,...args);};
  await assert.rejects(snapshotImportedNativeGit(f.root,[f.root],f.storage,undefined,proof.external),/symlink target/);assert.equal(outsideOpened,false);assert.equal(await readFile(outside,'utf8'),'must stay private');
 }finally{hostFs.open=originalOpen;await rm(f.root,{recursive:true,force:true});}
});
test('native snapshot pins regular type before any data open when a metadata file becomes FIFO',{skip:process.platform!=='linux',timeout:10000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'native-snapshot-fifo-')),gitDir=path.join(root,'.git'),target=path.join(gitDir,'config'),retained=target+'.retained';await mkdir(gitDir);await writeFile(path.join(gitDir,'HEAD'),'ref: refs/heads/main\n');await writeFile(target,'[core]\n repositoryformatversion = 0\n');
 const originalLstat=hostFs.lstat,originalOpen=hostFs.open;let observations=0,replaced=false,dataOpened=false;
 try{
  hostFs.lstat=async function(name,...args){const stat=await originalLstat.call(this,name,...args);if(name===target&&++observations===2){await rename(target,retained);execFileSync('mkfifo',[target]);replaced=true;}return stat;};
  hostFs.open=async function(name,...args){if(name===target)dataOpened=true;return originalOpen.call(this,name,...args);};
  await assert.rejects(snapshotImportedNativeGit(root,[root],importedNativeGitStorage(root)),/regular|identity|replaced|pin/i);assert.equal(replaced,true);assert.equal(dataOpened,false);assert.equal(await readFile(retained,'utf8'),'[core]\n repositoryformatversion = 0\n');
 }finally{hostFs.lstat=originalLstat;hostFs.open=originalOpen;await rm(root,{recursive:true,force:true});}
});
