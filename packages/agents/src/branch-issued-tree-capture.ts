import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import type {CheckpointPackageReceipt,CheckpointPackageSource} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {selectBranchUnit} from './branch-unit-selection.js';
import {encodeScriptTreeContinuation,issuedScriptTreeSupported,treeIds,treeIdMapSupported} from './branch-tree-continuation.js';
import {retainedBranchHostGraph} from './branch-tree-host-cut.js';
import {resourceCaptureFrontierHash,receiptMatchesSource} from './branch-resource-capture.js';
type Row=Record<string,any>;
const key=(command:string)=>`issued-tree-capture:${payloadHash(command)}`;
const commandRequired=(command:string)=>{if(typeof command!=='string'||!command.trim()||command.length>200)throw Error('Exact tree capture command required');};
/** Every owner remains individually pinned and drained; the root never owns child custody. */
function currentOwners(db:Database.Database,c:Row):void {
 for(const o of c.owners){
  const e=o.selected.execution[0],row=db.prepare(`SELECT b.enabled,b.deleting,b.active_version_id,b.binding_revision_id,b.configuration_json current_configuration,e.configuration_json
   FROM branch_executions e JOIN branches b ON b.id=e.branch_id WHERE e.id=?`).get(o.executionId) as Row|undefined;
  if(!row?.enabled||row.deleting||row.active_version_id!==o.versionId||row.binding_revision_id!==o.bindingRevisionId||row.current_configuration!==row.configuration_json)throw Error('Current tree owner pins unavailable');
  const r=o.selected.resources[0],ids=JSON.parse(r.import_operation_json).result.agentIds;
  if(!db.prepare('SELECT 1 FROM conversations WHERE id=? AND branch_id=?').get(r.chat_id,e.branch_id))throw Error('Tree resource Chat owner differs');
  for(const id of ids)if(!db.prepare('SELECT 1 FROM agents WHERE id=? AND conversation_id=? AND deleted_at IS NULL').get(id,r.chat_id)
   ||db.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running','outcome_unknown') UNION ALL SELECT 1 FROM provider_process_authority WHERE agent_id=? UNION ALL SELECT 1 FROM agent_deletion_pending WHERE agent_id=? LIMIT 1").get(id,id,id))throw Error('Tree participants require observed drain');
 }
}
function inventory(snapshot:Row):Row[] {
 const c=snapshot.continuation;
 if(snapshot.schema!=='branch-unit-selected.v2'||snapshot.captureKind!=='issued_tree_group'||snapshot.restore_supported!==false||c?.issuedResources!==true
  ||c.owners?.length!==2||c.rootExecutionId!==snapshot.selected?.execution?.[0]?.id)throw Error('Bounded issued owner tree required');
 const graph=retainedBranchHostGraph(snapshot,c.rootExecutionId,true,true);
 if(graph.owners.length!==2||c.owners.some((o:Row)=>o.selected.resources.length!==1))throw Error('One issued resource per owner required');
 const resources=c.owners.map((o:Row)=>({owner:o,resource:o.selected.resources[0]}));
 if(new Set(resources.map((x:Row)=>x.resource.chat_id)).size!==2||new Set(resources.map((x:Row)=>x.resource.step_execution_id)).size!==2
  ||new Set(resources.flatMap((x:Row)=>JSON.parse(x.resource.import_operation_json).result.agentIds)).size!==resources.reduce((n:number,x:Row)=>n+JSON.parse(x.resource.import_operation_json).result.agentIds.length,0))throw Error('Tree resource identities alias');
 return resources;
}
function sourceMatches(snapshot:Row,sources:CheckpointPackageSource[],receipts:CheckpointPackageReceipt[]):void {
 const resources=inventory(snapshot);
 if(sources.length!==2||new Set(sources.map(s=>s.checkpointId)).size!==2||new Set(sources.map(s=>s.intent.resourceStepId)).size!==2
  ||receipts.length>2||new Set(receipts.map(r=>r.checkpointId)).size!==receipts.length)throw Error('Tree custody inventory differs');
 for(const {owner:o,resource:r} of resources){
  const source=sources.find(s=>s.intent.resourceStepId===r.step_execution_id);
  if(!source||source.intent.executionId!==o.executionId||source.sourceChatId!==r.chat_id||source.intent.resourceGeneration!==0
   ||source.intent.frontierSha256!==resourceCaptureFrontierHash(o.selected)||source.intent.hostCutSha256!==payloadHash(o.hostDependencies)
   ||source.intent.bindingSha256!==o.bindingHash||source.intent.configurationSha256!==payloadHash(o.configuration)
   ||stableJson(source.agentIds)!==stableJson(JSON.parse(r.import_operation_json).result.agentIds))throw Error('Tree per-owner custody differs');
 }
 if(receipts.some(receipt=>!sources.some(source=>receiptMatchesSource(receipt,source))))throw Error('Tree custody receipt differs');
}
export function previewIssuedTreeCapture(db:Database.Database,executionId:string){
 if(!db.inTransaction)throw Error('Tree preview requires owner read transaction');
 const selected=selectBranchUnit(db,executionId),continuation=encodeScriptTreeContinuation(db,executionId,selected,true);
 if(!continuation||continuation.owners.length!==2)throw Error('Replayable parent and called child required');
 const root=continuation.owners.find((o:Row)=>o.executionId===executionId)!;
 const snapshot={schema:'branch-unit-selected.v2',captureKind:'issued_tree_group',restore_supported:false,selected,hostDependencies:root.hostDependencies,continuation};
 const resources=inventory(snapshot);currentOwners(db,continuation);
 return {snapshot,reviewHash:payloadHash(snapshot),versionId:root.versionId,resources:resources.map(({owner:o,resource:r})=>({executionId:o.executionId,branchId:o.selected.execution[0].branch_id,resourceStepId:r.step_execution_id,sourceChatId:r.chat_id,agentIds:JSON.parse(r.import_operation_json).result.agentIds as string[]}))};
}
/** Source readback only. Retained proof never grants restore/admission. */
export function readIssuedTreeCapture(db:Database.Database,executionId:string,command:string):Row|undefined {
 commandRequired(command);
 const row=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,key(command)) as Row|undefined;
 if(!row)return;
 const v=JSON.parse(row.result_json);
 if(stableJson(v)!==row.result_json||row.input_hash!==payloadHash({commandKey:command})||v.commandKey!==command||v.reviewHash!==payloadHash(v.snapshot)
  ||v.snapshot.continuation.rootExecutionId!==executionId||v.versionId!==v.snapshot.selected.execution[0].version_id||!['capturing','retained'].includes(v.state)
  ||!Array.isArray(v.sources)||!Array.isArray(v.receipts)||v.state==='capturing'&&v.receipts.length===2)throw Error('Tree capture journal differs');
 sourceMatches(v.snapshot,v.sources,v.receipts);
 if(!issuedScriptTreeSupported(db,v.snapshot.continuation))throw Error('Tree executable evidence differs');
 if(v.state==='retained'){
  const snapshot={...v.snapshot,issuedGroupCustody:v.sources.map((s:Row)=>v.receipts.find((r:Row)=>r.checkpointId===s.checkpointId))};
  const cp=db.prepare('SELECT execution_id,snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=?').get(v.checkpointId) as Row|undefined;
  if(v.receipts.length!==2||!cp||cp.execution_id!==executionId||cp.content_hash!==v.checkpointHash||payloadHash(snapshot)!==v.checkpointHash||stableJson(snapshot)!==cp.snapshot_json)throw Error('Tree sealed checkpoint differs');
 }
 return v;
}
export function reserveIssuedTreeCapture(db:Database.Database,executionId:string,command:string,expected:{reviewHash:string;versionId:string}):Row {
 if(!db.inTransaction)throw Error('Tree reserve requires owner transaction');commandRequired(command);
 const old=readIssuedTreeCapture(db,executionId,command);
 if(old){if(old.reviewHash!==expected.reviewHash||old.versionId!==expected.versionId)throw Error('Tree command preview conflict');return old;}
 const preview=previewIssuedTreeCapture(db,executionId);
 if(preview.reviewHash!==expected.reviewHash||preview.versionId!==expected.versionId)throw Error('Tree preview changed');
 const sources:CheckpointPackageSource[]=inventory(preview.snapshot).map(({owner:o,resource:r})=>({checkpointId:randomUUID(),sourceChatId:r.chat_id,agentIds:JSON.parse(r.import_operation_json).result.agentIds,
  intent:{executionId:o.executionId,resourceStepId:r.step_execution_id,resourceGeneration:0,frontierSha256:resourceCaptureFrontierHash(o.selected),hostCutSha256:payloadHash(o.hostDependencies),bindingSha256:o.bindingHash,configurationSha256:payloadHash(o.configuration)}}));
 const v={commandKey:command,reviewHash:preview.reviewHash,versionId:preview.versionId,state:'capturing',snapshot:preview.snapshot,sources,receipts:[]};
 db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(executionId,key(command),payloadHash({commandKey:command}),stableJson(v),new Date().toISOString());return v;
}
export function sealIssuedTreeMember(db:Database.Database,executionId:string,command:string,receipt:CheckpointPackageReceipt):void {
 if(!db.inTransaction)throw Error('Tree seal requires same owner transaction');
 const v=readIssuedTreeCapture(db,executionId,command);if(!v)throw Error('Tree capture intent unavailable');
 const source=v.sources.find((s:CheckpointPackageSource)=>receiptMatchesSource(receipt,s));if(!source)throw Error('Tree receipt differs');
 const old=v.receipts.find((r:Row)=>r.checkpointId===receipt.checkpointId);
 if(old){if(stableJson(old)!==stableJson(receipt))throw Error('Tree receipt conflict');return;}
 const live=previewIssuedTreeCapture(db,executionId);
 if(live.reviewHash!==v.reviewHash||stableJson(live.snapshot)!==stableJson(v.snapshot))throw Error('Tree selected frontier changed');
 v.receipts.push(receipt);
 if(v.receipts.length===2){
  const snapshot={...v.snapshot,issuedGroupCustody:v.sources.map((s:Row)=>v.receipts.find((r:Row)=>r.checkpointId===s.checkpointId))},bytes=stableJson(snapshot);
  const cp=db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(executionId,bytes,payloadHash(snapshot));
  v.state='retained';v.checkpointId=Number(cp.lastInsertRowid);v.checkpointHash=payloadHash(snapshot);
 }
 db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?').run(stableJson(v),executionId,key(command));
}
/** Prospective maps only: no acceptance, budget, graph write or imported identity is created here. */
export function issuedTreeFreshOwnerMap(db:Database.Database,executionId:string,command:string){
 const v=readIssuedTreeCapture(db,executionId,command);if(v?.state!=='retained')throw Error('Complete retained tree required');
 const c=v.snapshot.continuation,idMap=Object.fromEntries(treeIds(c.owners).map(id=>[id,randomUUID()]));
 const graph=retainedBranchHostGraph(v.snapshot,executionId,true,true),requestMap=Object.fromEntries(graph.cut.requests.map(x=>[x.row.id,randomUUID()]));
 if(!treeIdMapSupported(c.owners,idMap,executionId,idMap[executionId]!))throw Error('Fresh tree map differs');
 return {currentAuthority:false as const,actionEligible:false as const,idMap,requestMap,owners:c.owners.map((o:Row)=>{
  const e=o.selected.execution[0],r=o.selected.resources[0];
  return {sourceExecutionId:o.executionId,executionId:idMap[o.executionId],branchId:e.branch_id,parentExecutionId:e.parent_execution_id?idMap[e.parent_execution_id]:null,parentAttemptId:e.parent_attempt_id?idMap[e.parent_attempt_id]:null,
   sourceChatId:r.chat_id,conversationId:randomUUID(),resourceStepId:idMap[r.step_execution_id],agentMap:Object.fromEntries(JSON.parse(r.import_operation_json).result.agentIds.map((id:string)=>[id,randomUUID()]))};
 })};
}

/** Exact checkpoint reader shared by the existing group consumer. Ownership stays per owner. */
export function readIssuedTreeCheckpoint(db:Database.Database,executionId:string,checkpointId:number,expectedHash:string):Row {
 const row=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE execution_id=? AND id=?').get(executionId,checkpointId) as Row|undefined;
 if(!row||row.content_hash!==expectedHash)throw Error('Issued tree checkpoint unavailable');
 const s=JSON.parse(row.snapshot_json);
 if(stableJson(s)!==row.snapshot_json||payloadHash(s)!==expectedHash||s.continuation?.rootExecutionId!==executionId||!issuedScriptTreeSupported(db,s.continuation))throw Error('Issued tree checkpoint integrity/replay differs');
 const receipts=s.issuedGroupCustody as CheckpointPackageReceipt[];
 if(!Array.isArray(receipts)||receipts.length!==2)throw Error('Complete issued tree custody required');
 sourceMatches(s,receipts.map(({version,custodyId,boundaryId,sha256,byteLength,...source})=>source),receipts);
 return s;
}
