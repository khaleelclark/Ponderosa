import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {planReviewedGitExternalApplication,getNativeGitExternalGraph,getNativeGitGeneratedHookViews,bindNativeGitExternalGraphOwner} from '../../apps/server/dist/portable-git-external-application.js';

const base=path.resolve('/fresh/work'),common=path.join(base,'.git');
const context={common,private:common,worktree:base};
const metadata={mode:0o751,mtimeNs:'1700000000123456789'};
const file=(sourcePath,data='script')=>({sourcePath,dataBase64:Buffer.from(data).toString('base64'),...metadata});
const folder=(sourcePath)=>({sourcePath,root:true,mode:0o750,mtimeNs:metadata.mtimeNs});
const git=(root)=>({configurationSourceDirectories:{common:root+'/.git',private:root+'/.git'},modules:[]});
const family=(fields={})=>({version:1,sourceWorkingRoot:'/old',files:[],directories:[],links:[],absentPaths:[],omittedPaths:[],bindings:[],...fields});
const value=(dependencies)=>({version:1,selection:{git:true,harness:false},git:git('/old'),providerFiles:[],gitExternalDependencies:dependencies});
const config=(external)=>({common:Buffer.alloc(0),private:null,targets:[],includes:[],external});
const binding=(kind,rawValue,resolvedPath,context='config',contextSourcePath='/old/.git')=>({kind,rawValue,resolvedPath,context,contextSourcePath,sourceConfigPath:'/old/.git/config'});
const plan=(data,transported=new Map())=>planReviewedGitExternalApplication(data,{git:true,harness:false},context,[base],transported);

test('relative hook contexts retain one canonical working copy and explicit generated symlink views',()=>{
 const data=value(family({files:[file('/old/.husky/pre-commit')],directories:[folder('/old/.husky')],bindings:[binding('hooks','.husky','/old/.husky','worktree','/old'),binding('hooks','.husky','/old/.git/.husky','gitdir','/old/.git')],absentPaths:['/old/.git/.husky']}));
 const planned=plan(data,new Map([[path.join(base,'.husky','pre-commit'),Buffer.from('script')]]));
 const projected=planned.project(context,'/old/.git/config','core.hooksPath','.husky');
 assert.match(projected.value,/^\.ponderosa-portable-review\/active-git-hooks\/[a-f0-9]{64}$/);
 const graph=getNativeGitExternalGraph(config(planned.external),{gitDir:common,worktreePath:base});
 assert.equal(graph.files[0].path,path.join(base,'.husky','pre-commit'));
 assert.equal(graph.links.length,1,'absent push-context hooks stay absent while normal hooks use a view');
 assert.equal(graph.absentPaths.length,2);
 assert.equal(getNativeGitGeneratedHookViews(config(planned.external),{gitDir:common,worktreePath:base}).length,1);
});

test('a captured dangling hook symlink targets explicit owned negative evidence',()=>{
 const planned=plan(value(family({directories:[folder('/hooks')],links:[{sourcePath:'/hooks/dead',targetSourcePath:'/hooks/missing',kind:'symlink'}],absentPaths:['/hooks/missing'],bindings:[binding('hooks','/hooks','/hooks')]})));
 const graph=getNativeGitExternalGraph(config(planned.external),{gitDir:common,worktreePath:base});
 assert.equal(graph.links.length,1);assert.equal(graph.links[0].target,graph.absentPaths[0].path);
 const forged=config({...planned.external,absentPaths:[]});
 assert.throws(()=>getNativeGitExternalGraph(forged,{gitDir:common,worktreePath:base}),/outside its complete declared/);
 assert.throws(()=>getNativeGitExternalGraph(config({...planned.external,links:[{...planned.external.links[0],kind:'hardlink'}]}),{gitDir:common,worktreePath:base}),/regular original/);
});

test('source parent aliases qualify provenance without creating invented destination nodes',()=>{
 const planned=plan(value(family({files:[file('/private/tmp/settings','[portable]\nvalue=yes\n')],links:[{sourcePath:'/tmp',targetSourcePath:'/private/tmp',kind:'symlink'}],bindings:[binding('include','/tmp/settings','/private/tmp/settings')]})));
 const graph=getNativeGitExternalGraph(config(planned.external),{gitDir:common,worktreePath:base});
 assert.equal(graph.links.length,0);assert.equal(graph.files.length,1);
 assert.equal(planned.project(context,'/old/.git/config','include.path','/tmp/settings').destination,graph.files[0].path);
});

test('cross-scope source aliases use an explicit top-worktree reference',()=>{
 const data=value(family({files:[file('/old/module/.hooks/script')],directories:[folder('/old/.hooks'),folder('/old/module/.hooks')],links:[{sourcePath:'/old/.hooks/run',targetSourcePath:'/old/module/.hooks/script',kind:'symlink'}]}));
 data.git.modules=[{name:'module',source:{storagePath:'/old/.git/modules/module',worktreePath:'/old/module',initialized:true},worktreeRelativePath:'module',git:{configurationSourceDirectories:{common:'/old/.git/modules/module',private:'/old/.git/modules/module'},modules:[]},originals:[]}];
 const planned=plan(data,new Map([[path.join(base,'module','.hooks','script'),Buffer.from('script')]])),child=planned.scopes[1];
 const cfg={...config(planned.external),modules:[{gitDir:child.gitDir,worktreePath:child.worktreePath,configuration:config(child.external)}]};
 const graph=getNativeGitExternalGraph(cfg,{gitDir:common,worktreePath:base});
 assert.equal(planned.external.links[0].targetContext,'ownerWorktree');
 assert.equal(graph.links[0].target,path.join(base,'module','.hooks','script'));
});

test('bare capsule placement is explicit and raw config originals cannot replace generated native config',()=>{
 const bareGit={configurationSourceDirectories:{common:'/hooks/cache',private:'/hooks/cache'},modules:[]};
 const data=value(family({directories:[folder('/hooks'),folder('/hooks/cache')],files:[file('/hooks/cache/config','[core]\nbare=true\n')],repositories:[{sourcePath:'/hooks/cache',bare:true,git:bareGit,originals:[]}],bindings:[binding('hooks','/hooks','/hooks')]}));
 const planned=plan(data),capsule=planned.repositories[0];
 assert.equal(capsule.bare,true);assert.equal(capsule.initialized,false);assert.equal(capsule.gitDir,capsule.worktreePath);
 const original=planned.originals.entries().next().value;assert.notEqual(original[0],path.join(capsule.gitDir,'config'));
});

test('omission never becomes absence and human mappings stay inside selected destinations',()=>{
 assert.throws(()=>plan(value(family({omittedPaths:['/secret/config']}))),/omitted, not observed absent/);
 assert.throws(()=>planReviewedGitExternalApplication(value(family()),{git:true,harness:false,gitPathMappings:[{source:'/secret',destination:path.resolve('/outside')}]},context,[base],new Map()),/selected fresh import roots/);
});

test('selected dependency root metadata is separate from directory payload ownership',()=>{
 const planned=plan(value(family({directories:[folder('/old')],files:[file('/old/script')],bindings:[binding('hooks','.','/old','worktree','/old')]})));
 planned.project(context,'/old/.git/config','core.hooksPath','.');
 assert.equal(planned.external.rootMetadata.context,'worktree');
 assert.equal(planned.external.files[0].path,'script');
 const graph=getNativeGitExternalGraph(config(planned.external),{gitDir:common,worktreePath:base});
 assert.equal(graph.rootMetadata[0].path,base);assert.equal(graph.directories.length,0);assert.equal(graph.links[0].target,base);
});

test('a selected module task retains the locally compiled top graph authority',()=>{
 const child=config({directories:[],files:[],links:[{path:'hooks/run',target:'helper',targetContext:'ownerWorktree',kind:'symlink'}]});
 const parent={...config({directories:[],files:[{path:'helper',context:'worktree',data:Buffer.from('script'),...metadata}],links:[]}),modules:[{gitDir:path.join(common,'modules','child'),worktreePath:path.join(base,'child'),configuration:child}]};
 const childContext={gitDir:path.join(common,'modules','child'),worktreePath:path.join(base,'child')};
 assert.throws(()=>getNativeGitExternalGraph(child,childContext),/outside its complete declared/);
 bindNativeGitExternalGraphOwner(child,parent,{gitDir:common,worktreePath:base});
 assert.equal(getNativeGitExternalGraph(child,childContext).links[0].target,path.join(base,'helper'));
});
