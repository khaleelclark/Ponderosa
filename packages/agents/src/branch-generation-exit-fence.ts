import type Database from 'better-sqlite3';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';

export interface BranchGenerationExitFenceInput {
 executionId:string;stepExecutionId:string;generation:number;
 projectId:string;conversationId:string;agentIds:string[];
}
/** Same-owner transaction as the initial generation-exit journal; no release operation. */
export function fenceBranchGenerationExit(db:Database.Database,input:BranchGenerationExitFenceInput):{identity:string;sha256:string} {
 if(!db.inTransaction)throw Error('Generation-exit fence requires the Branch owner transaction');
 const normalized={...input,agentIds:[...input.agentIds].sort()};
 if(!input.executionId||!input.stepExecutionId||!input.projectId||!input.conversationId||!Number.isSafeInteger(input.generation)||input.generation<0||!input.agentIds.length||input.agentIds.length>256||new Set(input.agentIds).size!==input.agentIds.length||input.agentIds.some(id=>!id))throw Error('Exact original generation-exit identities required');
 const identity=payloadHash({executionId:input.executionId,stepExecutionId:input.stepExecutionId,generation:input.generation});
 const prior=db.prepare("SELECT input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind='branch-generation-exit-fence' AND identity=?").get(identity) as {input_json:string;receipt_json:string;receipt_sha256:string}|undefined;
 if(prior){const retained=JSON.parse(prior.receipt_json);
  if(prior.input_json!==stableJson(normalized)||stableJson(retained)!==prior.receipt_json||payloadHash(retained)!==prior.receipt_sha256||stableJson(retained.input)!==prior.input_json)throw Error('Generation-exit fence replay differs');
  return {identity,sha256:prior.receipt_sha256};
 }
 const resource=db.prepare(`SELECT r.*,e.branch_id AS original_branch_id FROM branch_resources r JOIN branch_step_executions s ON s.id=r.step_execution_id AND s.execution_id=r.execution_id
  JOIN branch_executions e ON e.id=r.execution_id JOIN branches b ON b.id=e.branch_id
  JOIN conversations c ON c.id=r.chat_id AND c.project_id=b.project_id AND c.branch_id=e.branch_id AND c.branch_execution_id=e.id
  WHERE r.execution_id=? AND r.step_execution_id=? AND r.generation=? AND r.chat_id=? AND b.project_id=? AND r.retry_draining=1 AND r.state!='retired'`).get(input.executionId,input.stepExecutionId,input.generation,input.conversationId,input.projectId);
 if(!resource)throw Error('Original retry-draining resource generation required');
 const members=db.prepare('SELECT * FROM branch_resource_members WHERE step_execution_id=? ORDER BY agent_id').all(input.stepExecutionId) as Array<{agent_id:string}>;
 const actual=db.prepare('SELECT id FROM agents WHERE conversation_id=? AND project_id=? AND deleted_at IS NULL ORDER BY id').all(input.conversationId,input.projectId) as Array<{id:string}>;
 if(stableJson(members.map(m=>m.agent_id).sort())!==stableJson(normalized.agentIds)||stableJson(actual.map(m=>m.id).sort())!==stableJson(normalized.agentIds))throw Error('Complete live original generation member inventory required');
 const evidence={schema:'branch-generation-exit-fence.v1',input:normalized,resource,members};
 const bytes=stableJson(evidence),sha256=payloadHash(evidence);
 if(Buffer.byteLength(bytes)>4*1024*1024)throw Error('Generation-exit fence exceeds bound');
 db.prepare('INSERT INTO host_lifecycle_commits(kind,identity,input_json,receipt_json,receipt_sha256) VALUES(?,?,?,?,?)').run('branch-generation-exit-fence',identity,stableJson(normalized),bytes,sha256);
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
