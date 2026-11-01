import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {portableWorkingPath,exportWorkingFiles,importWorkingFiles,validateWorkingFileData} from '../../apps/server/dist/portable-working-files.js';

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
