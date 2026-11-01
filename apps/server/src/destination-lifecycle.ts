import path from 'node:path';
import fs from '@ponderosa/native-host/fs';
import {sourceMutationState,stableJson,type AgentStore,type BranchCustodyLifecycle,type CoordinationV3Store,type CoordinationDestinationReconciliationAuthority} from '@ponderosa/agents';
import type {CoordinationDestinationStage,DestinationRetirementChoice,DestinationRetirementApprovalDto,DestinationRetirementReviewDto} from '@ponderosa/core';
import {lifecycleHash,lifecycleJournal} from './lifecycle-journal.js';
type Row=Record<string,any>;
const OPERATOR='local-operator';
const terminalRequest="'completed','failed','blocked','cancelled','expired','recipient_unavailable','superseded'";
/** Bounded metadata inventory, including quarantined records: malformed evidence never means absent. */
function metadata(directory:string):{name:string;sha256:string;value:Row}[]{
 if(!fs.existsSync(directory))return [];
 const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Lifecycle inventory directory differs');
 const names=fs.readdirSync(directory).sort();if(names.length>4096)throw Error('Lifecycle metadata inventory exceeds bound');
 const result:{name:string;sha256:string;value:Row}[]=[];let total=0;
 for(const name of names){
  if(name.includes('.corrupt'))throw Error('Quarantined import metadata requires reconciliation');
  if(!name.endsWith('.json'))continue;
  const file=path.join(directory,name),before=fs.lstatSync(file);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>4*1024*1024)throw Error('Unrecognized lifecycle metadata');
  total+=before.size;if(total>16*1024*1024)throw Error('Lifecycle metadata bytes exceed review bound');
  const bytes=fs.readFileSync(file,'utf8'),value=JSON.parse(bytes),after=fs.lstatSync(file);
  if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('Lifecycle metadata changed');
  result.push({name,sha256:lifecycleHash(value),value});
 }
 return result;
}
const contains=(value:unknown,keys:string[])=>keys.some(key=>stableJson(value).includes(key));
export function destinationLifecycle(context:{dataDir:string;store:AgentStore;coordination:CoordinationV3Store;owner:()=>BranchCustodyLifecycle;runtimeIdle:(ids:string[],projectId:string)=>boolean;creationLeases:ReadonlyMap<string,number>}){
 const db=context.store.sqlite,journal=lifecycleJournal(path.join(context.dataDir,'destination-lifecycle-approvals'),db);
 const authority=(id:string):CoordinationDestinationReconciliationAuthority=>({
  inspect({operatorId,reservation,stage}){
   if(operatorId!==OPERATOR||reservation.operatorId!==OPERATOR)throw Error('Current local operator ownership required');
   const row=db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(id) as Row|undefined;
   if(!row||row.conversation_id!==reservation.destination.conversationId||row.project_id!==reservation.destination.projectId||stableJson(reservation)!==row.reservation_json)throw Error('Exact destination ownership differs');
   const project=context.store.getProject(row.project_id),deletedProject=db.prepare('SELECT * FROM project_deletion_receipts WHERE project_id=?').get(row.project_id) as Row|undefined;
   if(!project&&(!deletedProject||deletedProject.storage_cleanup_completed!==1||deletedProject.draft_cleanup_completed!==1||deletedProject.asset_authority_cleanup_completed!==1||!deletedProject.completed_at))throw Error('Current or completed deleted-Project operator authority required');
   if(project&&db.prepare('SELECT 1 FROM project_deletion_pending WHERE project_id=?').get(row.project_id))throw Error('Project deletion is unsettled');
   const chat=db.prepare('SELECT * FROM conversation_deletion_receipts WHERE conversation_id=?').get(row.conversation_id) as Row|undefined;
   // Completed canonical deletion is durable host evidence, not an operator assertion of provider exit.
   if(!chat||chat.project_id!==row.project_id||chat.canonical_deletion_completed!==1||chat.storage_cleanup_completed!==1||chat.server_cleanup_completed!==1)throw Error('Destination Chat deletion/cleanup must be canonically observed');
   const members=db.prepare('SELECT * FROM coordination_destination_members WHERE admission_id=? ORDER BY agent_id').all(id) as Row[];
   const tombstones=db.prepare('SELECT * FROM agent_deletion_tombstones WHERE conversation_id=? ORDER BY agent_id').all(row.conversation_id) as Row[];
   const ids=[...new Set([...members.map(member=>member.agent_id),...tombstones.map(tombstone=>tombstone.agent_id)])].sort();
   const plan=(stage as CoordinationDestinationStage|null)?.importPlan;
   if(plan&&(plan.projectId!==row.project_id||plan.conversationId!==row.conversation_id||stableJson([...plan.agents.map(a=>a.agentId)].sort())!==stableJson(members.map(member=>member.agent_id).sort())))throw Error('Destination member inventory differs from staged import');
   const deletions:Row[]=[];
   for(const agentId of ids){
    const receipts=db.prepare('SELECT r.* FROM agent_deletion_receipts r,json_each(r.deleted_agent_ids_json) m WHERE m.value=? ORDER BY r.id').all(agentId) as Row[];
    if(!receipts.length||receipts.some(r=>r.project_id!==row.project_id||r.storage_cleanup_completed!==1||r.server_cleanup_completed!==1))throw Error('Destination Agent observed runtime/storage drain receipt missing');
    deletions.push(...receipts);
    if(db.prepare(`SELECT 1 FROM provider_process_authority WHERE agent_id=? UNION ALL SELECT 1 FROM agent_deletion_pending WHERE agent_id=?
     UNION ALL SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running','outcome_unknown')
     UNION ALL SELECT 1 FROM agent_activations WHERE agent_id=? AND state IN ('pending','attached','retry_pending','outcome_unknown')
     UNION ALL SELECT 1 FROM coordination_requests WHERE (requester_agent_id=? OR recipient_agent_id=?) AND state NOT IN (${terminalRequest}) LIMIT 1`).get(agentId,agentId,agentId,agentId,agentId,agentId))throw Error('Destination runtime or external request outcomes remain unresolved');
   }
   if(db.prepare(`SELECT 1 FROM coordination_requests WHERE conversation_id=? AND state NOT IN (${terminalRequest})
    UNION ALL SELECT 1 FROM coordination_joins WHERE conversation_id=? AND state='open' LIMIT 1`).get(row.conversation_id,row.conversation_id))throw Error('Destination Chat request/join effects remain unresolved');
   const execution=db.prepare('SELECT * FROM branch_executions WHERE id=?').get(reservation.destination.executionId) as Row|undefined;
   if(execution&&!['completed','failed','canceled'].includes(execution.state))throw Error('Destination owner execution must settle');
   if(db.prepare(`WITH RECURSIVE owned(id) AS (SELECT ? UNION SELECT e.id FROM branch_executions e JOIN owned p ON e.parent_execution_id=p.id)
    SELECT 1 FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id IN (SELECT id FROM owned)
     AND (a.state IN ('prepared','waiting','leased','running','outcome_unknown') OR a.process_identity_json IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM branch_checkpoints p WHERE p.execution_id=s.execution_id AND p.kind='script_process_exit' AND p.transition_key='process-exit:'||a.id||':'||a.fence)) LIMIT 1`).get(reservation.destination.executionId))throw Error('Destination native/effect outcome not observed');
   const destinationCommands=db.prepare('SELECT command_key,result_json FROM branch_commands WHERE execution_id=? ORDER BY command_key').all(reservation.destination.executionId) as Row[];
   for(const command of destinationCommands)if(command.command_key.startsWith('resource-operation:')&&['running','unknown'].includes(JSON.parse(command.result_json).state))throw Error('Destination resource effect remains unresolved');
   if((context.creationLeases.get(row.conversation_id)??0)>0||!context.runtimeIdle(ids,row.project_id))throw Error('Destination live provider/import authority remains');
   const mutation=sourceMutationState();if(mutation.activeWriters||mutation.activeCaptures||mutation.uncertainWriters)throw Error('Host source/effect registry remains unsettled');
   const operations=db.prepare('SELECT * FROM agent_creation_operations WHERE conversation_id=? ORDER BY id').all(row.conversation_id) as Row[];
   if(operations.some(op=>op.status!=='rolled_back')||plan&&!operations.some(op=>op.id===plan.creationOperationId))throw Error('Destination import outcomes must have exact rollback receipts');
   const imports=metadata(path.join(context.dataDir,'agent-import-operations'));
   for(const entry of imports){const operation=entry.value;
    if(/^[a-f0-9-]{36}\.json$/.test(entry.name)&&(operation.id!==entry.name.slice(0,-5)||typeof operation.conversationId!=='string'||!['pending','failed','completed'].includes(operation.status)))throw Error('Unrecognized background import record');
    if(operation.conversationId!==row.conversation_id)continue;
    if(operation.status!=='failed'||operation.result||!operations.some(op=>op.idempotency_key===operation.requestId&&op.status==='rolled_back'))throw Error('Background destination import effects remain unresolved');
   }
   const source={checkpointId:reservation.custody.checkpointId,sourceChatId:reservation.custody.sourceChatId,agentIds:reservation.custody.agentIds,intent:reservation.custody.intent};
   const branch=context.owner().inspect(source),references=branch.references.filter(ref=>ref.kind!=='admission'||ref.key!==id).map(ref=>`${ref.kind}:${ref.ownerId}:${ref.key}:${ref.sha256}`);
   const packages=metadata(path.join(context.dataDir,'checkpoint-package-custody'));
   for(const pkg of packages){if(contains(pkg.value,[row.conversation_id,...ids]))references.push(`package:${pkg.name}:${pkg.sha256}`);}
   const needles=[reservation.custody.checkpointId,reservation.custody.custodyId,row.conversation_id,...ids];
   // Keep every cross-owner restore/command reference. Only the admission's own rows are excluded.
   for(const table of ['branch_commands','coordination_cut_restorations']){
    const columns=(db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).filter(c=>/TEXT/i.test(c.type)&&/json/.test(c.name));
    const lengths=columns.map(column=>{if(!/^[a-z0-9_]+$/.test(column.name))throw Error('Unknown canonical reference column');return `COALESCE(length(${column.name}),0)`;}).join('+')||'0';
    const size=db.prepare(`SELECT count(*) count,COALESCE(sum(${lengths}),0) bytes FROM ${table}`).get() as {count:number;bytes:number};if(size.count>4096||size.bytes>16*1024*1024)throw Error('Canonical lifecycle reference inventory exceeds bound');
    const rows=db.prepare(`SELECT rowid,* FROM ${table} LIMIT 4097`).all() as Row[];if(rows.length>4096)throw Error('Canonical lifecycle reference inventory exceeds bound');
    for(const candidate of rows)for(const column of columns){if(!/^[a-z0-9_]+$/.test(column.name))throw Error('Unknown canonical reference column');const bytes=candidate[column.name];if(bytes===null)continue;
     const value=JSON.parse(bytes);if(contains(value,needles))references.push(`${table}:${candidate.rowid}:${column.name}:${lifecycleHash(value)}`);
    }
   }
   return {revision:lifecycleHash({reservation,stage,project:project??null,deletedProject:deletedProject??null,chat,members,tombstones,deletions,operations,execution:execution??null,destinationCommands,branch,packages,imports,mutation}),references:[...new Set(references)].sort()};
  },
  requireApproval(input,review){const saved=journal.read(`approval:${id}:${input.commandKey}`);
   const exact={commandKey:input.commandKey,expectedReviewHash:input.expectedReviewHash,releaseSourcePins:input.releaseSourcePins,authorizeDeletedOwner:true};
   if(!saved||saved.admissionId!==id||saved.operatorId!==OPERATOR||stableJson(saved.choice)!==stableJson(exact)||saved.reviewHash!==review.reviewHash)throw Error('Durable exact human retirement approval required');
  },
 });
 const review=(id:string)=>context.coordination.reviewCoordinationDestinationReconciliation(id,OPERATOR,authority(id));
 return {
  review(id:string):DestinationRetirementReviewDto{return db.transaction(()=>{const current=review(id);return {...current,preserveOnlyPermanent:true as const,globalRuntimeQuiescenceRequired:true as const,canReleaseSourcePins:current.references.length===0};})();},
  approve(id:string,choice:DestinationRetirementChoice):DestinationRetirementApprovalDto{return db.transaction(()=>{
   if(!choice.commandKey||choice.commandKey.length>200||!/^[a-f0-9]{64}$/.test(choice.expectedReviewHash)||typeof choice.releaseSourcePins!=='boolean'||choice.authorizeDeletedOwner!==true)throw Error('Explicit exact retirement disposition required');
   const current=review(id);if(current.reviewHash!==choice.expectedReviewHash)throw Error('Destination review changed');
   if(choice.releaseSourcePins&&current.references.length)throw Error('Destination source pins remain referenced');
   const decision:DestinationRetirementApprovalDto={admissionId:id,operatorId:OPERATOR,choice,reviewHash:current.reviewHash};journal.write(`approval:${id}:${choice.commandKey}`,decision);return decision;
  }).immediate();},
  retire(id:string,choice:DestinationRetirementChoice){return db.transaction(()=>{
   const input={admissionId:id,commandKey:choice.commandKey,operatorId:OPERATOR,expectedReviewHash:choice.expectedReviewHash,releaseSourcePins:choice.releaseSourcePins};
   if(choice.authorizeDeletedOwner!==true)throw Error('Explicit deleted-owner disposition required');
   return context.coordination.retireCoordinationDestination(input,authority(id));
  }).immediate();},
  receipt:(id:string)=>context.coordination.readCoordinationDestinationRetirement(id),
 };
}
