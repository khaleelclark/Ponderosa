import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {serializeSourcePath,normalizeSourcePath,canonicalSourcePath,sourcePathAbsolute,sourcePathKey,sourcePathWithin,sourcePathsEqual,joinSourcePath,resolveSourcePath,dirnameSourcePath,basenameSourcePath,relativeSourcePath} from '../../apps/server/dist/portable-source-paths.js';
import {parseReviewedGitConfiguration,parseReviewedUserData,validateReviewedGit,validateReviewedUserDataActivation,validatePortableGitStorageBindings,gitBindingSourceEvidence,reviewedGitConfiguration} from '../../apps/server/dist/portable-reviewed-user-data.js';
import {bindReviewedGitDirectories,compileReviewedGitConfiguration} from '../../apps/server/dist/portable-git-configuration.js';

const baseGit=(directories)=>({version:1,format:'sha1',configurationSourceDirectories:directories,reftableReview:null,objects:[],refs:[],head:{symbolic:'refs/heads/main'},index:[],resolveUndo:[],reflogs:[],reflogMissingObjects:[],indexOptionalReview:[],configurationReview:[],configurationOriginalReview:[{path:'config',source:'common_repository',dataBase64:'',removedFields:false},{path:'config.worktree',source:'selected_worktree',dataBase64:null,removedFields:false}],sparseReview:{patternsBase64:null,directories:[]},infoReview:['info/attributes','info/exclude'].map(path=>({path,source:'common_repository',dataBase64:null})),shallowReview:{path:'shallow',source:'common_repository',dataBase64:null},packRetentionReview:[],origHeadReview:{path:'ORIG_HEAD',source:'selected_worktree',dataBase64:null,reflogDataBase64:null},fetchHeadReview:{path:'FETCH_HEAD',source:'selected_worktree',dataBase64:null},modules:[],exclusions:[]});
const reviewed=git=>({version:1,activation:'inert_review_only',selection:{git:true,harness:false},recreationScope:{absoluteLinks:'refuse',crossRootLinks:'refuse',cyclicLinks:'passive_in_root',specialNodes:'refuse',acl:'not_inspected_preserve_source',xattrs:'not_inspected_preserve_source'},git,providerFiles:[],providerDirectories:[],exclusions:[]});

test('source paths resolve Windows drive/UNC and POSIX namespaces without using the executing host',()=>{
 assert.equal(serializeSourcePath(String.raw`c:\Users\Pat\Repo\.git`),'C:/Users/Pat/Repo/.git');
 assert.equal(serializeSourcePath(String.raw`\\server\share\Repo\..\Settings`),'//server/share/Settings');
 assert.equal(normalizeSourcePath('//server/share'),'//server/share/');
 assert.equal(normalizeSourcePath('C:/'),'C:/');assert.equal(dirnameSourcePath('C:/'),'C:/');
 assert.equal(resolveSourcePath('C:/Repo/.git',String.raw`..\Settings\config`),'C:/Repo/Settings/config');
 assert.equal(resolveSourcePath('C:/Repo/.git','/Settings/config'),'C:/Settings/config');
 assert.equal(resolveSourcePath('C:/Repo/.git','D:/Settings/config'),'D:/Settings/config');
 assert.equal(resolveSourcePath('//server/share/Repo/.git','../settings'),'//server/share/Repo/settings');
 assert.equal(joinSourcePath('//server/share/','Repo','.git'),'//server/share/Repo/.git');
 assert.equal(basenameSourcePath('D:/Repo/.git'),'.git');
 assert.equal(dirnameSourcePath('//server/share/Repo/.git'),'//server/share/Repo');
 assert.equal(relativeSourcePath('C:/Repo','c:/repo/Settings/config'),'Settings/config');
 assert.equal(sourcePathWithin('C:/Repo','c:/repo/Settings/config'),true);
 assert.equal(sourcePathWithin('C:/Repo','C:/Repository/config'),false);
 assert.equal(sourcePathWithin('C:/Repo','D:/Repo/config'),false);
 assert.equal(sourcePathWithin('//one/share/','//two/share/file'),false);
 assert.equal(sourcePathWithin('/repo','/Repo/file'),false);
 assert.equal(sourcePathWithin('/','/repo/file'),true);
 assert.equal(sourcePathWithin('/repo','C:/repo/file'),false);
 assert.equal(sourcePathsEqual('C:/Repo','c:/repo'),true);
 assert.equal(sourcePathKey('//SERVER/Share/Repo'),'//server/share/repo');
 assert.equal(resolveSourcePath('/repo/.git','../settings'),'/repo/settings');
 assert.equal(sourcePathAbsolute('C:/repo'),true);assert.equal(sourcePathAbsolute('C:repo'),false);
 for(const value of ['C:repo',String.raw`\relative`,String.raw`\\?\C:\repo`,String.raw`\\.\pipe\service`,'//server','/a\0b'])assert.throws(()=>normalizeSourcePath(value));
 assert.throws(()=>resolveSourcePath('C:/repo','D:relative'),/Ambiguous/);
 for(const value of ['c:/repo','C:/repo/../other',String.raw`C:\repo`,'/repo/./child'])assert.equal(canonicalSourcePath(value),false);
});

test('Windows provenance and exact module core.worktree scalars roundtrip as inert portable originals',()=>{
 for(const common of ['C:/Repo/.git','//server/share/Repo/.git']){
  const git=baseGit({common,private:common,home:'D:/Users/Pat'});
  const storage=joinSourcePath(common,'modules','child'),working=resolveSourcePath(common,'../child'),coreWorktree=String.raw`..\..\..\child`;
  git.modules=[{name:'child',source:{storagePath:storage,worktreePath:working,coreWorktree,configurationSha256:'a'.repeat(64),initialized:true},worktreeRelativePath:'child',git:baseGit({common:storage,private:storage,home:'D:/Users/Pat'}),originals:[]}];
  validateReviewedGit(git);
  const wire=Buffer.from(JSON.stringify(reviewed(git))),roundtrip=parseReviewedUserData(wire);
  assert.deepEqual(roundtrip.git.configurationSourceDirectories,git.configurationSourceDirectories);
  assert.equal(roundtrip.git.modules[0].source.coreWorktree,coreWorktree,'exact native scalar bytes are not normalized');
  assert.equal(Buffer.from(JSON.stringify(roundtrip)).equals(wire),true);
  const invalid=structuredClone(git);invalid.configurationSourceDirectories.common=String.raw`C:\Repo\.git`;
  assert.throws(()=>validateReviewedGit(invalid),/provenance/);
 }
});

test('Windows historical linked association proof is portable while its original pointer bytes stay exact',()=>{
 const identity=(inode,mode=16877)=>`1:${inode}:${mode}:1000:1:0:0`,work='C:/Work',storage='C:/Repo/.git';
 const original=(rootRef,relativePath,value,inode)=>({rootRef,relativePath,identity:identity(inode,33188),dataBase64:Buffer.from(value).toString('base64')});
 const proof={version:1,currentAuthority:false,roots:[{rootRef:'work',sourcePath:work,identity:identity(1)},{rootRef:'storage',sourcePath:storage,identity:identity(2)}],records:[
  {rootRef:'work',relativePath:'.',identity:identity(1)},original('work','.git','gitdir: C:\\Repo\\.git\\worktrees\\selected\n',5),
  {rootRef:'storage',relativePath:'.',identity:identity(2)},{rootRef:'storage',relativePath:'worktrees',identity:identity(3)},{rootRef:'storage',relativePath:'worktrees/selected',identity:identity(4)},
  original('storage','worktrees/selected/commondir','..\\..\n',6),original('storage','worktrees/selected/gitdir','C:\\Work\\.git\n',7),
  {rootRef:'storage',relativePath:'commondir',identity:'',absent:true},{rootRef:'storage',relativePath:'gitdir',identity:'',absent:true},
 ]};
 const bindings=[{id:'common',worktreeRootRef:'work',storageRootRef:'storage',relativePath:'.',role:'common',capture:proof},{id:'private',worktreeRootRef:'work',storageRootRef:'storage',relativePath:'worktrees/selected',role:'private',capture:proof}];
 validatePortableGitStorageBindings(bindings,new Set(['work','storage']));
 const clone=JSON.parse(JSON.stringify(bindings));validatePortableGitStorageBindings(clone,new Set(['work','storage']));
 assert.equal(gitBindingSourceEvidence(clone[1]),gitBindingSourceEvidence(bindings[1]));
 assert.equal(clone[0].capture.currentAuthority,false);
 const invalid=structuredClone(bindings);invalid[0].capture.roots[0].sourcePath='C:relative';assert.throws(()=>validatePortableGitStorageBindings(invalid,new Set(['work','storage'])));
});

test('Windows include/home/config prefixes relocate only into explicit current-host destinations',()=>{
 const fresh=path.resolve('portable-source-only-destination'),git=baseGit({common:'C:/Repo/.git',private:'C:/Repo/.git',home:'D:/Users/Pat'}),value=reviewed(git);
 git.configurationReview=[{key:'include.path',value:String.raw`..\Config\outer.conf`},{key:'core.excludesfile',value:String.raw`~\ignore.global`},{key:'remote.origin.url',value:'E:/Repositories/remote.git'},{key:'includeif.gitdir/i:C:/Repo/**.path',value:'C:/Config/extra.conf'},{key:'include.path',value:'//server/share/config/base.conf'}];
 const activation={git:true,harness:false,gitPathMappings:[['C:/Repo','repo'],['D:/Users','home'],['E:/Repositories','remotes'],['C:/Config','config'],['//server/share/','share']].map(([source,destination])=>({source,destination:path.join(fresh,destination)}))};
 validateReviewedUserDataActivation(activation);
 const plan=reviewedGitConfiguration(value,activation);
 assert.deepEqual(plan.includes.map(item=>item.source),['C:/Repo/Config/outer.conf','C:/Config/extra.conf','//server/share/config/base.conf']);
 assert.ok(plan.targets.includes(path.join(fresh,'home','Pat','ignore.global')));
 assert.ok(plan.targets.includes(path.join(fresh,'remotes','remote.git')));
 assert.match(plan.common.toString(),/gitdir\/i:/);
 const duplicate=structuredClone(activation);duplicate.gitPathMappings.push({source:'C:/REPO',destination:path.join(fresh,'other')});
 assert.throws(()=>validateReviewedUserDataActivation(duplicate),/Duplicate/);
});

test('include compilation consumes transported destination originals without reading historical Windows paths',()=>{
 const fresh=path.resolve('portable-source-compile'),git=baseGit({common:'C:/Repo/.git',private:'C:/Repo/.git',home:'C:/Users/Pat'}),value=reviewed(git);
 const parsed=parseReviewedGitConfiguration(Buffer.from('[include]\n path = ../settings.conf\n'));
 git.configurationReview=parsed.items;git.configurationOriginalReview[0].dataBase64=parsed.data.toString('base64');
 const activation=bindReviewedGitDirectories(value,{git:true,harness:false,gitPathMappings:[{source:'C:/Repo',destination:fresh}]},{common:path.join(fresh,'.git'),private:path.join(fresh,'.git')});
 const requested=[];
 const plan=compileReviewedGitConfiguration(value,activation,{common:path.join(fresh,'.git'),private:path.join(fresh,'.git')},name=>{requested.push(name);return name===path.join(fresh,'settings.conf')?Buffer.from('[portable]\n retained = yes\n'):undefined;});
 assert.deepEqual(requested,[path.join(fresh,'settings.conf')]);
 assert.equal(plan.includeFiles.length,1);assert.match(plan.includeFiles[0].data.toString(),/retained/);
 assert.ok(!plan.common.toString().includes('C:/Repo'));
});
