import type Database from 'better-sqlite3';
import type {BranchCustodyLifecycle} from '@ponderosa/agents';
import type {CheckpointPackageSource} from '@ponderosa/core';

/** Conservative reference inventory. Audit copies are retained unless their canonical owner retires them. */
export function custodyLifecycleProof(db:Database.Database,source:CheckpointPackageSource|undefined,id:string,owner?:BranchCustodyLifecycle){
 const references:string[]=[],blockers:string[]=[];
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'branch_%' OR name LIKE 'coordination_destination_%' OR name='coordination_cut_restorations') ORDER BY name").all() as {name:string}[];
 if(source&&owner){
  const exact:CheckpointPackageSource={checkpointId:source.checkpointId,sourceChatId:source.sourceChatId,agentIds:source.agentIds,intent:source.intent};
  const current=owner.inspect(exact);
  references.push(...current.references.map(ref=>`${ref.kind}:${ref.ownerId}:${ref.key}:${ref.sha256}`));
  blockers.push(...current.blockers);
 }
 for(const {name}of tables){
  // Canonical Branch hooks distinguish executable pins from validated audit dispositions.
  if(source&&owner&&name!=='coordination_cut_restorations')continue;
  if(!/^[a-z0-9_]+$/.test(name))throw Error('Unknown custody reference schema');
  const columns=(db.prepare(`PRAGMA table_info(${name})`).all() as {name:string;type:string}[]).filter(column=>/TEXT/i.test(column.type)&&/json|receipt|capture|checkpoint/i.test(column.name));
  if(columns.some(column=>!/^[a-z0-9_]+$/.test(column.name)))throw Error('Unknown custody reference column');
  for(const column of columns){
   const keys=[id,...(source?.checkpointId?[source.checkpointId]:[])];
   if(keys.some(key=>db.prepare(`SELECT 1 FROM ${name} WHERE instr(${column.name},?)>0 LIMIT 1`).get(key))){references.push(`${name}.${column.name}`);break;}
  }
 }
 if(source){
  const execution=db.prepare('SELECT state FROM branch_executions WHERE id=?').get(source.intent.executionId) as {state:string}|undefined;
  if(execution&&!['completed','failed','canceled'].includes(execution.state))blockers.push('Source execution is not terminal');
  for(const id of source.agentIds){
   if(db.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running','outcome_unknown') UNION ALL SELECT 1 FROM provider_process_authority WHERE agent_id=? UNION ALL SELECT 1 FROM agent_activations WHERE agent_id=? AND state IN ('pending','attached','retry_pending','outcome_unknown') LIMIT 1").get(id,id,id))blockers.push(`Source Agent ${id} has undrained runtime authority`);
   if(db.prepare("SELECT 1 FROM agent_creation_operation_members m JOIN agent_creation_operations o ON o.id=m.operation_id WHERE m.agent_id=? AND o.status NOT IN ('completed','rolled_back') LIMIT 1").get(id))blockers.push(`Source Agent ${id} has unresolved creation custody`);
  }
 }
 return {references,blockers};
}
