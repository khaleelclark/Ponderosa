import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import fs from '@ponderosa/native-host/fs';
import {beginSourceMutation,sourceMutationState,reconcileSourceMutation,stableJson} from '@ponderosa/agents';
import type {MemoryMutationEffect,MemoryMutationHoldDto,MemoryMutationReviewDto,MemoryMutationReconcileInput,MemoryMutationReconcileReceipt,MemoryMutationPreserveUnknownInput,MemoryMutationPreserveUnknownReceipt} from '@ponderosa/core';

/** A failed/unknown remote write stays ineligible across restart until explicit reconciliation. */
export function memorySourceMutations(directory:string){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw new Error('Memory source hold directory must be private');
  if(process.platform!=='win32'){const parent=fs.openSync(path.dirname(directory),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
  const sync=()=>{if(process.platform!=='win32'){const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}};
  const syncAudit=(audit:string)=>{if(process.platform!=='win32'){const fd=fs.openSync(audit,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}};
  const digest=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex');
  const filename=(id:string)=>{if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid memory hold identity');return path.join(directory,`${id}.json`);};
  type CollectionDeletion={principal:string;origin:string;scope:string;log:boolean;name:string};
  const deletionKey=(value:CollectionDeletion)=>digest(value);
  const deletionDirectory=path.join(directory,'completed-collection-deletions');
  const readDeletion=(identity:CollectionDeletion):{collectionId:string}|undefined=>{
    const file=path.join(deletionDirectory,deletionKey(identity)+'.json');
    try{
      const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('Memory deletion receipt unavailable');
      const receipt=JSON.parse(fs.readFileSync(file,'utf8')) as {version:number;identity:CollectionDeletion;collectionId:string};
      if(receipt.version!==1||stableJson(receipt.identity)!==stableJson(identity)||typeof receipt.collectionId!=='string'||!receipt.collectionId)throw Error('Memory deletion receipt differs');
      return {collectionId:receipt.collectionId};
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  };
  const recordDeletion=(identity:CollectionDeletion,collectionId:string)=>{
    if(!collectionId)throw Error('Memory collection deletion identity required');
    const previous=readDeletion(identity);
    if(previous){if(previous.collectionId!==collectionId)throw Error('Memory deletion receipt conflicts');return;}
    fs.mkdirSync(deletionDirectory,{recursive:true,mode:0o700});
    const file=path.join(deletionDirectory,deletionKey(identity)+'.json'),temporary=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temporary,'wx',0o600);
    try{fs.writeFileSync(fd,stableJson({version:1,identity,collectionId}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.linkSync(temporary,file);fs.unlinkSync(temporary);syncAudit(deletionDirectory);sync();
  };
  const read=(id:string)=>{
    const file=filename(id),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('Memory hold evidence unavailable');
    const hold=JSON.parse(fs.readFileSync(file,'utf8')) as {version:number;id:string;effect?:MemoryMutationEffect};
    if(hold.version!==1||hold.id!==id)throw Error('Memory hold identity differs');return hold;
  };
  const preserved=(id:string,holdSha256:string):MemoryMutationPreserveUnknownReceipt|undefined=>{
    const file=path.join(directory,'preserved-unknown',`${id}.json`);
    try{
      const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('Preserve-unknown receipt unavailable');
      const receipt=JSON.parse(fs.readFileSync(file,'utf8')) as MemoryMutationPreserveUnknownReceipt;
      if(receipt.version!==1||receipt.id!==id||receipt.holdSha256!==holdSha256||receipt.operatorId!=='local-operator'||receipt.disposition!=='preserve_unknown'||receipt.outcome!=='unknown'||receipt.held!==true||receipt.replayed!==false||receipt.backendModified!==false||typeof receipt.commandKey!=='string'||!receipt.commandKey.trim()||receipt.commandKey.length>256||typeof receipt.reason!=='string'||receipt.reason.trim().length<16||receipt.reason.length>4096||receipt.reviewSha256!==digest({purpose:'preserve_unknown',id,holdSha256}))throw Error('Preserve-unknown receipt conflicts with original hold');
      return receipt;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  };
  const inspect=(id:string):MemoryMutationHoldDto=>{const hold=read(id),sha256=digest(hold),disposition=preserved(id,sha256);return {id,sha256,effect:hold.effect,state:'unsettled',legacy:!hold.effect,preserveUnknownReviewSha256:digest({purpose:'preserve_unknown',id,holdSha256:sha256}),...(disposition?{disposition}:{})};};
  const review=async(id:string,observe:(effect:MemoryMutationEffect)=>Promise<{rows:unknown;rowCount:number}>)=>{
    const before=sourceMutationState(),hold=inspect(id);
    if(before.activeWriters)throw Error('Source writers must drain before memory reconciliation');
    if(!hold.effect)return {dto:{hold,reviewSha256:digest({hold,before}),canReconcile:false,backendDrainEvidenceRequired:true,reason:'Legacy hold lacks collection/effect identity. Record preserve_unknown to retain uncertainty; exact source capture remains held. Do not replay the write or infer completion.'} as MemoryMutationReviewDto,epoch:before.epoch};
    const observed=await observe(hold.effect),confirmed=await observe(hold.effect),after=sourceMutationState();
    if(after.activeWriters||before.epoch!==after.epoch||digest(observed)!==digest(confirmed)||inspect(id).sha256!==hold.sha256)throw Error('Memory backend or hold changed during review');
    const dto:MemoryMutationReviewDto={hold,reviewSha256:digest({hold,before,backend:digest(observed.rows)}),backendSha256:digest(observed.rows),rowCount:observed.rowCount,canReconcile:true,backendDrainEvidenceRequired:true};
    return {dto,epoch:before.epoch,rows:observed.rows};
  };
  return {
    list:():MemoryMutationHoldDto[]=>fs.readdirSync(directory).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).sort().map(name=>inspect(name.slice(0,-5))),
    review:async(id:string,observe:(effect:MemoryMutationEffect)=>Promise<{rows:unknown;rowCount:number}>)=>(await review(id,observe)).dto,
    async preserveUnknown(id:string,input:MemoryMutationPreserveUnknownInput):Promise<MemoryMutationPreserveUnknownReceipt>{
      if(!input||typeof input.commandKey!=='string'||!input.commandKey.trim()||input.commandKey.length>256||typeof input.reviewSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.reviewSha256)||input.preserveUnknown!==true||typeof input.reason!=='string'||input.reason.trim().length<16||input.reason.length>4096)throw Error('Exact review and explicit preserve-unknown reason required');
      const hold=inspect(id),previous=hold.disposition;
      if(previous){if(previous.commandKey!==input.commandKey||previous.reviewSha256!==input.reviewSha256||previous.reason!==input.reason)throw Error('Preserve-unknown command conflict');syncAudit(path.join(directory,'preserved-unknown'));sync();return previous;}
      // The immutable original is the review: unavailable/unknown backends need no guessed lookup.
      if(hold.preserveUnknownReviewSha256!==input.reviewSha256)throw Error('Exact preserve-unknown review required');
      const receipt:MemoryMutationPreserveUnknownReceipt={version:1,id,commandKey:input.commandKey,reviewSha256:input.reviewSha256,holdSha256:hold.sha256,reason:input.reason,operatorId:'local-operator',disposition:'preserve_unknown',outcome:'unknown',held:true,replayed:false,backendModified:false};
      // Keep the original hold and uncertain writer fence. No call to reconcileSourceMutation.
      const audit=path.join(directory,'preserved-unknown');
      fs.mkdirSync(audit,{recursive:true,mode:0o700});
      if(inspect(id).sha256!==hold.sha256)throw Error('Memory hold changed before preserve-unknown publication');
      const file=path.join(audit,`${id}.json`),temporary=path.join(audit,`${id}.${randomUUID()}.tmp`),fd=fs.openSync(temporary,'wx',0o600);
      try{fs.writeFileSync(fd,stableJson(receipt));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.linkSync(temporary,file);fs.unlinkSync(temporary);
      syncAudit(audit);sync();return receipt;
    },
    async reconcile(id:string,input:MemoryMutationReconcileInput,observe:(effect:MemoryMutationEffect)=>Promise<{rows:unknown;rowCount:number}>):Promise<MemoryMutationReconcileReceipt>{
      filename(id);
      if(typeof input.commandKey!=='string'||!input.commandKey||input.commandKey.length>256||typeof input.reviewSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.reviewSha256)||input.preserveCurrentBackend!==true||typeof input.backendDrainEvidence!=='string'||input.backendDrainEvidence.trim().length<16||input.backendDrainEvidence.length>4096)throw Error('Explicit operator backend-drain evidence and preserve-current choice required');
      const audit=path.join(directory,'reconciled'),receiptFile=path.join(audit,`${id}.json`);
      let previous:MemoryMutationReconcileReceipt|undefined;
      try{previous=JSON.parse(fs.readFileSync(receiptFile,'utf8')) as MemoryMutationReconcileReceipt;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(previous){
        if(previous.version!==1||previous.id!==id||previous.operatorId!=='local-operator'||previous.state!=='reconciled'||previous.commandKey!==input.commandKey||previous.reviewSha256!==input.reviewSha256||previous.backendDrainEvidence!==input.backendDrainEvidence)throw Error('Memory reconciliation command conflict');
        if(digest(JSON.parse(fs.readFileSync(path.join(audit,`${id}.backend.json`),'utf8')))!==previous.backendSha256)throw Error('Retained reconciliation backend evidence differs');
        // Complete an interrupted hold retirement; receipt already seals the reviewed backend bytes.
        const epoch=sourceMutationState().epoch;
        reconcileSourceMutation(`memory-source-mutation:${id}`,epoch,()=>{
          if(fs.existsSync(filename(id))){if(inspect(id).sha256!==previous!.holdSha256||fs.existsSync(path.join(audit,`${id}.hold.json`)))throw Error('Memory hold retirement evidence differs');fs.renameSync(filename(id),path.join(audit,`${id}.hold.json`));}
          if(digest(JSON.parse(fs.readFileSync(path.join(audit,`${id}.hold.json`),'utf8')))!==previous!.holdSha256)throw Error('Retained memory hold evidence differs');syncAudit(audit);sync();
        });return previous;
      }
      const current=await review(id,observe);
      if(!current.dto.canReconcile||!current.dto.backendSha256||current.dto.reviewSha256!==input.reviewSha256)throw Error('Exact current memory reconciliation review required');
      const receipt:MemoryMutationReconcileReceipt={version:1,id,commandKey:input.commandKey,reviewSha256:input.reviewSha256,holdSha256:current.dto.hold.sha256,backendSha256:current.dto.backendSha256,backendDrainEvidence:input.backendDrainEvidence,operatorId:'local-operator',state:'reconciled'};
      reconcileSourceMutation(`memory-source-mutation:${id}`,current.epoch,()=>{
        fs.mkdirSync(audit,{recursive:true,mode:0o700});
        const write=(file:string,value:unknown)=>{const temporary=`${file}.${randomUUID()}.tmp`,fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,stableJson(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);};
        // Retain observed bytes before the decision receipt or hold retirement. Never mutate backend data.
        const evidence=path.join(audit,`${id}.backend.json`);
        if(fs.existsSync(evidence)){if(digest(JSON.parse(fs.readFileSync(evidence,'utf8')))!==receipt.backendSha256)throw Error('Prior backend evidence differs');}else write(evidence,current.rows);
        write(receiptFile,receipt);
        syncAudit(audit);sync();
        fs.renameSync(filename(id),path.join(audit,`${id}.hold.json`));syncAudit(audit);sync();
      });return receipt;
    },
    assertSettled(){
      if(fs.readdirSync(directory).some(name=>name.endsWith('.json')))throw new Error('Checkpoint capture refused: memory mutation requires reconciliation');
    },
    hasUnidentifiedHold(){
      for(const name of fs.readdirSync(directory).filter(name=>name.endsWith('.json'))){
        if(!/^[a-f0-9-]{36}\.json$/.test(name))return true;
        let hold:MemoryMutationHoldDto;try{hold=inspect(name.slice(0,-5));}catch{return true;}
        const effect=hold.effect;
        if(!effect||typeof effect!=='object'||Object.keys(effect).some(key=>!['scope','log','operation'].includes(key))||
          typeof effect.scope!=='string'||effect.scope.length>512||!(/^(global|chat:.+)$/.test(effect.scope))||
          typeof effect.log!=='boolean'||!['create_collection','delete_collection','upsert','add','update','delete','modify'].includes(effect.operation))return true;
      }
      return false;
    },
    hasScopeHold(scope:string){
      if(this.hasUnidentifiedHold())return true;
      return this.list().some(hold=>hold.effect?.scope===scope);
    },
    readCollectionDeletion:readDeletion,
    recordCollectionDeletion:recordDeletion,
    async run<T>(work:()=>Promise<T>,effect?:MemoryMutationEffect,acknowledged?:()=>void):Promise<T>{
      const finish=beginSourceMutation(),id=randomUUID(),file=path.join(directory,`${id}.json`);let settled=false;
      try{
        fs.mkdirSync(directory,{recursive:true,mode:0o700});
        const fd=fs.openSync(file,'wx',0o600);
        try{fs.writeFileSync(fd,JSON.stringify({version:1,id,state:'remote_write_unsettled',...(effect?{effect}:{} )}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}sync();
        const result=await work();
        acknowledged?.();
        fs.unlinkSync(file);sync();settled=true;return result;
      }finally{finish(settled?undefined:`memory-source-mutation:${id}`);}
    },
  };
}
