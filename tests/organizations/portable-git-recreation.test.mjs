import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,chmod,lstat,realpath,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {exportReviewedUserData,createGitExportCapture} from '../../apps/server/dist/portable-reviewed-user-data.js';
import {planReviewedRecoveryRoots,applyReviewedRecoveryRoots} from '../../apps/server/dist/portable-git-recreation.js';

const exec=promisify(execFile);
const git=async(cwd,...args)=>(await exec('git',['--no-optional-locks',...args],{cwd,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();
const packageFor=(manifest,files={},bindings)=>{
  const entries={[".ponderosa-portable-review/user-data.json"]:JSON.stringify(manifest),...files};
  return {schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Git recreation regression',rootRef:'agent',agents:[{ref:'agent',title:'Agent',engine:'codex',workingRootRef:'work',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingFolder:{directories:[],excludedPaths:['.git']},workingFiles:Object.keys(entries).map((name,i)=>({path:name,artifactRef:'file-'+i})),artifacts:Object.entries(entries).map(([name,data],i)=>({ref:'file-'+i,kind:'generated_file',path:name,createdAt:new Date().toISOString(),dataBase64:Buffer.from(data).toString('base64')}))},...(bindings?[{ref:'storage-agent',title:'Storage',engine:'codex',workingRootRef:'storage',managerRef:'agent',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingFolder:{directories:[],excludedPaths:['.']},workingFiles:[]}]:[])],...(bindings?{gitStorageBindings:bindings}:{})};
};
async function initialize(root){await mkdir(root);await git(root,'init','--template=','--initial-branch=main');await git(root,'config','user.name','Portable Test');await git(root,'config','user.email','portable@example.invalid');await writeFile(path.join(root,'file.txt'),'committed\n');await git(root,'add','file.txt');await git(root,'commit','--no-gpg-sign','-m','Initial');}

test('fresh recovery preserves staged work, activates hook metadata and recursively relocates included configuration without running hooks',async()=>{
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
