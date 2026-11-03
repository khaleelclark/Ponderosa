import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,lstat,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DataDirectoryAuthority,allocatedHeldFileBytes,availableHeldDirectoryBytes,availablePortableStorageBytes} from '@ponderosa/native-host';

test('available bytes use the exact held data root and survive a path replacement',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'native-capacity-')),root=path.join(parent,'root'),moved=path.join(parent,'moved');
 const {mkdir}=await import('node:fs/promises');await mkdir(root);const authority=new DataDirectoryAuthority(root);
 let handle;
 try{
  if(process.platform==='win32'){
   await writeFile(path.join(root,'ordinary'),'bytes');const file=await open(path.join(root,'ordinary'),'r');try{assert.ok(allocatedHeldFileBytes(file.fd)>=0n);}finally{await file.close();}
   const before=availablePortableStorageBytes(authority.rootPath);assert.equal(typeof before,'bigint');assert.ok(before>=0n);
   assert.throws(()=>availablePortableStorageBytes(authority.rootPath+'/not-the-root'));
   const released=authority.rootPath;authority.close();assert.throws(()=>availablePortableStorageBytes(released),/authority/i);
  }else{
   handle=await open(root,'r');const stat=await handle.stat({bigint:true}),input={fd:handle.fd,expectedDevice:stat.dev,expectedInode:stat.ino};
   const before=availableHeldDirectoryBytes(input);assert.equal(typeof before,'bigint');assert.ok(before>=0n);
   assert.throws(()=>availableHeldDirectoryBytes({...input,expectedInode:stat.ino+1n}),/identity/i);
   await writeFile(path.join(root,'ordinary'),'bytes');const file=await open(path.join(root,'ordinary'),'r');
   try{const actual=await file.stat({bigint:true});const allocated=allocatedHeldFileBytes(file.fd);assert.equal(typeof allocated,'bigint');assert.equal(allocated,actual.blocks*512n);assert.throws(()=>availableHeldDirectoryBytes({fd:file.fd,expectedDevice:actual.dev,expectedInode:actual.ino}),/identity/i);}finally{await file.close();}
   if(process.platform==='darwin'){
    const registered=availablePortableStorageBytes(authority.rootPath);assert.equal(typeof registered,'bigint');assert.ok(registered>=0n);
    assert.throws(()=>availablePortableStorageBytes(authority.rootPath+'/not-the-root'));
   }
   await rename(root,moved);await mkdir(root);
   assert.ok(availableHeldDirectoryBytes(input)>=0n,'The observation remains attached to the original held directory');
   if(process.platform==='darwin')assert.ok(availablePortableStorageBytes(authority.rootPath)>=0n);
   await handle.close();handle=undefined;assert.throws(()=>availableHeldDirectoryBytes(input),/identity/i);
   const released=authority.rootPath;authority.close();if(process.platform==='darwin')assert.throws(()=>availablePortableStorageBytes(released),/authority/i);
   await lstat(path.join(moved,'ordinary'));
  }
 }finally{await handle?.close();authority.close();await rm(parent,{recursive:true,force:true});}
});
