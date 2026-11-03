import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,open,rm,realpath,rename} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
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
  const dormant=await exportReviewedGit(parent);
  assert.equal(dormant.git.modules[0].source.initialized,false);
  assert.deepEqual(dormant.git.modules[0].git.objects,child.git.objects);
  const forged=structuredClone(live.git);forged.modules[0].source.worktreePath=path.join(root,'foreign');
  assert.throws(()=>validateReviewedGit(forged),/association/);
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
