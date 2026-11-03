import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {exportReviewedBareGit,exportReviewedUserData,parseReviewedUserData} from '../../apps/server/dist/portable-reviewed-user-data.js';

const native=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-C',cwd,...args],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}}).trim();
async function fixture(t){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'ponderosa-bare-capsule-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),hooks=path.join(root,'dependencies'),bare=path.join(hooks,'archive.git');
  await mkdir(source);await mkdir(hooks);
  native(source,'init','--initial-branch=main');native(source,'config','user.name','Fixture');native(source,'config','user.email','fixture@example.invalid');
  await writeFile(path.join(source,'file.txt'),'retained object\n');native(source,'add','file.txt');native(source,'commit','-m','original');
  native(root,'clone','--bare','--no-hardlinks',source,bare);
  native(source,'config','core.hooksPath',hooks);
  return {source,bare,hooks,oid:native(source,'rev-parse','HEAD')};
}

test('configured bare capsule preserves canonical graph and safe ancillary files without raw config credentials',async t=>{
  const {source,bare,hooks,oid}=await fixture(t);
  await writeFile(path.join(bare,'config'),(await readFile(path.join(bare,'config'),'utf8'))+'\n[credential]\n helper = secret-helper-fixture\n');
  await writeFile(path.join(bare,'README.txt'),'ordinary ancillary bytes\n');
  await mkdir(path.join(bare,'worktrees'));
  await writeFile(path.join(bare,'hooks','custom-hook'),'#!/bin/sh\necho retained\n');
  for(const name of ['.git-credentials','.netrc','_netrc','id_ed25519','key.pfx'])await writeFile(path.join(hooks,name),'credential-fixture');
  await writeFile(path.join(hooks,'id_ed25519.pub'),'public-key-fixture');
  const config=await readFile(path.join(bare,'config'));
  const result=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});
  const family=result.gitExternalDependencies,capsule=family.repositories.find(repository=>repository.sourcePath===bare);
  assert.ok(family.omittedPaths.includes(path.join(bare,'worktrees')));
  assert.equal(capsule.bare,true);assert.ok(capsule.git.objects.some(object=>object.oid===oid));
  assert.ok(capsule.git.configurationReview.some(item=>item.key==='core.bare'&&item.value==='true'));
  assert.ok(!capsule.git.configurationReview.some(item=>item.key.startsWith('credential.')));
  assert.ok(!Buffer.from(capsule.git.configurationOriginalReview.find(item=>item.path==='config').dataBase64,'base64').toString('utf8').includes('secret-helper-fixture'));
  assert.ok(!family.files.some(file=>file.sourcePath===path.join(bare,'config')||file.sourcePath.startsWith(path.join(bare,'objects')+path.sep)));
  assert.ok(family.files.some(file=>file.sourcePath===path.join(bare,'README.txt')));
  assert.ok(family.files.some(file=>file.sourcePath===path.join(bare,'hooks','custom-hook')));
  assert.ok(family.files.some(file=>file.sourcePath===path.join(hooks,'id_ed25519.pub')));
  for(const name of ['.git-credentials','.netrc','_netrc','id_ed25519','key.pfx'])assert.ok(family.omittedPaths.includes(path.join(hooks,name)));
  assert.ok(!JSON.stringify(result).includes('secret-helper-fixture'));assert.ok(!JSON.stringify(result).includes('credential-fixture'));
  parseReviewedUserData(Buffer.from(JSON.stringify(result)));
  assert.deepEqual(await readFile(path.join(bare,'config')),config,'capture never edits source configuration');
  const untyped=structuredClone(result);delete untyped.gitExternalDependencies.repositories[0].bare;
  assert.throws(()=>parseReviewedUserData(Buffer.from(JSON.stringify(untyped))),/bare repository provenance/i);
  const forged=structuredClone(result);forged.gitExternalDependencies.repositories[0].bare=false;
  assert.throws(()=>parseReviewedUserData(Buffer.from(JSON.stringify(forged))),/bare repository provenance/i);
});

test('bare source refuses working-tree authority and preserves the rejected original',async t=>{
  const {bare}=await fixture(t);
  native(bare,'config','core.worktree','/ungranted/source');
  const original=await readFile(path.join(bare,'config'));
  await assert.rejects(exportReviewedBareGit(bare),/cannot claim a working tree/);
  assert.deepEqual(await readFile(path.join(bare,'config')),original);
  native(bare,'config','--unset','core.worktree');
  await writeFile(path.join(bare,'config'),(await readFile(path.join(bare,'config'),'utf8'))+'\n[core]\n worktree\n');
  await assert.rejects(exportReviewedBareGit(bare),/cannot claim a working tree/);
  native(bare,'config','--unset-all','core.worktree');
  await writeFile(path.join(bare,'config.worktree'),'[core]\n bare = false\n');
  await assert.rejects(exportReviewedBareGit(bare),/cannot override bare storage/);
  await rm(path.join(bare,'config.worktree'));native(bare,'config','core.bare','false');
  await assert.rejects(exportReviewedBareGit(bare),/explicit core.bare=true/);
});
