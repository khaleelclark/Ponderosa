import {constants,openSync,closeSync,readSync,writeSync,fsyncSync,renameSync,unlinkSync,fstatSync,promises as fs} from '@ponderosa/native-host/fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentPackageJsonParser,AGENT_PACKAGE_MAX_BYTES,agentPackageJsonPieces,agentPackageJsonUtf8Bytes} from '@ponderosa/core';
import {fsyncDirectory} from './store-filesystem.js';

export function readPortableHistoryJson<T>(pathname:string):T {
 const fd=openSync(pathname,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const before=fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.size>BigInt(AGENT_PACKAGE_MAX_BYTES))throw new Error('Imported history exceeds the package byte limit');
  const parser=new AgentPackageJsonParser(),decoder=new TextDecoder('utf-8',{fatal:true}),buffer=Buffer.alloc(256*1024);
  let count:number;while((count=readSync(fd,buffer,0,buffer.length,null))>0)parser.write(decoder.decode(buffer.subarray(0,count),{stream:true}));
  parser.write(decoder.decode());const after=fstatSync(fd,{bigint:true});
  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Imported history changed during read');
  return parser.end() as T;
 }finally{closeSync(fd);}
}
function* batches(value:unknown):Generator<string>{
 let parts:string[]=[],bytes=0;
 for(const part of agentPackageJsonPieces(value)){
  parts.push(part);bytes+=Buffer.byteLength(part);
  if(bytes>=256*1024||parts.length>=1024){yield parts.join('');parts=[];bytes=0;}
 }
 if(parts.length)yield parts.join('');
}
export function writePortableHistoryJson(pathname:string,value:unknown):void{
 agentPackageJsonUtf8Bytes(value);
 const temporary=join(dirname(pathname),`.${randomUUID()}.json.tmp`),fd=openSync(temporary,'wx',0o600);
 try{for(const part of batches(value)){const data=Buffer.from(part);let offset=0;while(offset<data.length)offset+=writeSync(fd,data,offset,data.length-offset);}fsyncSync(fd);}
 catch(error){closeSync(fd);try{unlinkSync(temporary);}catch{}throw error;}
 closeSync(fd);try{renameSync(temporary,pathname);fsyncDirectory(dirname(pathname));}catch(error){try{unlinkSync(temporary);}catch{}throw error;}
}
export async function writePortableHistoryJsonAsync(pathname:string,value:unknown):Promise<void>{
 agentPackageJsonUtf8Bytes(value);
 const directory=dirname(pathname);await fs.mkdir(directory,{recursive:true});
 const temporary=join(directory,`.${randomUUID()}.json.tmp`),handle=await fs.open(temporary,'wx',0o600);
 try{for(const part of batches(value))await handle.writeFile(part);await handle.sync();await handle.close();await fs.rename(temporary,pathname);fsyncDirectory(directory);}
 catch(error){await handle.close().catch(()=>undefined);await fs.unlink(temporary).catch(()=>undefined);throw error;}
}


/** Same canonical parser as the synchronous accessor, with bounded asynchronous disk reads. */
export async function readPortableHistoryJsonAsync<T>(pathname:string):Promise<T>{
 const handle=await fs.open(pathname,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const before=await handle.stat({bigint:true});if(!before.isFile()||before.size>BigInt(AGENT_PACKAGE_MAX_BYTES))throw new Error('Imported history exceeds the package byte limit');
  const parser=new AgentPackageJsonParser(),decoder=new TextDecoder('utf-8',{fatal:true}),buffer=Buffer.alloc(256*1024);
  for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;parser.write(decoder.decode(buffer.subarray(0,bytesRead),{stream:true}));}
  parser.write(decoder.decode());const after=await handle.stat({bigint:true});
  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Imported history changed during read');
  return parser.end() as T;
 }finally{await handle.close();}
}
