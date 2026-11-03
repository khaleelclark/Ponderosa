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
 const rootStat=await lstat(root,{bigint:true}),gitStat=await lstat(gitDir,{bigint:true}),pair=stat=>({device:stat.dev.toString(),inode:stat.ino.toString()});
 return {root,gitDir,owned,configuration,storage:importedNativeGitStorage(root,configuration),custody:{roots:{[root]:pair(rootStat)},directories:new Map([[gitDir,pair(gitStat)],[owned,pair(directory)]])}};
}
test('native proof admits only the declared closed alias graph, with exact bytes and complete inode groups',{skip:process.platform==='win32'},async()=>{
 const f=await graphFixture();try{
  const proof=await snapshotImportedNativeGit(f.root,[f.root],f.storage,f.configuration,undefined,f.custody);
  assert.equal((await snapshotImportedNativeGit(f.root,[f.root],f.storage,undefined,proof.external,f.custody)).snapshot,proof.snapshot);
  assert.equal(proof.external.files[0].sha256,createHash('sha256').update('one declared original').digest('hex'));assert.equal(proof.external.files[0].data,undefined,'Proof retains hashes rather than a second payload buffer');
  await link(path.join(f.owned,'original'),path.join(f.root,'outside-alias'));
  await assert.rejects(snapshotImportedNativeGit(f.root,[f.root],f.storage,undefined,proof.external,f.custody),/hardlinked|count|graph/);await unlink(path.join(f.root,'outside-alias'));
  await symlink('owned/original',path.join(f.gitDir,'undeclared-alias'));
  await assert.rejects(snapshotImportedNativeGit(f.root,[f.root],f.storage,undefined,proof.external,f.custody),/Unexpected native symlink/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('native proof refuses changed declared target or contents without following outside aliases',{skip:process.platform==='win32'},async()=>{
 const f=await graphFixture();const originalOpen=hostFs.open;let outsideOpened=false;try{
  const proof=await snapshotImportedNativeGit(f.root,[f.root],f.storage,f.configuration),outside=path.join(f.root,'outside-original');await writeFile(outside,'must stay private');
  await unlink(path.join(f.owned,'symbolic'));await symlink('../..'+path.sep+'outside-original',path.join(f.owned,'symbolic'));
  proof.external.directories[0].mtimeNs=(await lstat(f.owned,{bigint:true})).mtimeNs.toString();
  hostFs.open=async function(name,...args){if(name===outside)outsideOpened=true;return originalOpen.call(this,name,...args);};
  await assert.rejects(snapshotImportedNativeGit(f.root,[f.root],f.storage,undefined,proof.external,f.custody),/symlink target/);assert.equal(outsideOpened,false);assert.equal(await readFile(outside,'utf8'),'must stay private');
 }finally{hostFs.open=originalOpen;await rm(f.root,{recursive:true,force:true});}
});
test('native snapshot pins regular type before any data open when a metadata file becomes FIFO',{skip:process.platform!=='linux',timeout:10000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'native-snapshot-fifo-')),gitDir=path.join(root,'.git'),target=path.join(gitDir,'config'),retained=target+'.retained';await mkdir(gitDir);await writeFile(path.join(gitDir,'HEAD'),'ref: refs/heads/main\n');await writeFile(target,'[core]\n repositoryformatversion = 0\n');
 const issued=await lstat(root,{bigint:true}),native=await lstat(gitDir,{bigint:true}),custody={roots:{[root]:{device:issued.dev.toString(),inode:issued.ino.toString()}},directories:new Map([[gitDir,{device:native.dev.toString(),inode:native.ino.toString()}]])};
 const originalLstat=hostFs.lstat,originalOpen=hostFs.open;let observations=0,replaced=false,dataOpened=false;
 try{
  hostFs.lstat=async function(name,...args){const stat=await originalLstat.call(this,name,...args);if(name===target&&++observations===2){await rename(target,retained);execFileSync('mkfifo',[target]);replaced=true;}return stat;};
  hostFs.open=async function(name,...args){if(name===target)dataOpened=true;return originalOpen.call(this,name,...args);};
  await assert.rejects(snapshotImportedNativeGit(root,[root],importedNativeGitStorage(root),undefined,undefined,custody),/regular|identity|replaced|pin/i);assert.equal(replaced,true);assert.equal(dataOpened,false);assert.equal(await readFile(retained,'utf8'),'[core]\n repositoryformatversion = 0\n');
 }finally{hostFs.lstat=originalLstat;hostFs.open=originalOpen;await rm(root,{recursive:true,force:true});}
});

test('linked capsule proof binds worktree pointer to private slot and both reciprocal common/private pointers',{skip:process.platform==='win32'},async()=>{
 const f=await graphFixture();try{
  const common=path.join(f.gitDir,'capsule'),privateDir=path.join(common,'worktrees','selected'),worktree=path.join(f.root,'capsule-worktree');
  await mkdir(privateDir,{recursive:true});await mkdir(worktree);await writeFile(path.join(common,'HEAD'),'ref: refs/heads/common\n');await writeFile(path.join(privateDir,'HEAD'),'ref: refs/heads/selected\n');
  await writeFile(path.join(privateDir,'commondir'),path.relative(privateDir,common).split(path.sep).join('/')+'\n');await writeFile(path.join(privateDir,'gitdir'),path.relative(privateDir,path.join(worktree,'.git')).split(path.sep).join('/')+'\n');await writeFile(path.join(worktree,'.git'),'gitdir: '+path.relative(worktree,privateDir).split(path.sep).join('/')+'\n');
  const module={gitDir:common,worktreePath:worktree,initialized:true,value:{},activation:{git:true,harness:false},configuration:{common:Buffer.from(''),private:null,targets:[],includes:[]},layout:{commonDir:common,privateDir,writeCommon:true}};
  const worktreeStat=await lstat(worktree,{bigint:true});f.configuration.external.directories.push({context:'worktree',path:'capsule-worktree',mode:Number(worktreeStat.mode)&0o7777,mtimeNs:worktreeStat.mtimeNs.toString()});
  f.configuration.modules=[module];for(const target of [common,path.join(common,'worktrees'),privateDir,worktree]){const stat=await lstat(target,{bigint:true});f.custody.directories.set(target,{device:stat.dev.toString(),inode:stat.ino.toString()});}
  const storage=importedNativeGitStorage(f.root,f.configuration);assert.equal(storage.modulePointers[0].gitDir,privateDir);assert.ok(storage.moduleGitDirs.includes(common));assert.ok(storage.moduleGitDirs.includes(privateDir));
  const proof=await snapshotImportedNativeGit(f.root,[f.root],storage,f.configuration,undefined,f.custody);assert.equal((await snapshotImportedNativeGit(f.root,[f.root],storage,undefined,proof.external,f.custody)).snapshot,proof.snapshot);
  await writeFile(path.join(privateDir,'commondir'),'../../wrong-common\n');await assert.rejects(snapshotImportedNativeGit(f.root,[f.root],storage,undefined,proof.external,f.custody),/planned storage/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('first seal rejects replacement of its issued root before opening native data',{skip:process.platform==='win32'},async()=>{
 const f=await graphFixture(),retained=f.root+'-retained';const originalOpen=hostFs.open;let dataOpened=false;
 try{
  await rename(f.root,retained);await mkdir(f.root);
  hostFs.open=async function(name,...args){if(typeof name==='string'&&name.startsWith(f.root+path.sep))dataOpened=true;return originalOpen.call(this,name,...args);};
  await assert.rejects(snapshotImportedNativeGit(f.root,[f.root],f.storage,f.configuration,undefined,f.custody),/custody changed/);assert.equal(dataOpened,false);assert.equal(await readFile(path.join(retained,'.git','owned','original'),'utf8'),'one declared original');
 }finally{hostFs.open=originalOpen;await rm(f.root,{recursive:true,force:true});await rm(retained,{recursive:true,force:true});}
});
