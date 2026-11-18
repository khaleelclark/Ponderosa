import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rename,readFile,lstat,open,rm} from 'node:fs/promises';
import {constants,readSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createPersistentNode,applyExactFileMetadata} from '@ponderosa/native-host';
import {openPortableRegular} from '../../apps/server/dist/portable-held-regular.js';

async function fifo(parentPath,leaf){
  const parent=await open(parentPath,constants.O_RDONLY|constants.O_DIRECTORY);
  try{const stat=await parent.stat({bigint:true});return createPersistentNode({parentFd:parent.fd,expectedParentDevice:stat.dev,expectedParentInode:stat.ino,leaf,kind:'fifo',mode:0o600,mtimeNs:1234567890000000000n});}
  finally{await parent.close();}
}
test('Linux stale regular observation refuses a replacement FIFO without blocking on a content open',{skip:process.platform!=='linux'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-regular-gate-')),selected=path.join(root,'selected');
  try{
    await writeFile(selected,'retained original');const expected=await lstat(selected,{bigint:true});
    await rename(selected,path.join(root,'original'));await fifo(root,'selected');
    const module=new URL('../../packages/native-host/dist/index.js',import.meta.url).href;
    const script='import {pinPortableRegularFile} from '+JSON.stringify(module)+';try{const pin=pinPortableRegularFile({path:'+JSON.stringify(selected)+',expectedDevice:BigInt('+JSON.stringify(String(expected.dev))+'),expectedInode:BigInt('+JSON.stringify(String(expected.ino))+')});console.error("unexpected pin",pin);process.exitCode=2;}catch(error){if(error.code!=="ERR_PORTABLE_REGULAR_PIN")throw error;process.stdout.write("refused");}';
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:5000});
    assert.equal(child.error,undefined,'A stale regular observation must not block opening a replacement FIFO');
    assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'refused');
    assert.equal(await readFile(path.join(root,'original'),'utf8'),'retained original');
    assert.equal((await lstat(selected)).isFIFO(),true);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('Linux held regular read and metadata pins stay on their exact inode after pathname replacement',{skip:process.platform!=='linux'},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'portable-held-inode-')),selected=path.join(root,'selected');
  let handle,metadata;
  try{
    await writeFile(selected,'pinned bytes');const original=await lstat(selected,{bigint:true});
    handle=await openPortableRegular(selected);
    metadata=await openPortableRegular(selected,'metadata');
    assert.throws(()=>readSync(metadata.fd,Buffer.alloc(1),0,1,0),error=>error.code==='EBADF','Metadata-only pins never become data endpoints');
    await rename(selected,path.join(root,'original'));const replacement=await fifo(root,'selected');
    assert.equal(await handle.readFile('utf8'),'pinned bytes');
    const held=await metadata.stat({bigint:true});
    assert.equal(held.ino,original.ino);
    applyExactFileMetadata({fd:metadata.fd,expectedDevice:held.dev,expectedInode:held.ino,kind:'file',mode:0o640,mtimeNs:1234567890000000000n});
    assert.equal((await lstat(path.join(root,'original'))).mode&0o777,0o640);
    assert.equal((await lstat(selected,{bigint:true})).ino,replacement.inode);
    assert.equal((await lstat(selected)).mode&0o777,0o600);
  }finally{
    await handle?.close();await metadata?.close();await rm(root,{recursive:true,force:true});
  }
});
