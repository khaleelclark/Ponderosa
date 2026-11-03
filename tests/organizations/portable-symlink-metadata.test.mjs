import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,symlink,lstat,readFile,readlink,rename,link,rm} from 'node:fs/promises';
import {constants,closeSync,fstatSync,readSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {applyExactSymlinkMetadata,pinPortableSymlink,pinPortableRegularFile} from '@ponderosa/native-host';

const linux={skip:process.platform!=='linux'};
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'exact-symlink-metadata-')),target=path.join(root,'target'),selected=path.join(root,'selected');
 await writeFile(target,'target bytes remain exact');await symlink('target',selected);
 const parent=await open(root,constants.O_RDONLY|constants.O_DIRECTORY),parentIdentity=await parent.stat({bigint:true}),named=await lstat(selected,{bigint:true});
 const pinInput={parentFd:parent.fd,leaf:'selected',expectedParentDevice:parentIdentity.dev,expectedParentInode:parentIdentity.ino,expectedDevice:named.dev,expectedInode:named.ino},pin=pinPortableSymlink(pinInput),fd=pin.fd;
 assert.equal(pin.device,named.dev);assert.equal(pin.inode,named.ino);assert.equal((await lstat(selected,{bigint:true})).atimeNs,named.atimeNs,'Online pin does not read link bytes or alter atime');
 t.after(async()=>{closeSync(fd);await parent.close();await rm(root,{recursive:true,force:true});});
 const identity=fstatSync(fd,{bigint:true});
 return {root,target,selected,parent,pinInput,fd,identity,input:{fd,expectedDevice:identity.dev,expectedInode:identity.ino,mtimeNs:'1700000000123456789'}};
}

test('held symlink timestamp retains exact submicrosecond and signed nanoseconds without target mutation',linux,async t=>{
 const f=await fixture(t),targetBefore=await lstat(f.target,{bigint:true}),before=fstatSync(f.fd,{bigint:true});
 assert.throws(()=>readSync(f.fd,Buffer.alloc(1),0,1,0),error=>error.code==='EBADF','O_PATH never becomes a data endpoint');
 for(const mtimeNs of ['1700000000123456789','-123456789','0']){
  const result=applyExactSymlinkMetadata({...f.input,mtimeNs}),after=fstatSync(f.fd,{bigint:true});
  assert.equal(result.kind,'symlink');assert.equal(result.device,before.dev);assert.equal(result.inode,before.ino);assert.equal(result.linkCount,1n);
  assert.equal(result.mtimeNs,BigInt(mtimeNs));assert.equal(after.mtimeNs,BigInt(mtimeNs));assert.equal(after.uid,before.uid);assert.equal(after.gid,before.gid);assert.equal(after.mode,before.mode);assert.equal(after.atimeNs,before.atimeNs);
 }
 const targetAfter=await lstat(f.target,{bigint:true});
 for(const field of ['dev','ino','uid','gid','mode','size','mtimeNs','ctimeNs','atimeNs'])assert.equal(targetAfter[field],targetBefore[field],field);
 assert.equal(await readFile(f.target,'utf8'),'target bytes remain exact');assert.equal(await readlink(f.selected),'target');
});

test('stale identities and wrong descriptor kinds refuse before changing either node',linux,async t=>{
 const f=await fixture(t),before=await lstat(f.selected,{bigint:true}),target=await lstat(f.target,{bigint:true});
 assert.throws(()=>applyExactSymlinkMetadata({...f.input,expectedInode:before.ino+1n}),error=>error.code==='ERR_EXACT_SYMLINK_METADATA_PREFLIGHT');
 assert.throws(()=>applyExactSymlinkMetadata({...f.input,expectedDevice:before.dev+1n}),error=>error.code==='ERR_EXACT_SYMLINK_METADATA_PREFLIGHT');
 const regular=pinPortableRegularFile({path:f.target,expectedDevice:target.dev,expectedInode:target.ino});
 try{assert.throws(()=>applyExactSymlinkMetadata({...f.input,fd:regular.fd,expectedDevice:target.dev,expectedInode:target.ino}),error=>error.code==='ERR_EXACT_SYMLINK_METADATA_PREFLIGHT');}finally{closeSync(regular.fd);}
 assert.equal((await lstat(f.selected,{bigint:true})).mtimeNs,before.mtimeNs);assert.equal((await lstat(f.target,{bigint:true})).mtimeNs,target.mtimeNs);
});

test('a retained descriptor changes its original symlink inode after name replacement, never the replacement or target',linux,async t=>{
 const f=await fixture(t),retained=path.join(f.root,'retained-original');
 await rename(f.selected,retained);await symlink('target',f.selected);
 const replacement=await lstat(f.selected,{bigint:true}),target=await lstat(f.target,{bigint:true});
 applyExactSymlinkMetadata(f.input);
 assert.equal((await lstat(retained,{bigint:true})).mtimeNs,BigInt(f.input.mtimeNs));
 assert.equal((await lstat(f.selected,{bigint:true})).mtimeNs,replacement.mtimeNs);assert.equal((await lstat(f.target,{bigint:true})).mtimeNs,target.mtimeNs);
 assert.equal(await readlink(retained),'target');assert.equal(await readlink(f.selected),'target');
});

test('online symlink pins refuse stale parent/name/child proofs without changing either node',linux,async t=>{
 const f=await fixture(t),before=await lstat(f.selected,{bigint:true});
 for(const changed of [{expectedParentInode:f.pinInput.expectedParentInode+1n},{expectedInode:before.ino+1n},{leaf:'.'},{leaf:'..'},{leaf:'nested/selected'},{leaf:'target'}]){
  assert.throws(()=>pinPortableSymlink({...f.pinInput,...changed}),error=>error.code==='ERR_PORTABLE_SYMLINK_PIN');
 }
 assert.equal(fstatSync(f.parent.fd,{bigint:true}).ino,f.pinInput.expectedParentInode,'Borrowed parent remains open after failed pins');
 assert.equal((await lstat(f.selected,{bigint:true})).atimeNs,before.atimeNs);assert.equal((await lstat(f.selected,{bigint:true})).mtimeNs,before.mtimeNs);
});

test('multiple symlink names and out-of-range or lossy timestamps refuse',linux,async t=>{
 const f=await fixture(t),before=await lstat(f.selected,{bigint:true});
 for(const mtimeNs of ['1.5','-0','01','1e9','9'.repeat(40)])assert.throws(()=>applyExactSymlinkMetadata({...f.input,mtimeNs}),error=>error.code==='ERR_EXACT_SYMLINK_METADATA_INPUT');
 assert.throws(()=>applyExactSymlinkMetadata({...f.input,mtimeNs:'999999999999999999999999999999999999999'}),error=>error.code==='ERR_EXACT_SYMLINK_METADATA_PREFLIGHT');
 await link(f.selected,path.join(f.root,'second-name'));assert.equal((await lstat(f.selected,{bigint:true})).nlink,2n);
 assert.throws(()=>pinPortableSymlink(f.pinInput),error=>error.code==='ERR_PORTABLE_SYMLINK_PIN');
 assert.throws(()=>applyExactSymlinkMetadata(f.input),error=>error.code==='ERR_EXACT_SYMLINK_METADATA_PREFLIGHT');
 assert.equal((await lstat(f.selected,{bigint:true})).mtimeNs,before.mtimeNs);
});

test('other platforms explicitly refuse exact held symlink timestamp mutation',{skip:process.platform==='linux'},()=>{
 assert.throws(()=>applyExactSymlinkMetadata({fd:0,expectedDevice:0n,expectedInode:0n,mtimeNs:'1'}),error=>error.code==='ERR_EXACT_SYMLINK_METADATA_UNSUPPORTED');
 assert.throws(()=>pinPortableSymlink({parentFd:0,leaf:'selected',expectedParentDevice:0n,expectedParentInode:0n,expectedDevice:0n,expectedInode:0n}),error=>error.code==='ERR_PORTABLE_SYMLINK_PIN_UNSUPPORTED');
});
