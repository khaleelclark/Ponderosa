import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,symlink,rm,mkdir,rename,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {portableWorkingPath,exportWorkingFiles,importWorkingFiles,validateWorkingFileData,workingDirectoryIdentity,assertWorkingRootIdentity} from '../../apps/server/dist/portable-working-files.js';

test('selected originals refuse path escapes and known credential fields without mutating files',async()=>{
  for(const name of ['../other','/tmp/other','a/../b','.env','.git/config','auth.json'])assert.throws(()=>portableWorkingPath(name));
  assert.throws(()=>validateWorkingFileData('config.json',Buffer.from('{"apiKey":"secret"}')));
  const root=await mkdtemp(path.join(tmpdir(),'portable-selected-files-'));
  try{
    await writeFile(path.join(root,'safe.txt'),'original');await symlink('safe.txt',path.join(root,'link'));
    await assert.rejects(exportWorkingFiles(root,['link'],1024),/symlink/);
    const exported=await exportWorkingFiles(root,['safe.txt'],1024);assert.equal(exported.bytes,8);
    const body=Buffer.from(exported.artifacts[0].dataBase64,'base64');
    const destination=path.join(root,'new');
    await importWorkingFiles(destination,[{path:'safe.txt',data:body,sha256:createHash('sha256').update(body).digest('hex')}]);
    await assert.rejects(importWorkingFiles(destination,[]));
    assert.equal(await readFile(path.join(destination,'safe.txt'),'utf8'),'original');
    assert.equal(await readFile(path.join(root,'safe.txt'),'utf8'),'original');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('whole-folder selection retains empty directories, regular-file modes and source bytes',async()=>{
  const {mkdir,chmod,stat}=await import('node:fs/promises');
  const {inventoryWorkingFolder}=await import('../../apps/server/dist/portable-working-files.js');
  const root=await mkdtemp(path.join(tmpdir(),'portable-whole-folder-'));
  try{
    await mkdir(path.join(root,'empty'));await mkdir(path.join(root,'.git'));
    await writeFile(path.join(root,'.git','config'),'native ownership excluded');
    await writeFile(path.join(root,'run.sh'),'echo safe');await chmod(path.join(root,'run.sh'),0o750);
    const inventory=await inventoryWorkingFolder(root);
    assert.deepEqual(inventory.paths,['run.sh']);assert.deepEqual(inventory.excludedPaths,['.git']);
    const exported=await exportWorkingFiles(root,inventory.paths,1024);
    const files=exported.files.map(file=>{const data=Buffer.from(exported.artifacts.find(a=>a.ref===file.artifactRef).dataBase64,'base64');return {...file,data,sha256:createHash('sha256').update(data).digest('hex')};});
    const destination=path.join(root,'destination');await importWorkingFiles(destination,files,inventory.directories);
    assert.equal((await stat(path.join(destination,'empty'))).isDirectory(),true);
    if(process.platform!=='win32')assert.equal((await stat(path.join(destination,'run.sh'))).mode&0o777,0o750);
    assert.equal(await readFile(path.join(root,'run.sh'),'utf8'),'echo safe');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('fresh locally owned population preserves displaced baseline bytes with recovery paths',async()=>{
  const {readdir,mkdir}=await import('node:fs/promises');
  const root=await mkdtemp(path.join(tmpdir(),'portable-fresh-owned-'));
  try{
    await mkdir(path.join(root,'dir'));
    await writeFile(path.join(root,'dir','same.txt'),'destination baseline');
    const data=Buffer.from('source original');
    const backupRoot=path.join(root,'.ponderosa-import-backups');
    await importWorkingFiles(root,[{path:'dir/same.txt',data,sha256:createHash('sha256').update(data).digest('hex')}],[{path:'dir',mode:0o700,mtime:new Date().toISOString()}],undefined,{backupRoot});
    assert.equal(await readFile(path.join(root,'dir','same.txt'),'utf8'),'source original');
    const names=await readdir(backupRoot),mapping=names.find(name=>name.endsWith('.path.json'));
    assert.deepEqual(JSON.parse(await readFile(path.join(backupRoot,mapping),'utf8')),{path:'dir/same.txt'});
    assert.equal(await readFile(path.join(backupRoot,mapping.replace('.path.json','')),'utf8'),'destination baseline');
    assert.throws(()=>portableWorkingPath('.ponderosa-import-backups/original'));
  }finally{await rm(root,{recursive:true,force:true});}
});

// Deferred source only: no native/filesystem fixture was executed for this change.
test('whole-root topology recreates in-root aliases without copying secret/native owners',async()=>{
  const {link,lstat,readlink,mkdir}=await import('node:fs/promises');
  const {inventoryWorkingFolder}=await import('../../apps/server/dist/portable-working-files.js');
  const root=await mkdtemp(path.join(tmpdir(),'portable-topology-'));
  try{
    await mkdir(path.join(root,'dir'));
    await writeFile(path.join(root,'original.txt'),'one inode');
    await link(path.join(root,'original.txt'),path.join(root,'alias.txt'));
    await symlink('../original.txt',path.join(root,'dir','relative'));
    await symlink('missing.txt',path.join(root,'dangling'));
    const inventory=await inventoryWorkingFolder(root);
    assert.equal(inventory.links.filter(link=>link.kind==='hardlink').length,1);
    assert.equal(inventory.links.filter(link=>link.kind==='symlink').length,2);
    const exported=await exportWorkingFiles(root,inventory.paths,1024,inventory.links);
    assert.equal(exported.bytes,9);
    const files=exported.files.map(file=>{const data=Buffer.from(exported.artifacts.find(a=>a.ref===file.artifactRef).dataBase64,'base64');return {...file,data,sha256:createHash('sha256').update(data).digest('hex')};});
    const destination=path.join(root,'new');
    await importWorkingFiles(destination,files,inventory.directories,undefined,undefined,inventory.links);
    assert.equal((await lstat(path.join(destination,'original.txt'))).ino,(await lstat(path.join(destination,'alias.txt'))).ino);
    assert.equal(await readlink(path.join(destination,'dir','relative')),'../original.txt');
    assert.equal(await readlink(path.join(destination,'dangling')),'missing.txt');
    assert.equal(await readFile(path.join(destination,'dir','relative'),'utf8'),'one inode');
    assert.equal(await readFile(path.join(root,'original.txt'),'utf8'),'one inode');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('topology refuses missing originals, escaping chains, native targets and parent links before creation',async()=>{
  const {validateWorkingTopology}=await import('../../apps/server/dist/portable-working-files.js');
  for(const links of [
    [{path:'link',kind:'symlink',target:'../outside'}],
    [{path:'link',kind:'symlink',target:'.git/config'}],
    [{path:'link',kind:'hardlink',target:'missing'}],
    [{path:'dir/up',kind:'symlink',target:'..'},{path:'link',kind:'symlink',target:'dir/up/../outside'}],
    [{path:'link',kind:'symlink',target:'other'},{path:'link/child',kind:'symlink',target:'safe'}],
  ])assert.throws(()=>validateWorkingTopology([],[],links));
  const root=await mkdtemp(path.join(tmpdir(),'portable-outside-alias-'));
  try{
    const {link,mkdir}=await import('node:fs/promises');
    await mkdir(path.join(root,'selected'));
    await writeFile(path.join(root,'selected','original'),'retained');
    await link(path.join(root,'selected','original'),path.join(root,'outside'));
    const {inventoryWorkingFolder}=await import('../../apps/server/dist/portable-working-files.js');
    await assert.rejects(inventoryWorkingFolder(path.join(root,'selected')),/aliases outside/);
    assert.equal(await readFile(path.join(root,'outside'),'utf8'),'retained');
  }finally{await rm(root,{recursive:true,force:true});}
});


test('incompressible selected originals refuse the wire budget whole and leave source files exact',{timeout:120000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'portable-wire-bound-'));
 try{
  const original=randomBytes(64*1024*1024),paths=Array.from({length:25},(_,i)=>`original-${i}.bin`);
  for(const name of paths)await writeFile(path.join(root,name),original);
  await assert.rejects(exportWorkingFiles(root,paths,2048*1024*1024),error=>error.statusCode===413&&/serialized package byte limit.*no originals were omitted/.test(error.message));
  for(const name of paths)assert.equal(createHash('sha256').update(await readFile(path.join(root,name))).digest('hex'),createHash('sha256').update(original).digest('hex'));
 }finally{await rm(root,{recursive:true,force:true});}
});


test('byte-phase directory custody spans implicit module parents and refuses later observations',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-directory-custody-'));
  try{
    const destination=path.join(root,'new'),data=Buffer.from('module worktree original');
    const identity=await importWorkingFiles(destination,[{path:'modules/child/source.txt',data,sha256:createHash('sha256').update(data).digest('hex')}],[{path:'explicit',mode:0o700,mtime:new Date(0).toISOString()}],undefined,undefined,[],'refuse',undefined,true,undefined,true);
    for(const relative of ['modules','modules/child','explicit']){
      const proof=workingDirectoryIdentity(destination,identity,path.join(destination,relative)),actual=await lstat(path.join(destination,relative),{bigint:true});
      assert.deepEqual(proof,{device:actual.dev.toString(),inode:actual.ino.toString()});
      await assertWorkingRootIdentity(path.join(destination,relative),proof);
    }
    const original=workingDirectoryIdentity(destination,identity,path.join(destination,'modules/child'));
    await rename(path.join(destination,'modules/child'),path.join(destination,'modules/retained-child'));
    await mkdir(path.join(destination,'modules/child'));
    assert.deepEqual(workingDirectoryIdentity(destination,identity,path.join(destination,'modules/child')),original,'The lookup retains byte-phase authority rather than adopting a replacement');
    await assert.rejects(assertWorkingRootIdentity(path.join(destination,'modules/child'),original),/identity changed/);
    assert.equal(await readFile(path.join(destination,'modules/retained-child/source.txt'),'utf8'),'module worktree original');
    await mkdir(path.join(destination,'late'));
    assert.throws(()=>workingDirectoryIdentity(destination,identity,path.join(destination,'late')),/no original byte-phase custody/);
    assert.throws(()=>workingDirectoryIdentity(destination,identity,path.join(root,'outside')),/outside its original root/);
  }finally{await rm(root,{recursive:true,force:true});}
});
