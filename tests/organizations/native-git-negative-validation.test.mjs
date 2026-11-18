import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,lstat,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {exportReviewedUserData,reviewedGitConfiguration,createReviewedRecoveryGit} from '../../apps/server/dist/portable-reviewed-user-data.js';
import {getNativeGitExternalGraph} from '../../apps/server/dist/portable-git-external-application.js';
import {planReviewedRecoveryRoots} from '../../apps/server/dist/portable-git-recreation.js';

const exec=promisify(execFile);
const options={skip:process.platform!=='linux'};
const git=async(cwd,...args)=>exec('git',['--no-optional-locks',...args],{cwd,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}});
const packageFor=manifest=>({schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Git graph rejection regression',rootRef:'agent',agents:[{ref:'agent',title:'Agent',engine:'codex',workingRootRef:'work',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingFolder:{directories:[],excludedPaths:['.git']},workingFiles:[{path:'.ponderosa-portable-review/user-data.json',artifactRef:'review'}],artifacts:[{ref:'review',kind:'generated_file',path:'.ponderosa-portable-review/user-data.json',createdAt:new Date().toISOString(),dataBase64:Buffer.from(JSON.stringify(manifest)).toString('base64')}]}]});

async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'native-git-negative-'))),source=path.join(root,'source'),destination=path.join(root,'destination');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(source);await mkdir(destination);await git(source,'init','--template=','--initial-branch=main');
 const hooks=path.join(source,'.git','hooks');await mkdir(hooks);await writeFile(path.join(hooks,'original'),'original\n');
 const manifest=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true});
 return {source,destination,hooks,manifest,activation:{git:true,harness:false}};
}

test('malformed portable Git aliases are refused by the production planner before native writes',options,async t=>{
 const f=await fixture(t),original=path.join(f.hooks,'original');
 const cases=[
  [{sourcePath:f.hooks+'/../escape',targetSourcePath:original,kind:'symlink'},/source provenance/],
  [{sourcePath:path.join(f.hooks,'missing-link'),targetSourcePath:path.join(f.hooks,'missing'),kind:'symlink'},/outside its represented graph/],
  [{sourcePath:path.join(f.hooks,'directory-hardlink'),targetSourcePath:f.hooks,kind:'hardlink'},/hardlink requires a real represented regular target/],
 ];
 for(const [link,expected] of cases){
  const forged=structuredClone(f.manifest);forged.gitExternalDependencies.links.push(link);
  assert.throws(()=>planReviewedRecoveryRoots(packageFor(forged),{work:f.destination},f.activation),expected);
  await assert.rejects(lstat(path.join(f.destination,'.git')),{code:'ENOENT'});
 }
});

test('unissued graphs cannot write; pure graph validation rejects owner writes and undeclared or nonregular targets',options,async t=>{
 const f=await fixture(t),original=Buffer.from(JSON.stringify(f.manifest)),sha256=createHash('sha256').update(original).digest('hex');
 const graph={directories:[{path:'capsule',mode:0o700,mtimeNs:'0'}],files:[{path:'capsule/file',data:Buffer.from('original'),mode:0o700,mtimeNs:'0'}],links:[]};
 const config={...reviewedGitConfiguration(f.manifest,f.activation),external:graph},context={gitDir:path.join(f.destination,'.git'),privateDir:path.join(f.destination,'.git'),worktreePath:f.destination};
 // Invalid local graph objects do not carry the planner-issued capability.
 await assert.rejects(createReviewedRecoveryGit(f.destination,original,sha256,f.activation,undefined,config),/locally issued dependency plan/);
 await assert.rejects(lstat(path.join(f.destination,'.git')),{code:'ENOENT'});
 const check=()=>getNativeGitExternalGraph(config,context);
 graph.links.push({path:'escape',target:'../outside',kind:'symlink'});
 assert.throws(check,/canonical contained owned paths/);graph.links.pop();
 graph.files.push({path:'forbidden',context:'owner',data:Buffer.from('x'),mode:0o700,mtimeNs:'0'});
 assert.throws(check,/owner contexts are references/);graph.files.pop();
 graph.links.push({path:'bad-view',target:'missing',targetContext:'owner',kind:'symlink'});
 assert.throws(check,/outside its complete declared owned graph/);
 graph.links[0].target='capsule';graph.links[0].kind='hardlink';
 assert.throws(check,/declared regular original/);
 await assert.rejects(lstat(path.join(f.destination,'.git')),{code:'ENOENT'});
});
