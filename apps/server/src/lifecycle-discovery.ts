import path from 'node:path';
import fs from '@ponderosa/native-host/fs';
import type Database from 'better-sqlite3';
import {stableJson,resourceCaptureFrontierHash,readGroupCaptureDisposition,type BranchCustodyLifecycle} from '@ponderosa/agents';
import type {AgentImportOperationDto,CheckpointPackageSource,CheckpointPackageReceipt,LifecycleDiscoveryQuery,LifecycleDiscoveryPage,LifecycleImportEntry,LifecycleDestinationEntry,LifecycleCaptureEntry,LifecycleGroupCaptureEntry} from '@ponderosa/core';
import {lifecycleHash} from './lifecycle-journal.js';
type Row=Record<string,any>;
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
/** Bounded read-only inventories share exact revision-bound cursors; overflow is explicit. */
export function lifecycleDiscoveryPage<T>(kind:string,items:{key:string;value:T}[],query:LifecycleDiscoveryQuery):LifecycleDiscoveryPage<T>{
 const parse=(bytes:string)=>{try{return JSON.parse(bytes);}catch{throw Error('Invalid lifecycle cursor');}};

  if(items.length>4096)throw Error('Lifecycle discovery inventory exceeds bound');
  const limit=query.limit===undefined?50:Number(query.limit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||Object.keys(query).some(key=>!['cursor','limit'].includes(key)))throw Error('Bounded lifecycle cursor/limit required');
  items.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  if(new Set(items.map(item=>item.key)).size!==items.length)throw Error('Ambiguous lifecycle discovery identity');
  const revision=lifecycleHash({kind,items});let start=0;
  if(query.cursor!==undefined){
   if(typeof query.cursor!=='string'||query.cursor.length>2048)throw Error('Invalid lifecycle cursor');
   const cursor=parse(Buffer.from(query.cursor,'base64url').toString('utf8'));
   if(cursor.kind!==kind||cursor.revision!==revision||typeof cursor.after!=='string')throw Error('Lifecycle inventory changed; restart discovery');
   const index=items.findIndex(item=>item.key===cursor.after);if(index<0)throw Error('Lifecycle cursor identity unavailable');start=index+1;
  }
  const selected=items.slice(start,start+limit),hasMore=start+selected.length<items.length;
  return {items:selected.map(item=>item.value),revision,...(hasMore?{nextCursor:Buffer.from(stableJson({kind,revision,after:selected.at(-1)!.key})).toString('base64url')}:{})};

}
/** Read-only operator audit. No hydration/quarantine, policy changes, effect inference or package reads. */
export function lifecycleDiscovery(context:{db:Database.Database;dataDir:string;validateImport:(value:unknown,id:string)=>AgentImportOperationDto;owner:()=>BranchCustodyLifecycle;readRetirement:(id:string,group:boolean)=>unknown}){
 const db=context.db;
 const rows=(table:string,where='1')=>{
  const columns=(db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).filter(column=>/TEXT/i.test(column.type));
  const lengths=columns.map(column=>{if(!/^[a-z0-9_]+$/.test(column.name))throw Error('Unknown audit column');return `COALESCE(length(${column.name}),0)`;}).join('+')||'0';
  const size=db.prepare(`SELECT count(*) count,COALESCE(sum(${lengths}),0) bytes FROM ${table} WHERE ${where}`).get() as {count:number;bytes:number};
  if(size.count>4096||size.bytes>16*1024*1024)throw Error('Lifecycle discovery inventory exceeds bound');
  const result=db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid LIMIT 4097`).all() as Row[];
  if(result.length>4096||Buffer.byteLength(stableJson(result))>16*1024*1024)throw Error('Lifecycle discovery inventory exceeds bound');return result;
 };
 const parse=(bytes:string)=>{try{return JSON.parse(bytes);}catch{throw Error('Invalid retained lifecycle metadata; evidence remains held');}};
 const canonical=(bytes:string)=>{const value=parse(bytes);if(stableJson(value)!==bytes)throw Error('Noncanonical lifecycle discovery evidence');return value;};
 const page=lifecycleDiscoveryPage;
 const owner=(projectId:string,conversationId:string):LifecycleImportEntry['owner']=>{
  if(!text(projectId)||!text(conversationId))throw Error('Original lifecycle owner required');
  const project=db.prepare('SELECT id FROM projects WHERE id=?').get(projectId),projectDeletion=db.prepare('SELECT project_id FROM project_deletion_receipts WHERE project_id=?').get(projectId);
  const chat=db.prepare('SELECT project_id FROM conversations WHERE id=?').get(conversationId) as Row|undefined;
  const removed=db.prepare('SELECT project_id FROM conversation_deletion_receipts WHERE conversation_id=?').get(conversationId) as Row|undefined;
  if(chat&&chat.project_id!==projectId||removed&&removed.project_id!==projectId)throw Error('Original lifecycle Chat ownership differs');
  return {projectId,conversationId,project:project?'current':projectDeletion?'deletion_receipt':'retained_only',conversation:chat?'current':removed?'deletion_receipt':'retained_only'};
 };
 const source=(value:unknown):CheckpointPackageSource=>{
  const s=value as CheckpointPackageSource,i=s?.intent;
  if(!text(s?.checkpointId)||!text(s.sourceChatId)||!Array.isArray(s.agentIds)||!s.agentIds.length||s.agentIds.length>4096||s.agentIds.some(id=>!text(id))||new Set(s.agentIds).size!==s.agentIds.length
   ||!i||!text(i.executionId)||!text(i.resourceStepId)||!Number.isSafeInteger(i.resourceGeneration)||i.resourceGeneration<0
   ||![i.frontierSha256,i.bindingSha256,i.configurationSha256,...(i.hostCutSha256===undefined?[]:[i.hostCutSha256])].every(hash))throw Error('Unverified capture source');
  return s;
 };
 return {
  imports(query:LifecycleDiscoveryQuery):LifecycleDiscoveryPage<LifecycleImportEntry>{return db.transaction(()=>{
   const directory=path.join(context.dataDir,'agent-import-operations');
   if(!fs.existsSync(directory))return page<LifecycleImportEntry>('imports',[],query);
   const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Import audit directory differs');
   const names=fs.readdirSync(directory).sort();if(names.length>16384)throw Error('Import audit directory exceeds bound');
   const entries=new Map<string,{operation:AgentImportOperationDto;receiptState?:string;origin:LifecycleImportEntry['evidenceOrigin'];sha256:string[]}>();let bytes=0;
   for(const name of names){
    const match=/^([a-f0-9-]{36})(\.lifecycle)?\.json$/.exec(name);if(!match)continue;
    const file=path.join(directory,name),before=fs.lstatSync(file);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>4*1024*1024)throw Error('Import discovery evidence is not owned bounded data');
    bytes+=before.size;if(bytes>16*1024*1024)throw Error('Import discovery bytes exceed bound');
    const raw=parse(fs.readFileSync(file,'utf8')),after=fs.lstatSync(file);
    if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('Import discovery changed during read');
    const operation=context.validateImport(match[2]?raw.operation:raw,match[1]!);
    if(match[2]&&(raw.receipt?.operationId!==operation.id||raw.receipt?.operatorId!=='local-operator'||!['retired','preserved_unresolved'].includes(raw.receipt?.state)||raw.input?.commandKey!==raw.receipt?.commandKey||raw.input?.reviewSha256!==raw.receipt?.reviewSha256))throw Error('Import lifecycle receipt identity differs');
    const prior=entries.get(operation.id);
    if(prior&&['projectId','conversationId','requestId','payloadHash','product'].some(key=>prior.operation[key as keyof AgentImportOperationDto]!==operation[key as keyof AgentImportOperationDto]))throw Error('Import original ownership changed');
    entries.set(operation.id,{operation:match[2]&&prior?prior.operation:operation,receiptState:match[2]?raw.receipt.state:prior?.receiptState,origin:match[2]?(prior?.origin??'retained_lifecycle'):'journal',sha256:[...(prior?.sha256??[]),lifecycleHash(raw)]});
   }
   if(entries.size>4096)throw Error('Import inventory exceeds bound');
   const result=page<LifecycleImportEntry>('imports',[...entries.values()].map(({operation,receiptState,origin,sha256})=>({key:operation.id,value:{operationId:operation.id,owner:owner(operation.projectId,operation.conversationId),product:operation.product,status:operation.status,phase:operation.phase,evidenceOrigin:origin,...(receiptState?{lifecycleState:receiptState}:{}),evidenceSha256:lifecycleHash(sha256)}})),query);
   return {...result,unverifiedEvidenceCount:names.filter(name=>name.includes('.corrupt')||name.endsWith('.json')&&!/^([a-f0-9-]{36})(\.lifecycle)?\.json$/.test(name)).length};
  })();},
  destinations(query:LifecycleDiscoveryQuery):LifecycleDiscoveryPage<LifecycleDestinationEntry>{return db.transaction(()=>{
   const entries=new Map<string,{key:string;value:LifecycleDestinationEntry}>();
   const add=(id:string,row:Row,reservation:Row,state:LifecycleDestinationEntry['state'],evidence:unknown)=>{
    if(!text(id)||reservation.operatorId!=='local-operator'||lifecycleHash(reservation)!==row.reservation_hash||stableJson(reservation)!==row.reservation_json
     ||!Number.isSafeInteger(reservation.checkpointId)||!hash(reservation.checkpointHash)||lifecycleHash(canonical(row.snapshot_json))!==reservation.checkpointHash
     ||row.checkpoint_id!==reservation.checkpointId||row.id!==id||row.branch_id!==reservation.branchId||row.source_execution_id!==reservation.sourceExecutionId||row.project_id!==reservation.destination?.projectId||row.conversation_id!==reservation.destination?.conversationId)throw Error('Destination discovery identity differs');
    const resources=reservation.resources??[{custody:reservation.custody,destination:reservation.destination}];
    if(!Array.isArray(resources)||resources.length<1||resources.length>32||reservation.resources&&resources.length<2)throw Error('Destination resource inventory differs');
    if(new Set(resources.map((r:Row)=>r.destination?.conversationId)).size!==resources.length||resources.some((r:Row)=>r.destination?.projectId!==row.project_id))throw Error('Destination group ownership differs');
    const destinations=resources.map((r:Row)=>{if(!text(r.destination?.executionId)||!text(r.destination?.resourceStepId)||!text(r.custody?.sourceChatId))throw Error('Destination resource identity missing');return {...owner(r.destination.projectId,r.destination.conversationId),executionId:r.destination.executionId,resourceStepId:r.destination.resourceStepId,sourceChatId:r.custody.sourceChatId};});
    const current=db.prepare('SELECT branch_id FROM branch_executions WHERE id=?').get(reservation.sourceExecutionId) as Row|undefined;
    if(current&&current.branch_id!==reservation.branchId)throw Error('Source owner identity differs');
    entries.set(id,{key:id,value:{admissionId:id,group:Boolean(reservation.resources),state,branchId:reservation.branchId,sourceExecutionId:reservation.sourceExecutionId,sourceOwner:current?'current':'retained_only',checkpointId:reservation.checkpointId,checkpointHash:reservation.checkpointHash,destinations,evidenceSha256:lifecycleHash(evidence)}});
   };
   for(const row of rows('coordination_destination_admissions')){
    const reservation=canonical(row.reservation_json);
    if(reservation.resources){
     const slots=db.prepare('SELECT admission_id,source_chat_id,source_execution_id,conversation_id FROM coordination_destination_group_chats WHERE admission_id=? ORDER BY source_chat_id').all(row.id);
     const expected=reservation.resources.map((r:Row)=>({admission_id:row.id,source_chat_id:r.custody.sourceChatId,source_execution_id:r.custody.intent.executionId,conversation_id:r.destination.conversationId})).sort((a:Row,b:Row)=>a.source_chat_id<b.source_chat_id?-1:1);
     if(stableJson(slots)!==stableJson(expected))throw Error('Destination group slot inventory differs');
    }
    add(row.id,row,reservation,row.state,row);
   }
   for(const tombstone of rows('coordination_destination_retirements')){
    const evidence=canonical(tombstone.evidence_json),reservation=evidence.review?.reservation;
    if(!reservation||tombstone.admission_id!==evidence.row?.id)throw Error('Destination tombstone ownership differs');
    const receipt=context.readRetirement(tombstone.admission_id,Boolean(reservation.resources)) as Row|null;
    if(!receipt||receipt.admissionId!==tombstone.admission_id||receipt.operatorId!=='local-operator'||receipt.reviewHash!==evidence.review.reviewHash)throw Error('Retirement receipt identity differs');
    const current=db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(tombstone.admission_id);
    if(current&&stableJson(current)!==stableJson(evidence.row))throw Error('Retained admission and tombstone differ');
    const prior=entries.get(tombstone.admission_id);if(prior&&prior.value.group!==Boolean(reservation.resources))throw Error('Destination tombstone kind differs');
    add(tombstone.admission_id,evidence.row,reservation,'retired',{tombstone,receipt});
   }
   return page('destinations',[...entries.values()],query);
  })();},
  groupCaptures(query:LifecycleDiscoveryQuery):LifecycleDiscoveryPage<LifecycleGroupCaptureEntry>{return db.transaction(()=>{
   const entries:{key:string;value:LifecycleGroupCaptureEntry}[]=[];
   for(const row of rows('branch_commands',"command_key LIKE 'issued-group-capture:%'")){
    if(readGroupCaptureDisposition(db,row.execution_id,row.command_key,row.result_json))continue;
    const raw=canonical(row.result_json);if(raw.state==='retained')continue;
    const group=context.owner().inspectGroupCapture(row.execution_id,row.command_key);
    const execution=db.prepare('SELECT 1 FROM branch_executions WHERE id=?').get(row.execution_id);
    entries.push({key:stableJson([row.execution_id,row.command_key]),value:{executionId:row.execution_id,captureKey:row.command_key,sources:group.sources,capturedCheckpointIds:group.receipts.map((receipt:CheckpointPackageReceipt)=>receipt.checkpointId),sourceOwner:execution?'current':'retained_only',state:'capturing',evidenceSha256:lifecycleHash(row)}});
   }
   return page('group-captures',entries,query);
  })();},
  captures(query:LifecycleDiscoveryQuery):LifecycleDiscoveryPage<LifecycleCaptureEntry>{return db.transaction(()=>{
   const entries:{key:string;value:LifecycleCaptureEntry}[]=[];
   for(const row of rows('branch_commands',"command_key LIKE 'resource-capture:%' OR command_key LIKE 'issued-resource-capture:%'")){
    const capture=canonical(row.result_json);
    if(!['branch-resource-capture.v1','branch-issued-resource-capture.v1'].includes(capture.schema))throw Error('Unknown capture journal schema remains held');
    const actual=source(capture.source);if(actual.intent.executionId!==row.execution_id)throw Error('Capture original owner differs');
    if(capture.schema==='branch-resource-capture.v1'){
     if(!row.command_key.startsWith('resource-capture:')||row.input_hash!==lifecycleHash(actual))throw Error('Capture intent hash differs');
    }else{
     if(!row.command_key.startsWith('issued-resource-capture:')||row.input_hash!==lifecycleHash({stepId:actual.intent.resourceStepId,generation:actual.intent.resourceGeneration,commandKey:row.command_key.slice('issued-resource-capture:'.length)})
      ||lifecycleHash(capture.snapshot?.hostDependencies)!==actual.intent.hostCutSha256||resourceCaptureFrontierHash(capture.snapshot.selected)!==actual.intent.frontierSha256)throw Error('Issued capture original frontier differs');
    }
    if(context.owner().captureDisposed(row.execution_id,row.command_key,row.result_json)||capture.state!=='capturing')continue;
    const execution=db.prepare('SELECT branch_id FROM branch_executions WHERE id=?').get(row.execution_id) as Row|undefined;
    entries.push({key:stableJson([row.execution_id,row.command_key]),value:{captureKey:row.command_key,source:actual,...(execution?{branchId:execution.branch_id}:{}),sourceOwner:execution?'current':'retained_only',state:'capturing',evidenceSha256:lifecycleHash({row})}});
   }
   return page('captures',entries,query);
  })();},
 };
}
