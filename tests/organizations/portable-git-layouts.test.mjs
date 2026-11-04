import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,open,rm,realpath,rename,link,lstat,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {deflateSync} from 'node:zlib';
import path from 'node:path';
import {
  createGitExportCapture,verifyGitExportAssociations,exportReviewedGit,exportReviewedUserData,
  validatePortableGitStorageBindings,validateReviewedGit,recreateReviewedGit,parseReviewedUserData,
} from '../../apps/server/dist/portable-reviewed-user-data.js';

const native=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','protocol.file.allow=always','-C',cwd,...args],
  {encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_TERMINAL_PROMPT:'0'}}).trim();
async function repository(root,refFormat='files'){
  await mkdir(root);
  native(root,'init','--initial-branch=main','--ref-format='+refFormat);
  native(root,'config','user.name','Fixture User');native(root,'config','user.email','fixture@example.invalid');
  await writeFile(path.join(root,'file.txt'),'original\n');
  native(root,'add','file.txt');native(root,'commit','-m','original');
  return native(root,'rev-parse','HEAD');
}
async function fixture(t){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'ponderosa-git-layouts-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}
async function heldCapture(roots,bindings){
  const handles=[];
  for(const [ref,pathname] of Object.entries(roots)){
    const handle=await open(pathname,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    handles.push({ref,pathname,handle,owner:(await handle.stat({bigint:true})).uid});
  }
  const capture=createGitExportCapture(handles,bindings);
  return {capture,async close(){await capture.close();await Promise.all(handles.map(root=>root.handle.close()));}};
}

test('linked reftable captures selected private HEAD/refs independently of common main-worktree state',async t=>{
  const root=await fixture(t),common=path.join(root,'main'),selected=path.join(root,'selected');
  const mainOid=await repository(common,'reftable');
  native(common,'worktree','add','-b','selected',selected);
  await writeFile(path.join(selected,'file.txt'),'selected\n');native(selected,'add','file.txt');native(selected,'commit','-m','selected');
  const selectedOid=native(selected,'rev-parse','HEAD');
  native(common,'update-ref','refs/worktree/main-private',mainOid);
  native(selected,'update-ref','refs/worktree/selected-private',selectedOid);
  const result=await exportReviewedGit(selected);
  assert.ok(result.git.reftableReview.selectedWorktree);
  assert.deepEqual(result.git.head,{symbolic:'refs/heads/selected'});
  assert.ok(result.git.refs.some(ref=>ref.name==='refs/worktree/selected-private'&&ref.oid===selectedOid));
  assert.ok(!result.git.refs.some(ref=>ref.name==='refs/worktree/main-private'));
  validateReviewedGit(result.git);
  const changed=structuredClone(result.git);
  const original=Buffer.from(changed.reftableReview.selectedWorktree.tables[0].dataBase64,'base64');original[0]^=1;
  changed.reftableReview.selectedWorktree.tables[0].dataBase64=original.toString('base64');
  assert.throws(()=>validateReviewedGit(changed),/reftable/i);
  const review=path.join(root,'review');await recreateReviewedGit(review,result.git);
  assert.equal(native(review,'rev-parse','HEAD'),selectedOid);
  assert.equal(native(review,'rev-parse','refs/worktree/selected-private'),selectedOid);
  assert.equal(native(common,'rev-parse','HEAD'),mainOid,'Read-only capture leaves main HEAD intact');
});

test('mapped linked reftable carries the exact common/private proof pair',async t=>{
  const root=await fixture(t),common=path.join(root,'main'),selected=path.join(root,'selected');
  await repository(common,'reftable');native(common,'worktree','add','-b','selected',selected);
  const privatePath=native(selected,'rev-parse','--absolute-git-dir');
  const bindings=[
    {id:'common',worktreeRootRef:'selected',storageRootRef:'main',relativePath:'.git',role:'common',worktreePath:selected,storagePath:common},
    {id:'private',worktreeRootRef:'selected',storageRootRef:'main',relativePath:path.relative(common,privatePath).split(path.sep).join('/'),role:'private',worktreePath:selected,storagePath:common},
  ];
  const held=await heldCapture({main:common,selected},bindings);
  try{
    await verifyGitExportAssociations(held.capture);
    const review=await exportReviewedUserData(selected,{git:true,harness:false},held.capture);
    const wire=Buffer.from(JSON.stringify(review));parseReviewedUserData(wire);held.capture.bindReview(selected,wire);
    const portable=held.capture.portableBindings();
    validatePortableGitStorageBindings(portable,new Set(['main','selected']));
    assert.equal(portable.length,2);assert.ok(review.git.reftableReview.selectedWorktree);
    assert.ok(portable.every(binding=>binding.capture.reviewSha256));
  }finally{await held.close();}
});

test('Include Git captures contained initialized and deinitialized module repositories through shared Git families',async t=>{
  const root=await fixture(t),source=path.join(root,'module-source'),parent=path.join(root,'parent');
  const moduleOid=await repository(source);await repository(parent);
  native(parent,'submodule','add',source,'libs/child');native(parent,'commit','-m','module');
  const live=await exportReviewedGit(parent);
  assert.equal(live.git.modules.length,1);
  const child=live.git.modules[0];
  assert.equal(child.name,'libs/child');assert.equal(child.worktreeRelativePath,'libs/child');assert.equal(child.source.initialized,true);
  assert.ok(child.git.objects.some(object=>object.oid===moduleOid));
  assert.equal(child.source.worktreePath,path.join(parent,'libs/child'));
  validateReviewedGit(live.git);
  const review=path.join(root,'review');await recreateReviewedGit(review,live.git);
  assert.equal(native(path.join(review,'MODULES-REVIEW/libs/child'),'rev-parse','HEAD'),moduleOid);
  const metadata=JSON.parse(await readFile(path.join(review,'CONFIGURATION-REVIEW.json'),'utf8'));
  assert.equal(metadata.modules[0].source.initialized,true);
  native(parent,'submodule','deinit','-f','libs/child');
  const dormant=await exportReviewedGit(parent),inactive=dormant.git.modules[0];
  assert.equal(inactive.source.initialized,false);assert.equal(inactive.source.coreWorktree,null);
  assert.equal(inactive.source.dormantAssociation.gitmodulesOid,dormant.git.index.find(entry=>entry.path==='.gitmodules').oid);
  assert.equal(inactive.source.dormantAssociation.gitlinkOid,dormant.git.index.find(entry=>entry.path==='libs/child').oid);
  assert.deepEqual(inactive.git.objects,child.git.objects);validateReviewedGit(dormant.git);
  for(const mutate of [
   value=>value.modules[0].source.dormantAssociation.gitmodulesOid='0'.repeat(40),
   value=>value.modules[0].source.dormantAssociation.gitlinkOid='0'.repeat(40),
   value=>value.modules[0].source.worktreePath=path.join(root,'foreign'),
   value=>value.modules[0].worktreeRelativePath='foreign',
   value=>value.modules[0].source.initialized=true,
   value=>value.modules[0].git.configurationOriginalReview[0].removedFields=true,
  ]){const changed=structuredClone(dormant.git);mutate(changed);assert.throws(()=>validateReviewedGit(changed),/dormant|module|configuration|gitlink/i);}
  const declared=await readFile(path.join(parent,'.gitmodules'));
  await writeFile(path.join(parent,'.gitmodules'),Buffer.concat([declared,Buffer.from('\n# uncommitted change\n')]));
  await assert.rejects(exportReviewedGit(parent),/unchanged indexed/);
  await writeFile(path.join(parent,'.gitmodules'),declared);
  await writeFile(path.join(parent,'libs/child','.git'),'gitdir: ../../.git/modules/libs/child\n');
  await assert.rejects(exportReviewedGit(parent),/unexpectedly|pointer/);
  await rm(path.join(parent,'libs/child','.git'));
  const forged=structuredClone(live.git);forged.modules[0].source.worktreePath=path.join(root,'foreign');
  assert.throws(()=>validateReviewedGit(forged),/association/);
});

test('dormant module name and contained path are bound through the indexed declaration',async t=>{
  const root=await fixture(t),source=path.join(root,'named-source'),parent=path.join(root,'named-parent');
  const moduleOid=await repository(source);await repository(parent);
  native(parent,'submodule','add','--name','custom/name',source,'content/child');native(parent,'commit','-m','named module');
  native(parent,'submodule','deinit','-f','content/child');
  const dormant=await exportReviewedGit(parent),module=dormant.git.modules[0];
  assert.equal(module.name,'custom/name');assert.equal(module.worktreeRelativePath,'content/child');
  assert.equal(module.source.coreWorktree,null);assert.equal(module.source.dormantAssociation.gitlinkOid,moduleOid);
  validateReviewedGit(dormant.git);
  const tampered=structuredClone(dormant.git);tampered.modules[0].name='content/child';
  assert.throws(()=>validateReviewedGit(tampered),/declaration|mapping/i);
});

test('explicit module binding proves its .git pointer and core.worktree against nested selected roots',async t=>{
  const root=await fixture(t),source=path.join(root,'module-source'),parent=path.join(root,'parent');
  await repository(source);await repository(parent);
  native(parent,'submodule','add',source,'libs/child');
  const child=path.join(parent,'libs/child');
  const gitdir=native(child,'rev-parse','--absolute-git-dir');
  const binding={id:'child-module',worktreeRootRef:'child',storageRootRef:'parent',
    relativePath:path.relative(parent,gitdir).split(path.sep).join('/'),role:'module',worktreePath:child,storagePath:parent};
  const held=await heldCapture({parent,child},[binding]);
  try{
    await verifyGitExportAssociations(held.capture);
    const review=await exportReviewedUserData(child,{git:true,harness:false},held.capture);
    const wire=Buffer.from(JSON.stringify(review));parseReviewedUserData(wire);held.capture.bindReview(child,wire);
    const bindings=held.capture.portableBindings();
    validatePortableGitStorageBindings(bindings,new Set(['parent','child']));
    assert.equal(bindings.length,1);
    const proof=bindings[0].capture.records.find(record=>record.moduleWorktree);
    assert.ok(proof);assert.equal(typeof proof.moduleWorktree.sha256,'string');
    const forged=structuredClone(bindings);forged[0].capture.records.find(record=>record.moduleWorktree).moduleWorktree.value='/foreign';
    assert.throws(()=>validatePortableGitStorageBindings(forged,new Set(['parent','child'])),/module.*differ/i);
  }finally{await held.close();}
});


test('old-form embedded modules and inspected empty module inventories retain complete local Git data',async t=>{
  const root=await fixture(t),source=path.join(root,'module-source'),parent=path.join(root,'parent');
  const oid=await repository(source);await repository(parent);
  const empty=await exportReviewedGit(parent);assert.deepEqual(empty.git.modules,[]);
  native(parent,'clone',source,'embedded');
  native(parent,'-c','advice.addEmbeddedRepo=false','add','embedded');native(parent,'commit','-m','embedded gitlink');
  const result=await exportReviewedGit(parent);
  assert.equal(result.git.modules.length,1);
  const module=result.git.modules[0];
  assert.equal(module.name,'embedded');assert.equal(module.source.embedded,true);
  assert.equal(module.source.initialized,true);assert.equal(module.source.coreWorktree,'..');
  assert.equal(module.source.storagePath,path.join(parent,'embedded/.git'));
  assert.ok(module.git.objects.some(object=>object.oid===oid));
  assert.deepEqual(module.git.modules,[]);
  validateReviewedGit(result.git);
});

test('automatic inactive review import preserves separate raw stacks and cross-worktree ref-prefix conflicts',async t=>{
  const {createHash}=await import('node:crypto');
  const {importWorkingFiles}=await import('../../apps/server/dist/portable-working-files.js');
  const {REVIEWED_USER_DATA_PATH}=await import('../../apps/server/dist/portable-reviewed-user-data.js');
  const root=await fixture(t),common=path.join(root,'main'),selected=path.join(root,'selected');
  const mainOid=await repository(common,'reftable');
  native(common,'worktree','add','-b','selected',selected);
  await writeFile(path.join(selected,'file.txt'),'selected worktree\n');
  native(selected,'add','file.txt');native(selected,'commit','-m','selected worktree');
  const selectedOid=native(selected,'rev-parse','HEAD');
  // Both names are valid in their own native worktree backend. Flattening them
  // into one loose-ref namespace is neither necessary nor faithful.
  native(common,'update-ref','refs/worktree/topic',mainOid);
  native(selected,'update-ref','refs/worktree/topic/nested',selectedOid);
  const expectedRefs=native(selected,'for-each-ref','--format=%(refname)%00%(objectname)');
  const expectedLog=native(selected,'reflog','show','HEAD','--format=%H%x00%gs');
  const reviewData=await exportReviewedUserData(selected,{git:true,harness:false});
  const wire=Buffer.from(JSON.stringify(reviewData));
  const destination=path.join(root,'imported');
  await importWorkingFiles(destination,[{path:REVIEWED_USER_DATA_PATH,data:wire,sha256:createHash('sha256').update(wire).digest('hex')}]);
  const review=path.join(destination,'.ponderosa-portable-review','git-repository');
  const commonDir=path.join(review,'.ponderosa-review-git'),privateDir=path.join(commonDir,'worktrees','selected');
  assert.match(await readFile(path.join(review,'.git'),'utf8'),/^gitdir: \.ponderosa-review-git\/worktrees\/selected\n$/);
  assert.equal(native(review,'rev-parse','HEAD'),selectedOid);
  assert.equal(native(review,'for-each-ref','--format=%(refname)%00%(objectname)'),expectedRefs);
  assert.equal(native(review,'reflog','show','HEAD','--format=%H%x00%gs'),expectedLog);
  assert.equal(native(review,'rev-parse','refs/worktree/topic/nested'),selectedOid);
  for(const [stack,directory] of [[reviewData.git.reftableReview,commonDir],[reviewData.git.reftableReview.selectedWorktree,privateDir]]){
    assert.equal((await readFile(path.join(directory,'reftable','tables.list'))).toString('base64'),stack.tablesListBase64);
    for(const table of stack.tables)assert.equal((await readFile(path.join(directory,'reftable',table.name))).toString('base64'),table.dataBase64);
  }
  const config=await readFile(path.join(commonDir,'config'),'utf8');
  assert.match(config,/hooksPath = \/dev\/null/);assert.match(config,/fsmonitor = false/);
  assert.doesNotMatch(config,/remote|include|credential/);
  assert.equal(native(common,'rev-parse','HEAD'),mainOid);
  assert.equal(native(selected,'rev-parse','HEAD'),selectedOid);
  assert.deepEqual(await readFile(path.join(destination,REVIEWED_USER_DATA_PATH)),wire);
});


test('nested exact common storage retains one physical root and the reciprocal linked association',async t=>{
  const root=await fixture(t),main=path.join(root,'main'),selected=path.join(root,'selected');
  const oid=await repository(main);native(main,'worktree','add','-b','selected',selected);
  const storage=path.join(main,'.git'),privatePath=native(selected,'rev-parse','--absolute-git-dir');
  const bindings=[
    {id:'common',worktreeRootRef:'selected',storageRootRef:'storage',relativePath:'.',role:'common',worktreePath:selected,storagePath:storage},
    {id:'private',worktreeRootRef:'selected',storageRootRef:'storage',relativePath:path.relative(storage,privatePath).split(path.sep).join('/'),role:'private',worktreePath:selected,storagePath:storage},
  ];
  const held=await heldCapture({main,storage,selected},bindings);
  try{
    await verifyGitExportAssociations(held.capture);
    const review=await exportReviewedUserData(selected,{git:true,harness:false},held.capture);
    assert.ok(review.git.objects.some(object=>object.oid===oid));
    await held.capture.verify();
  }finally{await held.close();}
});

test('nested supporting files stay selected without granting native repository traversal',async t=>{
  const root=await fixture(t),main=path.join(root,'main'),selected=path.join(root,'selected');
  await repository(main);native(main,'worktree','add','-b','selected',selected);
  const support=path.join(main,'support');await mkdir(support);await writeFile(path.join(support,'external.cfg'),'[core]\n');
  const unrelated=path.join(main,'unrelated');await repository(unrelated);
  const privatePath=native(selected,'rev-parse','--absolute-git-dir');
  const bindings=[
    {id:'common',worktreeRootRef:'selected',storageRootRef:'main',relativePath:'.git',role:'common',worktreePath:selected,storagePath:main},
    {id:'private',worktreeRootRef:'selected',storageRootRef:'main',relativePath:path.relative(main,privatePath).split(path.sep).join('/'),role:'private',worktreePath:selected,storagePath:main},
  ];
  const held=await heldCapture({main,support,unrelated,selected},bindings);
  try{
    await verifyGitExportAssociations(held.capture);
    assert.equal(await held.capture.usesGit(support),false);
    await assert.rejects(held.capture.usesGit(unrelated),/nested.*module or storage binding/i);
    await assert.rejects(held.capture.io.readdir(support),/nested.*module or storage binding/i);
    await assert.rejects(held.capture.io.open(path.join(support,'external.cfg'),constants.O_RDONLY),/nested.*module or storage binding/i);
    await held.capture.verify();
  }finally{await held.close();}
});

test('an enclosing nested storage root is not an exact native storage boundary',async t=>{
  const root=await fixture(t),parent=path.join(root,'parent'),box=path.join(parent,'box'),main=path.join(box,'main'),selected=path.join(root,'selected');
  await mkdir(box,{recursive:true});await repository(main);native(main,'worktree','add','-b','selected',selected);
  const privatePath=native(selected,'rev-parse','--absolute-git-dir');
  const bindings=[
    {id:'common',worktreeRootRef:'selected',storageRootRef:'box',relativePath:'main/.git',role:'common',worktreePath:selected,storagePath:box},
    {id:'private',worktreeRootRef:'selected',storageRootRef:'box',relativePath:path.relative(box,privatePath).split(path.sep).join('/'),role:'private',worktreePath:selected,storagePath:box},
  ];
  const held=await heldCapture({parent,box,selected},bindings);
  try{await assert.rejects(verifyGitExportAssociations(held.capture),/nested.*module or storage binding/i);}
  finally{await held.close();}
});

test('nested source custody rejects a descriptor for a different canonical child before reading content',async t=>{
  const root=await fixture(t),parent=path.join(root,'parent'),child=path.join(parent,'child'),foreign=path.join(root,'foreign');
  await mkdir(child,{recursive:true});await mkdir(foreign);
  const parentHandle=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const foreignHandle=await open(foreign,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const owner=(await parentHandle.stat({bigint:true})).uid;
  const capture=createGitExportCapture([
    {ref:'parent',pathname:parent,handle:parentHandle,owner},
    {ref:'child',pathname:child,handle:foreignHandle,owner},
  ],[{id:'module',worktreeRootRef:'child',storageRootRef:'parent',relativePath:'storage',role:'module',worktreePath:child,storagePath:parent}]);
  try{await assert.rejects(capture.io.readdir(child),/descriptor.*canonical source path/i);}
  finally{await capture.close();await Promise.all([parentHandle.close(),foreignHandle.close()]);}
});

test('nested selected child replacement invalidates retained parent membership instead of reopening it',async t=>{
  const root=await fixture(t),source=path.join(root,'module-source'),parent=path.join(root,'parent');
  await repository(source);await repository(parent);native(parent,'submodule','add',source,'libs/child');
  const child=path.join(parent,'libs/child'),storage=native(child,'rev-parse','--absolute-git-dir');
  const binding={id:'module',worktreeRootRef:'child',storageRootRef:'parent',relativePath:path.relative(parent,storage).split(path.sep).join('/'),role:'module',worktreePath:child,storagePath:parent};
  const held=await heldCapture({parent,child},[binding]);
  try{
    await verifyGitExportAssociations(held.capture);
    await rename(child,path.join(parent,'libs/old-child'));await mkdir(child);
    await assert.rejects(held.capture.verify(),/held Git directory changed|directory entry no longer identifies/i);
  }finally{await held.close();}
});


test('configured external module worktree read requires opt-in and an exact held reciprocal pointer',async t=>{
  const root=await fixture(t),moduleSource=path.join(root,'module-source'),parent=path.join(root,'parent'),external=path.join(root,'external-child');
  const oid=await repository(moduleSource);await repository(parent);native(parent,'submodule','add',moduleSource,'child');native(parent,'commit','-m','child');
  const original=path.join(parent,'child'),storage=native(original,'rev-parse','--absolute-git-dir');
  await rename(original,external);
  native(parent,'config','--file',path.join(storage,'config'),'core.worktree',path.relative(storage,external));
  await writeFile(path.join(external,'.git'),'gitdir: '+path.relative(external,storage).split(path.sep).join('/')+'\n');
  await assert.rejects(exportReviewedGit(parent),/outside the selected closure/);
  const captured=await exportReviewedGit(parent,undefined,true),module=captured.git.modules[0];
  assert.equal(module.source.worktreePath,external);assert.equal(module.worktreeRelativePath,null);assert.equal(module.source.initialized,true);
  assert.ok(module.git.objects.some(object=>object.oid===oid));
  validateReviewedGit(captured.git);
  await writeFile(path.join(external,'.git'),'gitdir: '+path.join(moduleSource,'.git')+'\n');
  await assert.rejects(exportReviewedGit(parent,undefined,true),/does not identify its captured module storage/);
  await rm(path.join(external,'.git'));
  const deinitialized=await exportReviewedGit(parent,undefined,true);
  assert.equal(deinitialized.git.modules[0].source.initialized,false);
  assert.deepEqual(deinitialized.git.modules[0].git.objects,module.git.objects);
});

test('held export reads content-verified hardlinked loose objects without altering other names',{skip:process.platform!=='linux'},async t=>{
  const root=await fixture(t),repo=path.join(root,'repo'),foreign=path.join(root,'foreign-original');
  const oid=await repository(repo),object=path.join(repo,'.git','objects',oid.slice(0,2),oid.slice(2));
  await link(object,foreign);
  const original=await readFile(foreign),before=await lstat(foreign,{bigint:true});
  const storage=path.join(repo,'.git');
  const held=await heldCapture({work:repo,storage},[{id:'common',worktreeRootRef:'work',storageRootRef:'storage',relativePath:'.',role:'common',worktreePath:repo,storagePath:storage}]);
  try{
    const exported=await exportReviewedUserData(repo,{git:true,harness:false},held.capture);
    assert.ok(exported.git.objects.some(item=>item.oid===oid));
    const after=await lstat(foreign,{bigint:true});
    assert.deepEqual(await readFile(foreign),original);
    assert.equal(after.ino,before.ino);assert.equal(after.nlink,before.nlink);assert.equal(after.mtimeNs,before.mtimeNs);
  }finally{await held.close();}
  // A valid zlib stream with incorrect object identity is refused, without
  // deleting or repairing either source name.
  const forged=deflateSync(Buffer.from('blob 4\0fake'));await chmod(object,0o600);await writeFile(object,forged);
  await assert.rejects(exportReviewedGit(repo),/loose Git object identity mismatch/i);
  assert.deepEqual(await readFile(foreign),forged);assert.equal((await lstat(foreign)).nlink,2);
});

test('held Git export verifies read-only hardlinked pack and index pairs',{skip:process.platform!=='linux',timeout:30000},async t=>{
  const root=await fixture(t),repo=path.join(root,'repo'),oid=await repository(repo);
  native(repo,'repack','-a','-d');
  const dir=path.join(repo,'.git','objects','pack'),names=await readdir(dir);
  const packName=names.find(name=>/^pack-[a-f0-9]+\.pack$/.test(name));
  assert.ok(packName);
  const stem=packName.slice(0,-5),pack=path.join(dir,packName),index=path.join(dir,stem+'.idx');
  const packAlias=path.join(root,'foreign.pack'),indexAlias=path.join(root,'foreign.idx');
  await link(pack,packAlias);await link(index,indexAlias);
  const originalPack=await readFile(packAlias),originalIndex=await readFile(indexAlias);
  const before=await Promise.all([packAlias,indexAlias].map(name=>lstat(name,{bigint:true})));
  const storage=path.join(repo,'.git');
  const held=await heldCapture({work:repo,storage},[{id:'common',worktreeRootRef:'work',storageRootRef:'storage',relativePath:'.',role:'common',worktreePath:repo,storagePath:storage}]);
  try{
    const exported=await exportReviewedUserData(repo,{git:true,harness:false},held.capture);
    assert.ok(exported.git.objects.some(item=>item.oid===oid));
    validateReviewedGit(exported.git);
    const copy=path.join(root,'recreated');
    await recreateReviewedGit(copy,exported.git);
    assert.equal(native(copy,'rev-parse','HEAD'),oid);
    assert.deepEqual(await readFile(packAlias),originalPack);assert.deepEqual(await readFile(indexAlias),originalIndex);
    const after=await Promise.all([packAlias,indexAlias].map(name=>lstat(name,{bigint:true})));
    for(let i=0;i<before.length;i++){
      assert.equal(after[i].ino,before[i].ino);assert.equal(after[i].nlink,before[i].nlink);
      assert.equal(after[i].mtimeNs,before[i].mtimeNs);assert.equal(after[i].mode,before[i].mode);
    }
  }finally{await held.close();}
  // Corruption in the synthetic fixture must be rejected, preserving both
  // names; linked retention/control files are outside this read-only grant.
  const bad=Buffer.from(originalPack);bad[12]^=1;await chmod(pack,0o600);await writeFile(pack,bad);
  await assert.rejects(exportReviewedGit(repo));
  assert.deepEqual(await readFile(packAlias),bad);assert.equal((await lstat(packAlias)).nlink,2);
  await writeFile(pack,originalPack);
  const keep=path.join(dir,stem+'.keep'),keepAlias=path.join(root,'foreign.keep');
  await writeFile(keep,'keep\n');await link(keep,keepAlias);
  await assert.rejects(exportReviewedGit(repo),/bounded regular original|singly linked regular/i);
  assert.deepEqual(await readFile(keepAlias),Buffer.from('keep\n'));assert.equal((await lstat(keepAlias)).nlink,2);
});

test('held Git export supports either single hardlinked pack half',{skip:process.platform!=='linux',timeout:30000},async t=>{
  const root=await fixture(t);
  for(const extension of ['pack','idx']){
    const repo=path.join(root,'repo-'+extension),oid=await repository(repo);native(repo,'repack','-a','-d');
    const dir=path.join(repo,'.git','objects','pack'),name=(await readdir(dir)).find(item=>new RegExp('^pack-[a-f0-9]+\\.'+extension+'$').test(item));
    assert.ok(name);
    const original=path.join(dir,name),alias=path.join(root,'foreign-'+extension);
    await link(original,alias);
    const bytes=await readFile(alias),before=await lstat(alias,{bigint:true}),storage=path.join(repo,'.git');
    const held=await heldCapture({work:repo,storage},[{id:'common',worktreeRootRef:'work',storageRootRef:'storage',relativePath:'.',role:'common',worktreePath:repo,storagePath:storage}]);
    try{
      const result=await exportReviewedGit(repo,held.capture);
      assert.ok(result.git.objects.some(item=>item.oid===oid));validateReviewedGit(result.git);
      const after=await lstat(alias,{bigint:true});
      assert.deepEqual(await readFile(alias),bytes);
      assert.equal(after.ino,before.ino);assert.equal(after.nlink,before.nlink);assert.equal(after.mtimeNs,before.mtimeNs);
    }finally{await held.close();}
  }
});

test('held Git export rejects a malformed linked pack index without modifying aliases',{skip:process.platform!=='linux',timeout:30000},async t=>{
  const root=await fixture(t),repo=path.join(root,'repo');await repository(repo);native(repo,'repack','-a','-d');
  const dir=path.join(repo,'.git','objects','pack'),name=(await readdir(dir)).find(item=>/^pack-[a-f0-9]+\.idx$/.test(item));
  assert.ok(name);
  const index=path.join(dir,name),alias=path.join(root,'foreign.idx');
  await link(index,alias);
  const bad=Buffer.from(await readFile(index));bad[8]^=1;await chmod(index,0o600);await writeFile(index,bad);
  const before=await lstat(alias,{bigint:true}),storage=path.join(repo,'.git');
  const held=await heldCapture({work:repo,storage},[{id:'common',worktreeRootRef:'work',storageRootRef:'storage',relativePath:'.',role:'common',worktreePath:repo,storagePath:storage}]);
  try{
    await assert.rejects(exportReviewedGit(repo,held.capture));
    const after=await lstat(alias,{bigint:true});
    assert.deepEqual(await readFile(alias),bad);
    assert.equal(after.ino,before.ino);assert.equal(after.nlink,before.nlink);assert.equal(after.mtimeNs,before.mtimeNs);
  }finally{await held.close();}
});

test('held Git export detects an aliased pack change at final custody verification',{skip:process.platform!=='linux',timeout:30000},async t=>{
  const root=await fixture(t),repo=path.join(root,'repo');await repository(repo);native(repo,'repack','-a','-d');
  const dir=path.join(repo,'.git','objects','pack'),name=(await readdir(dir)).find(item=>/^pack-[a-f0-9]+\.pack$/.test(item));
  assert.ok(name);
  const pack=path.join(dir,name),alias=path.join(root,'foreign.pack');
  await link(pack,alias);
  const initial=await readFile(alias),changed=Buffer.from(initial);changed[12]^=1;
  await chmod(alias,0o600);
  const storage=path.join(repo,'.git');
  const held=await heldCapture({work:repo,storage},[{id:'common',worktreeRootRef:'work',storageRootRef:'storage',relativePath:'.',role:'common',worktreePath:repo,storagePath:storage}]);
  const verify=held.capture.verify.bind(held.capture);
  let injected=false;
  held.capture.verify=async()=>{
    // Model a separate writer after both source inventories have been read,
    // immediately before the retained-descriptor custody check.
    injected=true;await writeFile(alias,changed);await verify();
  };
  try{
    await assert.rejects(exportReviewedGit(repo,held.capture),/changed|custody/i);
    assert.equal(injected,true);assert.deepEqual(await readFile(alias),changed);assert.equal((await lstat(alias)).nlink,2);
  }finally{await held.close();}
});

test('Git export bounds aggregate loose-object inflation and refuses hardlinked control files',{skip:process.platform==='win32',timeout:30000},async t=>{
  const root=await fixture(t),repo=path.join(root,'repo');await repository(repo);
  for(const [index,byte] of [[1,65],[2,66]]){
    const file=path.join(root,'large-'+index);await writeFile(file,Buffer.alloc(17*1024*1024,byte));native(repo,'hash-object','-w','--',file);
  }
  await assert.rejects(exportReviewedGit(repo),/inflated aggregate bound|aggregate bound exceeded/i);
  const control=path.join(repo,'.git','config'),alias=path.join(root,'control-alias'),original=await readFile(control);
  await link(control,alias);
  await assert.rejects(exportReviewedGit(repo),/bounded regular original|singly linked regular/i);
  assert.deepEqual(await readFile(alias),original);assert.equal((await lstat(alias)).nlink,2);
});
