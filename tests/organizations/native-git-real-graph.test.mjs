import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,link,symlink,readlink,lstat,realpath,rename,chmod,rm,utimes,lutimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {exportReviewedUserData} from '../../apps/server/dist/portable-reviewed-user-data.js';
import {planReviewedRecoveryRoots,applyReviewedRecoveryRoots} from '../../apps/server/dist/portable-git-recreation.js';
import {getNativeGitExternalGraph} from '../../apps/server/dist/portable-git-external-application.js';

const exec=promisify(execFile);
const git=async(cwd,...args)=>exec('git',['--no-optional-locks',...args],{cwd,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}});
const options={skip:process.platform!=='linux'};
const data=Buffer.from('#!/bin/sh\nexit 0\n');
const identity=stat=>({device:stat.dev.toString(),inode:stat.ino.toString()});
const destinationIdentity=async destination=>({...identity(await lstat(destination,{bigint:true})),directories:{hooks:identity(await lstat(path.join(destination,'hooks'),{bigint:true}))}});
const packageFor=(manifest,working={})=>{
 const files={'.ponderosa-portable-review/user-data.json':Buffer.from(JSON.stringify(manifest)),...working};
 return {schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Real Git graph custody regression',rootRef:'agent',agents:[{ref:'agent',title:'Agent',engine:'codex',workingRootRef:'work',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingFolder:{directories:[],excludedPaths:['.git']},workingFiles:Object.keys(files).map((name,index)=>({path:name,artifactRef:'file-'+index})),artifacts:Object.entries(files).map(([name,bytes],index)=>({ref:'file-'+index,kind:'generated_file',path:name,createdAt:new Date().toISOString(),dataBase64:Buffer.from(bytes).toString('base64')}))}]};
};
async function fixture(t,worktree=false){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'native-real-graph-'))),source=path.join(root,'source'),destination=path.join(root,'destination');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(source);await mkdir(destination);
 await git(source,'init','--template=','--initial-branch=main');await git(source,'config','core.sharedRepository','group');
 const sourceHooks=worktree?path.join(source,'hooks'):path.join(source,'.git','hooks');
 await mkdir(sourceHooks);await writeFile(path.join(sourceHooks,'script'),data);await chmod(path.join(sourceHooks,'script'),0o751);
 if(!worktree){
  await link(path.join(sourceHooks,'script'),path.join(sourceHooks,'hard'));
  await symlink('script',path.join(sourceHooks,'symbol'));
  await chmod(sourceHooks,0o2750);
  await utimes(path.join(sourceHooks,'script'),1700000000.123456,1700000000.123456);
  await lutimes(path.join(sourceHooks,'symbol'),1700000000.123456,1700000000.123456);
  await utimes(sourceHooks,1700000000.123456,1700000000.123456);
 } else {
  await git(source,'config','core.hooksPath','hooks');
  await mkdir(path.join(destination,'hooks'));await writeFile(path.join(destination,'hooks','script'),data);
 }
 const sourceFile=await lstat(path.join(sourceHooks,'script'),{bigint:true});
 const sourceDir=await lstat(sourceHooks,{bigint:true});
 const sourceLink=worktree?undefined:await lstat(path.join(sourceHooks,'symbol'),{bigint:true});
 const manifest=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});
 const activation={git:true,harness:false},pkg=packageFor(manifest,worktree?{'hooks/script':data}:{});
 const tasks=planReviewedRecoveryRoots(pkg,{work:destination},activation);
 assert.equal(tasks.length,1);
 const graph=getNativeGitExternalGraph(tasks[0].configuration,{gitDir:path.join(destination,'.git'),privateDir:path.join(destination,'.git'),worktreePath:destination});
 return {root,source,destination,sourceHooks,sourceFile,sourceDir,sourceLink,manifest,activation,tasks,graph,apply:(expected,beforeFinalize)=>applyReviewedRecoveryRoots(tasks,activation,()=>{},expected,undefined,beforeFinalize)};
}

test('real reviewed default hook graph restores exact alias and metadata evidence',options,async t=>{
 const f=await fixture(t);
 const original=f.graph.files.find(node=>node.path.endsWith('/hooks/hard')||node.path.endsWith('/hooks/script'));
 assert.ok(original,'the real planner issues an owned original');
 await f.apply();
 const target=path.join(f.destination,'.git','hooks'),file=await lstat(path.join(target,'script'),{bigint:true}),hard=await lstat(path.join(target,'hard'),{bigint:true}),dir=await lstat(target,{bigint:true}),symbol=await lstat(path.join(target,'symbol'),{bigint:true});
 assert.equal(file.dev,hard.dev);assert.equal(file.ino,hard.ino);assert.equal(file.nlink,2n);
 assert.equal(file.mode&0o7777n,f.sourceFile.mode&0o7777n);assert.equal(file.mtimeNs,f.sourceFile.mtimeNs);
 assert.equal(dir.mode&0o7777n,f.sourceDir.mode&0o7777n);assert.equal(dir.mtimeNs,f.sourceDir.mtimeNs);
 assert.equal(await readlink(path.join(target,'symbol')),'script');assert.equal(symbol.mtimeNs,f.sourceLink.mtimeNs);
 assert.deepEqual(await readFile(path.join(target,'script')),data);
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
