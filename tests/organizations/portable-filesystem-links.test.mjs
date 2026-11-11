import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,symlink,readlink,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inventoryWorkingFolder,exportWorkingFiles,importWorkingFiles,importWorkingLinks,finalizeWorkingFolderMetadata,workingLinkCounts,orderWorkingRoots,validateMappedWorkingLinks} from '../../apps/server/dist/portable-working-files.js';

const imported=exported=>exported.files.map(file=>{const data=Buffer.from(exported.artifacts.find(artifact=>artifact.ref===file.artifactRef).dataBase64,'base64');return {...file,data,sha256:createHash('sha256').update(data).digest('hex')};});
test('absolute in-root symbolic targets relocate while source spelling remains evidence',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-absolute-links-'));
  try{
    const source=path.join(root,'source'),destination=path.join(root,'destination');await mkdir(source);
    await writeFile(path.join(source,'original'),'source bytes');await symlink(path.join(source,'original'),path.join(source,'alias'));
    const inventory=await inventoryWorkingFolder(source);
    assert.equal(inventory.links[0].sourceTarget,path.join(source,'original'));assert.equal(inventory.links[0].target,'original');
    const exported=await exportWorkingFiles(source,inventory.paths,1024,inventory.links);
    await importWorkingFiles(destination,imported(exported),inventory.directories,undefined,undefined,inventory.links,'passive_in_root');
    assert.equal(await readFile(path.join(destination,'alias'),'utf8'),'source bytes');
    assert.equal(await readlink(path.join(source,'alias')),path.join(source,'original'));
    assert.equal(await readlink(path.join(destination,'alias')),'original');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('cross-root symbolic links require included roots and explicit final destinations',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-mapped-links-'));
  try{
    const first=path.join(root,'first'),second=path.join(root,'second'),destFirst=path.join(root,'new-first'),destSecond=path.join(root,'new-second');
    await mkdir(first);await mkdir(second);await writeFile(path.join(second,'answer'),'retained');
    await symlink('../second/answer',path.join(first,'answer'));
    const roots=new Map([[first,'first'],[second,'second']]),inventory=await inventoryWorkingFolder(first,undefined,undefined,roots);
    assert.equal(inventory.links[0].targetRootRef,'second');assert.equal(inventory.links[0].target,'answer');
    const graph=[{ref:'first',links:inventory.links,cyclicLinks:'passive_in_root'},{ref:'second',links:[],cyclicLinks:'passive_in_root'}];
    validateMappedWorkingLinks(graph);
    assert.throws(()=>validateMappedWorkingLinks(graph.slice(0,1)),/root closure/);
    await assert.rejects(importWorkingFiles(destFirst,[],[],undefined,undefined,inventory.links,'passive_in_root'),/explicit final-root/);
    await importWorkingFiles(destFirst,[],[],undefined,undefined,inventory.links,'passive_in_root',undefined,false,{first:destFirst,second:destSecond});
    await mkdir(destSecond);await writeFile(path.join(destSecond,'answer'),'retained');
    assert.equal(await readFile(path.join(destFirst,'answer'),'utf8'),'retained');
    assert.equal(await readlink(path.join(first,'answer')),'../second/answer');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('mapped graph validation catches a path that escapes after following another root',()=>{
  const roots=[{ref:'a',cyclicLinks:'passive_in_root',links:[{path:'remote',kind:'symlink',target:'.',targetRootRef:'b',sourceTarget:'/source/b'},{path:'escape',kind:'symlink',target:'remote/..'}]},{ref:'b',cyclicLinks:'passive_in_root',links:[]}];
  assert.throws(()=>validateMappedWorkingLinks(roots),/leaves all selected roots/);
});

test('all selected hardlink aliases choose earliest root originals and recreate one inode across roots',async()=>{
  const {link,stat}=await import('node:fs/promises');
  const {createWorkingHardlinkCapture,verifyWorkingHardlinkCapture,orderWorkingRoots}=await import('../../apps/server/dist/portable-working-files.js');
  const root=await mkdtemp(path.join(tmpdir(),'portable-cross-hardlinks-'));
  try{
    const first=path.join(root,'first'),second=path.join(root,'second'),destFirst=path.join(root,'new-first'),destSecond=path.join(root,'new-second');
    await mkdir(first);await mkdir(second);
    await writeFile(path.join(first,'a'),'first inode');await link(path.join(first,'a'),path.join(second,'alias-a'));
    await writeFile(path.join(second,'b'),'second inode');await link(path.join(second,'b'),path.join(first,'alias-b'));
    const roots=new Map([[first,'first'],[second,'second']]),capture=createWorkingHardlinkCapture();
    const firstInventory=await inventoryWorkingFolder(first,undefined,undefined,roots,capture),secondInventory=await inventoryWorkingFolder(second,undefined,undefined,roots,capture);
    await verifyWorkingHardlinkCapture(capture);
    assert.deepEqual(firstInventory.paths,['a','alias-b']);assert.deepEqual(secondInventory.paths,[]);
    assert.equal(secondInventory.links.every(link=>link.kind==='hardlink'&&link.targetRootRef==='first'),true);
    const firstExport=await exportWorkingFiles(first,firstInventory.paths,1024,firstInventory.links,undefined,undefined,undefined,roots,firstInventory);
    const secondExport=await exportWorkingFiles(second,secondInventory.paths,1024,secondInventory.links,undefined,undefined,undefined,roots,secondInventory);
    const order=orderWorkingRoots([{ref:'second',links:secondInventory.links,inventory:secondInventory,exported:secondExport,destination:destSecond},{ref:'first',links:firstInventory.links,inventory:firstInventory,exported:firstExport,destination:destFirst}]);
    assert.deepEqual(new Set(order.map(item=>item.ref)),new Set(['first','second']));
    for(const item of order)await importWorkingFiles(item.destination,imported(item.exported),item.inventory.directories,undefined,undefined,item.links,'passive_in_root',undefined,true,{first:destFirst,second:destSecond},true);
    for(const item of order)await importWorkingLinks(item.destination,item.links,{first:destFirst,second:destSecond});
    for(const item of order)await finalizeWorkingFolderMetadata(item.destination,imported(item.exported),item.inventory.directories,undefined,item.links,undefined,workingLinkCounts(item.ref,order));
    assert.equal((await stat(path.join(destFirst,'a'))).ino,(await stat(path.join(destSecond,'alias-a'))).ino);
    assert.equal((await stat(path.join(destFirst,'alias-b'))).ino,(await stat(path.join(destSecond,'b'))).ino);
    assert.equal(await readFile(path.join(destSecond,'b'),'utf8'),'second inode');
    await verifyWorkingHardlinkCapture(capture);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('two-phase restore preserves valid cyclic root dependencies and retained baseline files',async()=>{
 const {stat,readdir}=await import('node:fs/promises');
 const root=await mkdtemp(path.join(tmpdir(),'portable-cyclic-root-links-'));
 try{
  const destinations={a:path.join(root,'a'),b:path.join(root,'b')};
  const roots=[
   {ref:'a',links:[{kind:'hardlink',path:'from-b',target:'b-original',targetRootRef:'b'}],file:{path:'a-original',data:Buffer.from('a retained')}},
   {ref:'b',links:[{kind:'hardlink',path:'from-a',target:'a-original',targetRootRef:'a'}],file:{path:'b-original',data:Buffer.from('b retained')}},
  ];
  const ordered=orderWorkingRoots(roots),files=Object.fromEntries(roots.map(item=>[item.ref,[{...item.file,sha256:createHash('sha256').update(item.file.data).digest('hex')}]]));
  for(const item of ordered)await importWorkingFiles(destinations[item.ref],files[item.ref],[],undefined,undefined,item.links,'passive_in_root',undefined,true,destinations,true);
  for(const item of ordered)await importWorkingLinks(destinations[item.ref],item.links,destinations);
  for(const item of ordered)await finalizeWorkingFolderMetadata(destinations[item.ref],files[item.ref],[],undefined,item.links,undefined,workingLinkCounts(item.ref,roots));
  assert.equal((await stat(path.join(destinations.a,'from-b'))).ino,(await stat(path.join(destinations.b,'b-original'))).ino);
  assert.equal((await stat(path.join(destinations.b,'from-a'))).ino,(await stat(path.join(destinations.a,'a-original'))).ino);
  const fresh=path.join(root,'fresh'),backupRoot=path.join(fresh,'.ponderosa-import-backups');
  await mkdir(fresh);await mkdir(backupRoot);await writeFile(path.join(fresh,'alias'),'baseline retained');
  await importWorkingLinks(fresh,[{kind:'symlink',path:'alias',target:'missing'}],undefined,{backupRoot});
  assert.equal(await readlink(path.join(fresh,'alias')),'missing');
  const backups=(await readdir(backupRoot)).filter(name=>!name.endsWith('.path.json'));
  assert.equal(backups.length,1);assert.equal(await readFile(path.join(backupRoot,backups[0]),'utf8'),'baseline retained');
 }finally{await rm(root,{recursive:true,force:true});}
});


test('deferred links and final metadata reject a substituted root before any mutation',async()=>{
 const {rename,readdir,lstat}=await import('node:fs/promises');
 const root=await mkdtemp(path.join(tmpdir(),'portable-deferred-root-custody-'));
 try{
  const destination=path.join(root,'destination'),retained=path.join(root,'retained-original');
  const links=[{kind:'symlink',path:'parent/alias',target:'missing'}];
  const identity=await importWorkingFiles(destination,[],[],undefined,undefined,links,'refuse',undefined,true,undefined,true);
  const original=await lstat(destination,{bigint:true});
  assert.deepEqual(identity,{device:original.dev.toString(),inode:original.ino.toString(),directories:{}});
  await rename(destination,retained);await mkdir(destination);await writeFile(path.join(destination,'sentinel'),'replacement bytes');
  const replacement=await lstat(destination,{bigint:true});
  await assert.rejects(importWorkingLinks(destination,links,undefined,undefined,identity),error=>error.code==='ERR_WORKING_ROOT_IDENTITY');
  assert.deepEqual(await readdir(destination),['sentinel'],'A rejected deferred phase must not even create link parents');
  await assert.rejects(finalizeWorkingFolderMetadata(destination,[],[],{mode:0o700,mtime:'2000-01-01T00:00:00.000Z'},links,undefined,undefined,identity),error=>error.code==='ERR_WORKING_ROOT_IDENTITY');
  const after=await lstat(destination,{bigint:true});
  assert.equal(after.mode,replacement.mode);assert.equal(after.mtimeNs,replacement.mtimeNs);
  assert.equal(await readFile(path.join(destination,'sentinel'),'utf8'),'replacement bytes');
  assert.deepEqual(await readdir(retained),[],'Original issued root remains preserved');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('fresh-root population retains its prior allocation identity before creating backups',async()=>{
 const {rename,readdir,lstat}=await import('node:fs/promises');
 const root=await mkdtemp(path.join(tmpdir(),'portable-fresh-root-custody-'));
 try{
  const destination=path.join(root,'destination'),retained=path.join(root,'retained-original');await mkdir(destination);
  const original=await lstat(destination,{bigint:true}),identity={device:original.dev.toString(),inode:original.ino.toString()};
  await rename(destination,retained);await mkdir(destination);
  const data=Buffer.from('imported bytes');
  await assert.rejects(importWorkingFiles(destination,[{path:'new.txt',data,sha256:createHash('sha256').update(data).digest('hex')}],[],undefined,{backupRoot:path.join(destination,'.ponderosa-import-backups'),identity}),error=>error.code==='ERR_WORKING_ROOT_IDENTITY');
  assert.deepEqual(await readdir(destination),[],'No backup or imported file may be created in a substituted root');
  assert.deepEqual(await readdir(retained),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
