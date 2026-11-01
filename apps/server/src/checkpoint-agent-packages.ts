import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import syncFs,{promises as fs} from '@ponderosa/native-host/fs';
import {AGENT_PACKAGE_MAX_BYTES,AGENT_PACKAGE_MAX_AGENTS,type AgentPortablePackageDto} from '@ponderosa/core';
import {parsePortablePackageFile,portablePackageJsonChunks} from './agent-package-codec.js';
import {validatePortableAgentPackage} from './portable-agent-package-validation.js';

import type {CheckpointPackageSource,CheckpointPackageReceipt,CheckpointPackageStatus} from '@ponderosa/core';
export type {CheckpointPackageSource,CheckpointPackageReceipt,CheckpointPackageStatus} from '@ponderosa/core';
/** Host-only custody. Source deletion and import-operation cleanup never own this directory. */
export function checkpointPackageCustody(dataDir:string){
  const directory=path.join(dataDir,'checkpoint-package-custody');
  syncFs.mkdirSync(directory,{recursive:true,mode:0o700});
  const directoryStat=syncFs.lstatSync(directory);if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()||(directoryStat.mode&0o077))throw new Error('Checkpoint custody directory must be private');
  if(process.platform!=='win32'){const parent=syncFs.openSync(dataDir,'r');try{syncFs.fsyncSync(parent);}finally{syncFs.closeSync(parent);}}
  let tail:Promise<unknown>=Promise.resolve();
  const serial=<T>(work:()=>Promise<T>):Promise<T>=>{const next=tail.then(work,work);tail=next.catch(()=>{});return next;};
  const key=(source:CheckpointPackageSource)=>{
    if(!source.checkpointId||!source.sourceChatId||!source.agentIds.length||source.agentIds.length>AGENT_PACKAGE_MAX_AGENTS||new Set(source.agentIds).size!==source.agentIds.length||source.agentIds.some(id=>!id))throw new Error('Checkpoint capture requires bounded exact nonempty source membership');
    const intent=source.intent;
    if(!intent||!intent.executionId||!intent.resourceStepId||!Number.isSafeInteger(intent.resourceGeneration)||intent.resourceGeneration<0||[intent.frontierSha256,intent.bindingSha256,intent.configurationSha256].some(hash=>typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)))throw new Error('Checkpoint capture requires exact resource intent');
    return createHash('sha256').update(source.checkpointId).digest('hex');
  };
  const syncDirectory=async()=>{if(process.platform!=='win32'){const handle=await fs.open(directory,'r');try{await handle.sync();}finally{await handle.close();}}};
  const writeJson=async(name:string,value:unknown)=>{
    const temporary=path.join(directory,`${name}.${randomUUID()}.tmp`);
    const handle=await fs.open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
    await fs.rename(temporary,path.join(directory,name));await syncDirectory();
  };
  const claimCapture=async(name:string,value:unknown)=>{
    // Exclusive claim also protects two host instances racing the same intent.
    const handle=await fs.open(path.join(directory,name),'wx',0o600);
    try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
    await syncDirectory();
  };
  const publishReceipt=(id:string,value:CheckpointPackageReceipt)=>{
    const temporary=path.join(directory,`${id}.${randomUUID()}.tmp`),fd=syncFs.openSync(temporary,'wx',0o600);
    try{syncFs.writeFileSync(fd,JSON.stringify(value));syncFs.fsyncSync(fd);}finally{syncFs.closeSync(fd);}
    syncFs.renameSync(temporary,path.join(directory,`${id}.json`));
    if(process.platform!=='win32'){const directoryFd=syncFs.openSync(directory,'r');try{syncFs.fsyncSync(directoryFd);}finally{syncFs.closeSync(directoryFd);}}
  };
  const receiptAt=async(id:string):Promise<CheckpointPackageReceipt|undefined>=>{
    try{return JSON.parse(await fs.readFile(path.join(directory,`${id}.json`),'utf8')) as CheckpointPackageReceipt;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  };
  const sameSource=(a:CheckpointPackageSource,b:CheckpointPackageSource)=>a.checkpointId===b.checkpointId&&a.sourceChatId===b.sourceChatId&&JSON.stringify(a.agentIds)===JSON.stringify(b.agentIds)&&a.intent?.executionId===b.intent?.executionId&&a.intent?.resourceStepId===b.intent?.resourceStepId&&a.intent?.resourceGeneration===b.intent?.resourceGeneration&&a.intent?.frontierSha256===b.intent?.frontierSha256&&a.intent?.bindingSha256===b.intent?.bindingSha256&&a.intent?.configurationSha256===b.intent?.configurationSha256;
  const sameReceipt=(a:CheckpointPackageReceipt,b:CheckpointPackageReceipt)=>sameSource(a,b)&&a.version===1&&b.version===1&&a.custodyId===b.custodyId&&a.boundaryId===b.boundaryId&&a.sha256===b.sha256&&a.byteLength===b.byteLength;
  const validateMembership=(portable:AgentPortablePackageDto,source:CheckpointPackageSource)=>{
    if(JSON.stringify(portable.agents.map(node=>node.ref))!==JSON.stringify(source.agentIds)||portable.agents.some(node=>node.sourceChat?.ref!==source.sourceChatId))throw new Error('Checkpoint package source membership mismatch');
    return portable;
  };
  const verifiedRead=async(receipt:CheckpointPackageReceipt)=>{
    const id=key(receipt),stored=await receiptAt(id);
    try{await fs.access(path.join(directory,`${id}.released.json`));throw new Error('Checkpoint custody has been released');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(!stored||stored.version!==1||receipt.version!==1||stored.custodyId!==id||receipt.custodyId!==id||!sameSource(stored,receipt)||stored.boundaryId!==receipt.boundaryId||stored.sha256!==receipt.sha256||stored.byteLength!==receipt.byteLength)throw new Error('Checkpoint custody receipt does not match retained capture');
    const pathname=path.join(directory,`${id}.payload`),stat=await fs.lstat(pathname);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==receipt.byteLength||stat.size>AGENT_PACKAGE_MAX_BYTES)throw new Error('Checkpoint custody bytes unavailable or changed');
    // Reuse the package parser and its bounded worker; no source Agent lookup is needed.
    const handle=await fs.open(pathname,'r');const hash=createHash('sha256');
    try{for await(const bytes of handle.createReadStream({autoClose:false}))hash.update(bytes);}finally{await handle.close();}
    if(hash.digest('hex')!==receipt.sha256)throw new Error('Checkpoint custody digest mismatch');
    return validateMembership(validatePortableAgentPackage((await parsePortablePackageFile(pathname,{packageOnly:true})).portable).package,receipt);
  };
  return {
    inspect:(source:CheckpointPackageSource):Promise<CheckpointPackageStatus>=>serial(async()=>{
      const id=key(source);
      const readJson=async(name:string)=>{try{return JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}};
      const released=await readJson(`${id}.released.json`) as CheckpointPackageReceipt|undefined;
      if(released){if(!sameSource(released,source))throw new Error('Checkpoint capture intent conflict');return {state:'released',receipt:released};}
      const retained=await receiptAt(id);
      if(retained){if(!sameSource(retained,source))throw new Error('Checkpoint capture intent conflict');await verifiedRead(retained);return {state:'retained',receipt:retained};}
      const pending=await readJson(`${id}.pending.json`) as CheckpointPackageSource&{boundaryId:string;state:string;reason?:string}|undefined;
      if(pending){if(!sameSource(pending,source))throw new Error('Checkpoint capture intent conflict');return pending.state==='failed'?{state:'failed',source,boundaryId:pending.boundaryId,reason:pending.reason??'capture_failed'}:{state:'capturing',source,boundaryId:pending.boundaryId};}
      return {state:'missing'};
    }),
    /** Caller must hold the common source boundary until this promise settles. */
    capture:(source:CheckpointPackageSource,boundaryId:string,capture:()=>Promise<AgentPortablePackageDto>,commit:(publish:()=>void)=>void=publish=>publish())=>serial(async()=>{
      const id=key(source);if(!boundaryId)throw new Error('Checkpoint source boundary required');
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      const existing=await receiptAt(id);
      if(existing){if(!sameSource(existing,source))throw new Error('Checkpoint identity already has different source membership');await verifiedRead(existing);return existing;}
      const pending=path.join(directory,`${id}.pending.json`);
      try{await fs.access(path.join(directory,`${id}.released.json`));throw new Error('Checkpoint custody has been released');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      try{await fs.access(pending);throw new Error('Checkpoint capture was interrupted; choose a new checkpoint identity');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      // Pending evidence survives failure/restart. Never silently recapture a later source cut.
      await claimCapture(`${id}.pending.json`,{version:1,...source,boundaryId,state:'capturing'});
      try{
      const portable=validateMembership(validatePortableAgentPackage(await capture()).package,source);
      const temporary=path.join(directory,`${id}.${randomUUID()}.tmp`),handle=await fs.open(temporary,'wx',0o600),hash=createHash('sha256');let byteLength=0;
      try{for await(const part of portablePackageJsonChunks(portable)){const bytes=Buffer.from(part,'utf8');byteLength+=bytes.length;if(byteLength>AGENT_PACKAGE_MAX_BYTES)throw new Error('Checkpoint package exceeds package byte limit');hash.update(bytes);await handle.writeFile(bytes);}await handle.sync();}finally{await handle.close();}
      await fs.rename(temporary,path.join(directory,`${id}.payload`));await syncDirectory();
      const receipt:CheckpointPackageReceipt={version:1,custodyId:id,...source,agentIds:[...source.agentIds],intent:{...source.intent},boundaryId,sha256:hash.digest('hex'),byteLength};
      // Final source validation and receipt admission must share one synchronous turn.
      commit(()=>publishReceipt(id,receipt));
      await fs.unlink(pending);await syncDirectory();return receipt;
      }catch(error){
        await writeJson(`${id}.pending.json`,{version:1,...source,boundaryId,state:'failed',reason:error instanceof Error&&error.name==='SourceCaptureChangedError'?'source_changed':'capture_failed'});
        throw error;
      }
    }),
    read:(receipt:CheckpointPackageReceipt)=>serial(()=>verifiedRead(receipt)),
    release:(receipt:CheckpointPackageReceipt)=>serial(async()=>{
      const id=key(receipt),stored=await receiptAt(id);
      try{
        const released=JSON.parse(await fs.readFile(path.join(directory,`${id}.released.json`),'utf8')) as CheckpointPackageReceipt;
        if(!sameReceipt(released,receipt))throw new Error('Released checkpoint receipt mismatch');
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
