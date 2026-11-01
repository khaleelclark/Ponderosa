import type Database from 'better-sqlite3';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
type Row=Record<string,any>;
const kind='branch-group-journal-retention';
const retainedKey=(key:string)=>/^(issued-group-(capture|destination):[a-f0-9]{64}|group-custody-abandoned:[a-f0-9]{64})$/.test(key);
const identity=(row:Row)=>stableJson([row.execution_id,row.command_key]);
function evidence(row:Row):Row {
 if(Buffer.byteLength(row.receipt_json)>64*1024*1024)throw Error('Retained group journals exceed bound');
 const value=JSON.parse(row.receipt_json);
 if(stableJson(value)!==row.receipt_json||payloadHash(value)!==row.receipt_sha256||value.schema!=='branch-group-journal-retention.v1'
  ||row.identity!==value.executionId||row.input_json!==stableJson({branchId:value.branchId,executionId:value.executionId})
  ||typeof value.branchId!=='string'||!value.branchId||!Array.isArray(value.commands)||!value.commands.length||value.commands.length>4096
  ||new Set(value.commands.map(identity)).size!==value.commands.length)throw Error('Retained group journal evidence differs');
 for(const command of value.commands){
  if(command.execution_id!==value.executionId||!retainedKey(command.command_key)||!command.created_at||!command.input_hash
   ||typeof command.result_json!=='string'||Buffer.byteLength(command.result_json)>16*1024*1024||stableJson(JSON.parse(command.result_json))!==command.result_json)throw Error('Retained original group command differs');
  const v=JSON.parse(command.result_json),source=command.command_key.startsWith('issued-group-capture:')?v.snapshot?.selected?.execution?.[0]:undefined;
  if(command.command_key.startsWith('issued-group-capture:')&&(source?.id!==value.executionId||source.branch_id!==value.branchId)
   ||command.command_key.startsWith('issued-group-destination:')&&(v.reservation?.sourceExecutionId!==value.executionId||v.reservation.branchId!==value.branchId)
   ||command.command_key.startsWith('group-custody-abandoned:')&&v.input?.executionId!==value.executionId)throw Error('Retained group journal original scope differs');
 }
 return value;
}
/** Exact private journal bytes only. Never restores an owner, command or action authority. */
export function preserveBranchGroupJournals(db:Database.Database,branchId:string):void {
 if(!db.inTransaction)throw Error('Group journal retention requires owner deletion transaction');
 const executions=db.prepare(`SELECT e.id FROM branch_executions e WHERE e.branch_id=? AND EXISTS(SELECT 1 FROM branch_commands c WHERE c.execution_id=e.id AND (c.command_key LIKE 'issued-group-capture:%' OR c.command_key LIKE 'issued-group-destination:%' OR c.command_key LIKE 'group-custody-abandoned:%')) ORDER BY e.id LIMIT 4097`).all(branchId) as Row[];
 if(executions.length>4096)throw Error('Group journal deletion inventory exceeds bound');
 let bytes=0;
 for(const owner of executions){
  const size=db.prepare(`SELECT count(*) count,coalesce(sum(length(CAST(result_json AS BLOB))),0) bytes,coalesce(max(length(CAST(result_json AS BLOB))),0) largest FROM branch_commands WHERE execution_id=? AND (command_key LIKE 'issued-group-capture:%' OR command_key LIKE 'issued-group-destination:%' OR command_key LIKE 'group-custody-abandoned:%')`).get(owner.id) as Row;
  if(size.count>4096||size.largest>16*1024*1024||bytes+size.bytes>64*1024*1024)throw Error('Group journal deletion inventory exceeds bound');
  const commands=db.prepare(`SELECT execution_id,command_key,input_hash,result_json,created_at FROM branch_commands
   WHERE execution_id=? AND (command_key LIKE 'issued-group-capture:%' OR command_key LIKE 'issued-group-destination:%' OR command_key LIKE 'group-custody-abandoned:%') ORDER BY command_key LIMIT 4097`).all(owner.id) as Row[];
  if(!commands.length)continue;
  const value={schema:'branch-group-journal-retention.v1',branchId,executionId:owner.id,commands},input_json=stableJson({branchId,executionId:owner.id}),receipt_json=stableJson(value),receipt_sha256=payloadHash(value);
  bytes+=Buffer.byteLength(receipt_json);if(bytes>64*1024*1024)throw Error('Group journal deletion inventory exceeds byte bound');
  evidence({identity:owner.id,input_json,receipt_json,receipt_sha256});
  const prior=db.prepare('SELECT identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind=? AND identity=?').get(kind,owner.id) as Row|undefined;
  if(prior){evidence(prior);if(prior.input_json!==input_json||prior.receipt_json!==receipt_json||prior.receipt_sha256!==receipt_sha256)throw Error('Retained group journal conflicts with deletion inventory');}
  else db.prepare('INSERT INTO host_lifecycle_commits(kind,identity,input_json,receipt_json,receipt_sha256) VALUES(?,?,?,?,?)').run(kind,owner.id,input_json,receipt_json,receipt_sha256);
 }
}
/** Audit-only lookup. A surviving original must agree with its immutable retained copy. */
export function readGroupAuditJournal(db:Database.Database,executionId:string,commandKey:string):Row|undefined {
 if(!retainedKey(commandKey))throw Error('Exact original group journal key required');
 const current=db.prepare('SELECT execution_id,command_key,input_hash,result_json,created_at FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,commandKey) as Row|undefined;
 const row=db.prepare('SELECT identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind=? AND identity=?').get(kind,executionId) as Row|undefined;
 const retained=row?evidence(row):undefined,original=retained?.commands.find((command:Row)=>command.command_key===commandKey);
 const owner=db.prepare('SELECT branch_id FROM branch_executions WHERE id=?').get(executionId) as Row|undefined;
 if((retained&&owner&&owner.branch_id!==retained.branchId)||(original&&current&&stableJson(original)!==stableJson(current)))throw Error('Current and retained group journals conflict');
 return current??original;
}
/** Bounded combined operator discovery; never used by action or cleanup eligibility readers. */
export function listGroupAuditJournals(db:Database.Database,selection:'captures'|'admissions'):Row[] {
 const prefix=selection==='captures'?'issued-group-capture:':'issued-group-destination:';
 const liveSize=db.prepare('SELECT count(*) count,coalesce(sum(length(CAST(result_json AS BLOB))),0) bytes FROM branch_commands WHERE command_key LIKE ?').get(prefix+'%') as Row;
 const archiveSize=db.prepare('SELECT count(*) count,coalesce(sum(length(CAST(receipt_json AS BLOB))),0) bytes FROM host_lifecycle_commits WHERE kind=?').get(kind) as Row;
 if(liveSize.count>4096||archiveSize.count>4096||liveSize.bytes+archiveSize.bytes>64*1024*1024)throw Error('Group audit discovery exceeds bound');
 const live=db.prepare('SELECT execution_id,command_key,input_hash,result_json,created_at FROM branch_commands WHERE command_key LIKE ? LIMIT 4097').all(prefix+'%') as Row[];
 const rows=new Map(live.map(row=>[identity(row),row]));
 const archives=db.prepare('SELECT identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind=? LIMIT 4097').all(kind) as Row[];
 if(live.length>4096||archives.length>4096)throw Error('Group audit discovery exceeds bound');
 let bytes=live.reduce((sum,row)=>sum+Buffer.byteLength(row.result_json),0);
 if(bytes>64*1024*1024)throw Error('Group audit discovery exceeds byte bound');
 for(const archive of archives){
  bytes+=Buffer.byteLength(archive.receipt_json);if(bytes>64*1024*1024)throw Error('Group audit discovery exceeds byte bound');
  for(const command of evidence(archive).commands)if(command.command_key.startsWith(prefix)){
   const row=readGroupAuditJournal(db,command.execution_id,command.command_key)!;rows.set(identity(row),row);
  }
 }
 if(rows.size>4096)throw Error('Group audit discovery exceeds bound');
 return [...rows.values()].sort((a,b)=>identity(a)<identity(b)?-1:identity(a)>identity(b)?1:0);
}
