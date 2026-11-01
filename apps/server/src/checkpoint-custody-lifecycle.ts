import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import fs from '@ponderosa/native-host/fs';
import {stableJson,sourceMutationState} from '@ponderosa/agents';
import {AGENT_PACKAGE_MAX_BYTES,type CheckpointPackageSource,type CheckpointCustodyLifecycleEntry,type CheckpointCustodyReconcileInput,type CheckpointCustodyReconcileReceipt} from '@ponderosa/core';

export type CustodyLifecycleProof=(source:CheckpointPackageSource|undefined,custodyId:string)=>{references:string[];blockers:string[]};
/** Reclaim active namespace while retaining every byte and tombstoning the capture identity. */
export function checkpointCustodyLifecycle(directory:string,proof:CustodyLifecycleProof,abandonedSource?:CheckpointPackageSource){
 const digest=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex');
 const valid=(id:string)=>{if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid custody identity');return id;};
 const names=(id:string)=>fs.readdirSync(directory).filter(name=>name.startsWith(valid(id)+'.')&&!name.endsWith('.reconciled.json')).sort();
 const readJson=(name:string)=>{try{const file=path.join(directory,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>65536)throw Error('Custody metadata is not a bounded regular file');return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}};
 const hashFile=(root:string,name:string)=>{
  if(name.includes('/')||name.includes('\\'))throw Error('Invalid custody file identity');
  const file=path.join(root,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>AGENT_PACKAGE_MAX_BYTES)throw Error('Custody evidence changed or is not a bounded owned file');
  const fd=fs.openSync(file,'r'),hash=createHash('sha256'),buffer=Buffer.alloc(65536);let count:number,total=0;
  try{while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0){total+=count;if(total>AGENT_PACKAGE_MAX_BYTES)throw Error('Custody evidence exceeds limit');hash.update(buffer.subarray(0,count));}const after=fs.fstatSync(fd);if(after.ino!==stat.ino||after.dev!==stat.dev||after.size!==total||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw Error('Custody evidence changed during review');}finally{fs.closeSync(fd);}
  return {name,byteLength:total,sha256:hash.digest('hex')};
 };
 const files=(id:string)=>{const inventory=names(id);if(inventory.length>128)throw Error('Custody evidence inventory exceeds review bound');return inventory.map(name=>hashFile(directory,name));};
 const review=(id:string):CheckpointCustodyLifecycleEntry=>{
  valid(id);const reconciled=readJson(`${id}.reconciled.json`);
  if(reconciled)return {custodyId:id,state:'reconciled',sourceAgentIds:[],references:[],blockers:[],files:[],reviewSha256:reconciled.reviewSha256};
  const retained=readJson(`${id}.json`),pending=readJson(`${id}.pending.json`),released=readJson(`${id}.released.json`),source=(retained??pending??released??abandonedSource) as CheckpointPackageSource|undefined;
  if(source&&createHash('sha256').update(source.checkpointId).digest('hex')!==id)throw Error('Custody source identity differs');
  const observed=proof(source,id),mutation=sourceMutationState(),inventory=files(id);
  if(!inventory.length&&!abandonedSource)throw Error('Custody evidence not found');
  const blockers=[...observed.blockers,...(mutation.activeWriters||mutation.activeCaptures||mutation.uncertainWriters?['Host source writers/captures have not drained']:[])];
  const entry={custodyId:id,state:(released?'released':retained?'retained':pending?.state==='failed'?'failed':'capturing') as CheckpointCustodyLifecycleEntry['state'],checkpointId:source?.checkpointId,sourceChatId:source?.sourceChatId,sourceAgentIds:source?.agentIds??[],references:observed.references,blockers,files:inventory};
  return {...entry,reviewSha256:digest({entry,mutation})};
 };
 const sync=(name:string)=>{if(process.platform!=='win32'){const fd=fs.openSync(name,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}};
 return {
  list:()=>[...new Set(fs.readdirSync(directory).flatMap(name=>/^([a-f0-9]{64})\./.exec(name)?.[1]??[]))].sort().slice(0,1000),
  review,
  reconcile(id:string,input:CheckpointCustodyReconcileInput):CheckpointCustodyReconcileReceipt{
   valid(id);if(typeof input.commandKey!=='string'||!input.commandKey||input.commandKey.length>256||typeof input.reviewSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.reviewSha256)||input.preserveEvidence!==true)throw Error('Explicit evidence-preserving reconciliation command required');
   const prior=readJson(`${id}.reconciled.json`) as CheckpointCustodyReconcileReceipt|undefined;
   if(prior){
    const expectedDirectory=path.join(directory,'reconciled',id);
    if(prior.version!==1||prior.custodyId!==id||prior.operatorId!=='local-operator'||prior.evidenceDirectory!==expectedDirectory||prior.commandKey!==input.commandKey||prior.reviewSha256!==input.reviewSha256)throw Error('Custody reconciliation command conflict');
    const evidenceStat=fs.lstatSync(expectedDirectory),manifestFile=path.join(expectedDirectory,'manifest.json'),manifestStat=fs.lstatSync(manifestFile);
    if(!evidenceStat.isDirectory()||evidenceStat.isSymbolicLink()||!manifestStat.isFile()||manifestStat.isSymbolicLink()||manifestStat.nlink!==1||manifestStat.size>256*1024)throw Error('Retained custody manifest is not bounded owned evidence');
    const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8')) as {receipt:CheckpointCustodyReconcileReceipt;files:CheckpointCustodyLifecycleEntry['files']};
    if(stableJson(manifest.receipt)!==stableJson(prior)||!Array.isArray(manifest.files)||manifest.files.length>128||digest(manifest.files)!==prior.filesSha256)throw Error('Custody reconciliation evidence differs');
    const remaining=files(id);
    for(const file of remaining){const original=manifest.files.find(item=>item.name===file.name);if(!original||stableJson(original)!==stableJson(file))throw Error('Unrecognized bytes remain preserved; review separately');const destination=path.join(expectedDirectory,file.name);if(fs.existsSync(destination))throw Error('Two evidence copies remain; preserve for inspection');fs.renameSync(path.join(directory,file.name),destination);}
    for(const original of manifest.files){if(stableJson(hashFile(expectedDirectory,original.name))!==stableJson(original))throw Error('Retained custody evidence changed');}
    sync(expectedDirectory);sync(directory);return prior;
   }
   const current=review(id);
   if(current.reviewSha256!==input.reviewSha256||current.references.length||current.blockers.length)throw Error('Current unreferenced custody and observed drain review required');
   const evidenceDirectory=path.join(directory,'reconciled',id);fs.mkdirSync(evidenceDirectory,{recursive:true,mode:0o700});
   const receipt:CheckpointCustodyReconcileReceipt={version:1,custodyId:id,commandKey:input.commandKey,reviewSha256:input.reviewSha256,state:'reconciled',evidenceDirectory,preservedBytes:current.files.reduce((sum,file)=>sum+file.byteLength,0),filesSha256:digest(current.files),operatorId:'local-operator'};
   const write=(name:string,value:unknown)=>{const temporary=`${name}.${randomUUID()}.tmp`,fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,stableJson(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,name);};
   // Preserve review manifest and tombstone FIRST. An interrupted move keeps every byte in one namespace.
   write(path.join(evidenceDirectory,'manifest.json'),{receipt,files:current.files});sync(evidenceDirectory);sync(path.dirname(evidenceDirectory));
   write(path.join(directory,`${id}.reconciled.json`),receipt);sync(directory);
   for(const file of current.files)fs.renameSync(path.join(directory,file.name),path.join(evidenceDirectory,file.name));
   sync(evidenceDirectory);sync(directory);return receipt;
  },
 };
}
