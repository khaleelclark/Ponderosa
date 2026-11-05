import type Database from 'better-sqlite3';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {readBranchExpertCopy} from './branch-expert-copy.js';

export interface BranchGenerationExitFenceInput {
 executionId:string;stepExecutionId:string;generation:number;
 projectId:string;conversationId:string;agentIds:string[];
}
/** Same-owner transaction as the initial generation-exit journal; no release operation. */
export function fenceBranchGenerationExit(db:Database.Database,input:BranchGenerationExitFenceInput):{identity:string;sha256:string} {
 return fenceExit(db,input,'retry');
}

/** Separate final admission; never changes the retry entry's eligibility. */
export function fenceBranchFinalResourceExit(db:Database.Database,input:BranchGenerationExitFenceInput):{identity:string;sha256:string} {
 return fenceExit(db,input,'final-resource');
}
/** Exact temporary expert-copy intake fence, independent of native-session outcome. */
export function fenceBranchExpertCopyExit(db:Database.Database,input:BranchGenerationExitFenceInput):{identity:string;sha256:string} {
 return fenceExit(db,input,'expert-copy');
}
function fenceExit(db:Database.Database,input:BranchGenerationExitFenceInput,purpose:'retry'|'final-resource'|'expert-copy') {
 if(!db.inTransaction)throw Error('Generation-exit fence requires the Branch owner transaction');
 const normalized={...input,agentIds:[...input.agentIds].sort()};
 if(!input.executionId||!input.stepExecutionId||!input.projectId||!input.conversationId||!Number.isSafeInteger(input.generation)||input.generation<0||!input.agentIds.length||input.agentIds.length>256||new Set(input.agentIds).size!==input.agentIds.length||input.agentIds.some(id=>!id))throw Error('Exact original generation-exit identities required');
 const identity=payloadHash({executionId:input.executionId,stepExecutionId:input.stepExecutionId,generation:input.generation});
 const prior=db.prepare("SELECT input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind='branch-generation-exit-fence' AND identity=?").get(identity) as {input_json:string;receipt_json:string;receipt_sha256:string}|undefined;
 if(prior){const retained=JSON.parse(prior.receipt_json);
  if(retained.purpose!==undefined&&!['final-resource','expert-copy'].includes(retained.purpose))throw Error('Unknown generation-exit fence purpose');
  if((retained.purpose??'retry')!==purpose)throw Error('Generation-exit fence purpose conflict');
  if(prior.input_json!==stableJson(normalized)||stableJson(retained)!==prior.receipt_json||payloadHash(retained)!==prior.receipt_sha256||stableJson(retained.input)!==prior.input_json)throw Error('Generation-exit fence replay differs');
  if(purpose==='retry')return {identity,sha256:prior.receipt_sha256};
 }
 const eligibility=purpose==='retry'?"r.retry_draining=1":purpose==='expert-copy'?`r.retry_draining=0 AND r.state IN ('active','draining')
  AND (e.cancel_requested=1 OR EXISTS(SELECT 1 FROM branch_paths p WHERE p.id=s.path_id AND p.state='canceled')
   OR NOT EXISTS(SELECT 1 FROM branch_paths p WHERE p.execution_id=e.id AND p.state IN ('active','waiting','joining','canceling')))`:`r.retry_draining=0 AND r.state IN ('active','draining')
  AND e.parent_execution_id IS NULL AND e.parent_attempt_id IS NULL AND e.call_depth=0 AND e.admission_source='manual'
  AND b.enabled=1 AND b.deleting=0 AND b.active_version_id=e.version_id AND b.binding_revision_id=e.binding_revision_id
  AND EXISTS(SELECT 1 FROM branch_versions v WHERE v.id=e.version_id AND v.branch_id=e.branch_id AND json_extract(v.definition_json,'$.trigger.kind')='manual')
  AND COALESCE(json_extract(e.configuration_json,'$.checkpointMode'),'async') IN ('sync','async')
  AND json_extract(e.provenance_json,'$.source')='manual'
  AND (e.cancel_requested=1 OR EXISTS(SELECT 1 FROM branch_paths p WHERE p.id=s.path_id AND p.state='canceled')
   OR NOT EXISTS(SELECT 1 FROM branch_paths p WHERE p.execution_id=e.id AND p.state IN ('active','waiting','joining','canceling')))
  AND NOT EXISTS(SELECT 1 FROM branch_executions child WHERE child.parent_execution_id=e.id)`;
 const resource=db.prepare(`SELECT r.*,e.branch_id AS original_branch_id FROM branch_resources r JOIN branch_step_executions s ON s.id=r.step_execution_id AND s.execution_id=r.execution_id
  JOIN branch_executions e ON e.id=r.execution_id JOIN branches b ON b.id=e.branch_id
  JOIN conversations c ON c.id=r.chat_id AND c.branch_id=e.branch_id AND c.branch_execution_id=e.id
  WHERE r.execution_id=? AND r.step_execution_id=? AND r.generation=? AND r.chat_id=? AND c.project_id=? AND ${eligibility} AND r.state!='retired'`).get(input.executionId,input.stepExecutionId,input.generation,input.conversationId,input.projectId);
 if(!resource)throw Error(purpose==='retry'?'Original retry-draining resource generation required':'Original final resource generation required');
 if(purpose==='final-resource'){
  // The execution configuration is stored canonically, while the Branch can retain
  // the same JSON object in insertion order. Compare values, not textual key order.
  const configs=db.prepare('SELECT b.configuration_json branch_config,e.configuration_json execution_config FROM branch_executions e JOIN branches b ON b.id=e.branch_id WHERE e.id=?').get(input.executionId) as {branch_config:string;execution_config:string}|undefined;
  if(!configs||stableJson(JSON.parse(configs.branch_config))!==stableJson(JSON.parse(configs.execution_config)))throw Error('Final resource configuration changed');
 }
 const members=db.prepare('SELECT * FROM branch_resource_members WHERE step_execution_id=? ORDER BY agent_id').all(input.stepExecutionId) as Array<{agent_id:string}>;
 const actual=db.prepare('SELECT id FROM agents WHERE conversation_id=? AND project_id=? AND deleted_at IS NULL ORDER BY id').all(input.conversationId,input.projectId) as Array<{id:string}>;
 if(stableJson(members.map(m=>m.agent_id).sort())!==stableJson(normalized.agentIds)||stableJson(actual.map(m=>m.id).sort())!==stableJson(normalized.agentIds))throw Error('Complete live original generation member inventory required');
 if(purpose==='final-resource'){
  const operation=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(input.executionId,`resource-operation:${(resource as {creation_key:string}).creation_key}:import`) as {input_hash:string;result_json:string}|undefined;
  const imported=operation&&JSON.parse(operation.result_json);
  const creation=imported?.creationOperationId?db.prepare("SELECT id FROM agent_creation_operations WHERE id=? AND kind='import' AND status='completed' AND project_id=? AND conversation_id=?").get(imported.creationOperationId,input.projectId,input.conversationId):undefined;
  const created=creation?db.prepare('SELECT agent_id FROM agent_creation_operation_members WHERE operation_id=? ORDER BY agent_id').all(imported.creationOperationId) as Array<{agent_id:string}>:[];
  if(!operation||operation.input_hash!==payloadHash({creationKey:(resource as {creation_key:string}).creation_key,phase:'import'})||stableJson(imported)!==operation.result_json||imported.schema!=='branch-resource-operation.v1'||imported.phase!=='import'||!creation||imported.state!=='completed'||stableJson(created.map(m=>m.agent_id))!==stableJson(normalized.agentIds))throw Error('Final resource requires exact completed local creation membership');
 }
 if(purpose==='expert-copy'){
  const expert=readBranchExpertCopy(db,input.executionId,input.stepExecutionId);
  const attempt=expert&&db.prepare('SELECT request_id FROM branch_attempts WHERE id=? AND step_execution_id=?').get(expert.attemptId,input.stepExecutionId) as {request_id:string}|undefined;
  const request=expert&&db.prepare('SELECT recipient_agent_id,conversation_id,project_id,state FROM coordination_requests WHERE id=?').get(expert.requestId) as {recipient_agent_id:string;conversation_id:string;project_id:string;state:string}|undefined;
  const operation=expert&&db.prepare("SELECT id FROM agent_creation_operations WHERE id=? AND kind='import' AND status='completed' AND project_id=? AND conversation_id=?").get(expert.creationOperationId,input.projectId,input.conversationId);
  if(!expert||expert.state!=='active'||expert.copyChatId!==input.conversationId||expert.copyProjectId!==input.projectId||
    !expert.copyAgentId||!normalized.agentIds.includes(expert.copyAgentId)||attempt?.request_id!==expert.requestId||
    request?.recipient_agent_id!==expert.copyAgentId||request.conversation_id!==input.conversationId||request.project_id!==input.projectId||
    !['completed','failed','cancelled','expired','recipient_unavailable'].includes(request.state)||!operation)
    throw Error('Exact completed expert copy ownership required for final capture');
 }
 const evidence={schema:'branch-generation-exit-fence.v1',...(purpose!=='retry'?{purpose}:{}),input:normalized,resource,members};
 const bytes=stableJson(evidence),sha256=payloadHash(evidence);
 if(Buffer.byteLength(bytes)>4*1024*1024)throw Error('Generation-exit fence exceeds bound');
 if(prior){if(prior.receipt_json!==bytes||prior.receipt_sha256!==sha256)throw Error('Final resource fence evidence changed');}
 else db.prepare('INSERT INTO host_lifecycle_commits(kind,identity,input_json,receipt_json,receipt_sha256) VALUES(?,?,?,?,?)').run('branch-generation-exit-fence',identity,stableJson(normalized),bytes,sha256);
 return {identity,sha256};
}

/** SQL expressions are code-owned aliases, never caller text. Durable after Branch deletion. */
export function generationExitHoldSql(agent?:string,conversation?:string):string {
 const a=agent??'NULL',c=conversation??'NULL';
 return `EXISTS(SELECT 1 FROM host_lifecycle_commits generation_exit_fence WHERE generation_exit_fence.kind='branch-generation-exit-fence'
  AND (json_extract(generation_exit_fence.receipt_json,'$.input.conversationId')=${c}
   OR EXISTS(SELECT 1 FROM json_each(generation_exit_fence.receipt_json,'$.input.agentIds') original_member WHERE original_member.value=${a})
   OR EXISTS(SELECT 1 FROM agents original_identity WHERE original_identity.id=${a} AND original_identity.conversation_id=json_extract(generation_exit_fence.receipt_json,'$.input.conversationId'))))`;
}
export function generationExitHeld(db:Database.Database,agentId?:string,conversationId?:string):boolean {
 return Boolean(db.prepare(`SELECT 1 FROM (SELECT ? AS agent_id,? AS conversation_id) identity_scope WHERE ${generationExitHoldSql('identity_scope.agent_id','identity_scope.conversation_id')}`).get(agentId??null,conversationId??null));
}
export function requireGenerationExitOpen(db:Database.Database,agentId?:string,conversationId?:string):void {
 if(generationExitHeld(db,agentId,conversationId))throw Error('Original Branch generation identities are permanently fenced for exit capture');
}
