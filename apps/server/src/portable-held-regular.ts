import {constants,closeSync,adoptPortableFileDescriptor,promises as fs} from '@ponderosa/native-host/fs';
import {pinPortableRegularFile} from '@ponderosa/native-host';

/** Linux pins type+inode before any data open. Non-Linux ordinary behavior is
 * retained, but its pathname replacement boundary is not qualification evidence. */
export async function openPortableRegular(pathname:string,access:'read'|'metadata'='read'):Promise<Awaited<ReturnType<typeof fs.open>>>{
  const expected=await fs.lstat(pathname,{bigint:true});
  if(!expected.isFile())throw new Error('Selected portable original is not a regular file; no content endpoint opened');
  if(process.platform!=='linux')return fs.open(pathname,constants.O_RDONLY|constants.O_NOFOLLOW);
  const pin=pinPortableRegularFile({path:pathname,expectedDevice:expected.dev,expectedInode:expected.ino});
  let pinOwned=true,handle:Awaited<ReturnType<typeof fs.open>>|undefined,primary:unknown;
  try{
    if(access==='metadata'){
      const owned=adoptPortableFileDescriptor(pin.fd);pinOwned=false;return owned;
    }
    // This is the qualified descriptor magic path of an already proved regular
    // inode, never the mutable selected pathname. The pin remains held throughout.
    handle=await fs.open(pin.readPath,constants.O_RDONLY);
    const actual=await handle.stat({bigint:true});
    if(!actual.isFile()||actual.dev!==expected.dev||actual.ino!==expected.ino)throw new Error('Held portable regular read identity differs');
    pinOwned=false;closeSync(pin.fd);
    const result=handle;handle=undefined;return result;
  }catch(error){primary=error;throw error;}
  finally{
    const cleanup:unknown[]=[];
    if(handle)try{await handle.close();}catch(error){cleanup.push(error);}
    if(pinOwned)try{pinOwned=false;closeSync(pin.fd);}catch(error){cleanup.push(error);}
    if(cleanup.length)throw Object.assign(new Error('Portable regular pin cleanup failed; preserve all source/destination bytes',{cause:primary??cleanup[0]}),{code:(primary as {code?:string}|undefined)?.code??'ERR_PORTABLE_REGULAR_PIN_CLEANUP',partialStatePossible:false,cleanupErrors:cleanup});
  }
}
