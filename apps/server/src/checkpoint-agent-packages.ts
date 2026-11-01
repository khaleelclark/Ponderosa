import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {promises as fs} from '@ponderosa/native-host/fs';
import {AGENT_PACKAGE_MAX_BYTES,type AgentPortablePackageDto} from '@ponderosa/core';
import {parsePortablePackageFile,portablePackageJsonChunks} from './agent-package-codec.js';
import {validatePortableAgentPackage} from './portable-agent-package-validation.js';

export interface CheckpointPackageSource {
  checkpointId:string;
  sourceChatId:string;
  agentIds:string[];
}
export interface CheckpointPackageReceipt extends CheckpointPackageSource {
  version:1;
  boundaryId:string;
  sha256:string;
  byteLength:number;
}
/** Host-only custody. Source deletion and import-operation cleanup never own this directory. */
export function checkpointPackageCustody(dataDir:string){
  const directory=path.join(dataDir,'checkpoint-package-custody');
  let tail:Promise<unknown>=Promise.resolve();
  const serial=<T>(work:()=>Promise<T>):Promise<T>=>{const next=tail.then(work,work);tail=next.catch(()=>{});return next;};
  const key=(source:CheckpointPackageSource)=>{
    if(!source.checkpointId||!source.sourceChatId||!source.agentIds.length||new Set(source.agentIds).size!==source.agentIds.length||source.agentIds.some(id=>!id))throw new Error('Checkpoint capture requires exact nonempty source membership');
    return createHash('sha256').update(source.checkpointId).digest('hex');
  };
  const syncDirectory=async()=>{if(process.platform!=='win32'){const handle=await fs.open(directory,'r');try{await handle.sync();}finally{await handle.close();}}};
  const writeJson=async(name:string,value:unknown)=>{
    const temporary=path.join(directory,`${name}.${randomUUID()}.tmp`);
    const handle=await fs.open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
    await fs.rename(temporary,path.join(directory,name));await syncDirectory();
  };
  const receiptAt=async(id:string):Promise<CheckpointPackageReceipt|undefined>=>{
    try{return JSON.parse(await fs.readFile(path.join(directory,`${id}.json`),'utf8')) as CheckpointPackageReceipt;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  };
  const sameSource=(a:CheckpointPackageSource,b:CheckpointPackageSource)=>a.checkpointId===b.checkpointId&&a.sourceChatId===b.sourceChatId&&JSON.stringify(a.agentIds)===JSON.stringify(b.agentIds);
  const validateMembership=(portable:AgentPortablePackageDto,source:CheckpointPackageSource)=>{
    if(JSON.stringify(portable.agents.map(node=>node.ref))!==JSON.stringify(source.agentIds)||portable.agents.some(node=>node.sourceChat?.ref!==source.sourceChatId))throw new Error('Checkpoint package source membership mismatch');
    return portable;
  };
  const verifiedRead=async(receipt:CheckpointPackageReceipt)=>{
    const id=key(receipt),stored=await receiptAt(id);
    try{await fs.access(path.join(directory,`${id}.released.json`));throw new Error('Checkpoint custody has been released');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(!stored||stored.version!==1||!sameSource(stored,receipt)||stored.boundaryId!==receipt.boundaryId||stored.sha256!==receipt.sha256||stored.byteLength!==receipt.byteLength)throw new Error('Checkpoint custody receipt does not match retained capture');
    const pathname=path.join(directory,`${id}.payload`),stat=await fs.lstat(pathname);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==receipt.byteLength||stat.size>AGENT_PACKAGE_MAX_BYTES)throw new Error('Checkpoint custody bytes unavailable or changed');
    // Reuse the package parser and its bounded worker; no source Agent lookup is needed.
    const handle=await fs.open(pathname,'r');const hash=createHash('sha256');
    try{for await(const bytes of handle.createReadStream({autoClose:false}))hash.update(bytes);}finally{await handle.close();}
    if(hash.digest('hex')!==receipt.sha256)throw new Error('Checkpoint custody digest mismatch');
    return validateMembership(validatePortableAgentPackage((await parsePortablePackageFile(pathname,{packageOnly:true})).portable).package,receipt);
  };
  return {
    /** Caller must hold the common source boundary until this promise settles. */
    capture:(source:CheckpointPackageSource,boundaryId:string,capture:()=>Promise<AgentPortablePackageDto>)=>serial(async()=>{
      const id=key(source);if(!boundaryId)throw new Error('Checkpoint source boundary required');
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      const existing=await receiptAt(id);
      if(existing){if(!sameSource(existing,source))throw new Error('Checkpoint identity already has different source membership');await verifiedRead(existing);return existing;}
      const pending=path.join(directory,`${id}.pending.json`);
      try{await fs.access(path.join(directory,`${id}.released.json`));throw new Error('Checkpoint custody has been released');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      try{await fs.access(pending);throw new Error('Checkpoint capture was interrupted; choose a new checkpoint identity');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      // Pending evidence survives failure/restart. Never silently recapture a later source cut.
      await writeJson(`${id}.pending.json`,{version:1,...source,boundaryId,state:'capturing'});
      const portable=validateMembership(validatePortableAgentPackage(await capture()).package,source);
      const temporary=path.join(directory,`${id}.${randomUUID()}.tmp`),handle=await fs.open(temporary,'wx',0o600),hash=createHash('sha256');let byteLength=0;
      try{for await(const part of portablePackageJsonChunks(portable)){const bytes=Buffer.from(part,'utf8');byteLength+=bytes.length;if(byteLength>AGENT_PACKAGE_MAX_BYTES)throw new Error('Checkpoint package exceeds package byte limit');hash.update(bytes);await handle.writeFile(bytes);}await handle.sync();}finally{await handle.close();}
      await fs.rename(temporary,path.join(directory,`${id}.payload`));await syncDirectory();
      const receipt:CheckpointPackageReceipt={version:1,...source,agentIds:[...source.agentIds],boundaryId,sha256:hash.digest('hex'),byteLength};
      await writeJson(`${id}.json`,receipt);
      await fs.unlink(pending);await syncDirectory();return receipt;
    }),
    read:(receipt:CheckpointPackageReceipt)=>serial(()=>verifiedRead(receipt)),
    release:(receipt:CheckpointPackageReceipt)=>serial(async()=>{
      const id=key(receipt),stored=await receiptAt(id);
      try{
        const released=JSON.parse(await fs.readFile(path.join(directory,`${id}.released.json`),'utf8')) as CheckpointPackageReceipt;
        if(!sameSource(released,receipt)||released.sha256!==receipt.sha256)throw new Error('Released checkpoint receipt mismatch');
        await fs.unlink(path.join(directory,`${id}.json`)).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
        await fs.unlink(path.join(directory,`${id}.payload`)).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});await syncDirectory();return;
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(!stored)throw new Error('Checkpoint custody receipt unavailable');
      await verifiedRead(receipt);
      await writeJson(`${id}.released.json`,receipt);
      // Remove the admission receipt first: a crash can leak bytes, never expose partial bytes.
      await fs.unlink(path.join(directory,`${id}.json`));await syncDirectory();
      await fs.unlink(path.join(directory,`${id}.payload`));await syncDirectory();
    }),
  };
}
