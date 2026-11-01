import type Database from 'better-sqlite3';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import type {Selected} from './branch-script-continuation.js';
type Row=Record<string,any>;
type Evidence={row:Row;sha256:string};
export interface BranchHostCut {
 schema:'ponderosa.branch.host-dependencies.v1';executionId:string;
 restoreAuthority:'fresh_admission_required';nativeState:'not_captured';artifactStorage:'references_only';
 roots:{attemptId:string;requestId:string|null;recoveryOfRequestId:string|null}[];
 coverage:{complete:boolean;missingReferences:{kind:string;id:string}[];requestVersions:{requestId:string;version:number;updatePrefixComplete:boolean}[]};
 requests:Evidence[];updates:Evidence[];lateResults:Evidence[];joins:Evidence[];members:Evidence[];suspensions:Evidence[];communications:Evidence[];joinOutcomes:Evidence[];artifactRefs:Evidence[];
 resources:Evidence[];resourceMembers:Evidence[];resourceContexts:Evidence[];resourceReceipts:Evidence[];
 bindingPin:{revisionId:string;sha256:string;requiredSecretRefs:string[]};
}
const envelope=(row:Row):Evidence=>({row,sha256:payloadHash(row)});
/** Called inside the same owner transaction as the selected frontier, never from UI projections. */
export function captureBranchHostCut(db:Database.Database,id:string,selected:Selected):BranchHostCut|undefined {
 if(!db.inTransaction)throw Error('Host dependency capture requires the owner transaction');
 const roots=selected.attempts!.filter(a=>a.request_id||a.recovery_of_request_id).map(a=>({attemptId:a.id,requestId:a.request_id,recoveryOfRequestId:a.recovery_of_request_id}));
 if(!roots.length&&!selected.resources!.length)return;
 for(const root of roots){const owner=db.prepare('SELECT a.request_id,a.recovery_of_request_id FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE a.id=? AND s.execution_id=?').get(root.attemptId,id) as Row|undefined;if(!owner||owner.request_id!==root.requestId||owner.recovery_of_request_id!==root.recoveryOfRequestId)throw Error('Host Request root differs from its owned attempt');}
 const missingReferences:{kind:string;id:string}[]=[],requestVersions:{requestId:string;version:number;updatePrefixComplete:boolean}[]=[];
 const pin=db.prepare(`SELECT e.binding_revision_id,e.configuration_json,b.bindings_json,b.content_hash,w.id AS branch_id,c.project_id,c.id AS chat_id
  FROM branch_executions e JOIN branch_bindings b ON b.id=e.binding_revision_id JOIN branches w ON w.id=e.branch_id LEFT JOIN conversations c ON c.id=w.chat_id WHERE e.id=?`).get(id) as Row|undefined;
 if(!pin||payloadHash(JSON.parse(pin.bindings_json))!==pin.content_hash)throw Error('Host cut owner pins unavailable');
 // A dependency edge cannot grant access to another participant's private Requests.
 const participants=new Set<string>(),scopes=new Set<string>();
 for(const root of roots)for(const ref of [root.requestId,root.recoveryOfRequestId])if(ref){
  const row=db.prepare('SELECT requester_agent_id,recipient_agent_id,project_id,conversation_id FROM coordination_requests WHERE id=?').get(ref) as Row|undefined;
  if(row){const chat=db.prepare('SELECT project_id,branch_id FROM conversations WHERE id=?').get(row.conversation_id) as Row|undefined;
   if(!chat||chat.project_id!==row.project_id||chat.branch_id!==pin.branch_id&&row.conversation_id!==pin.chat_id)throw Error('Host root lacks its owned Chat scope');
   scopes.add(stableJson([row.project_id,row.conversation_id]));for(const agent of [row.requester_agent_id,row.recipient_agent_id])if(agent)participants.add(agent);
  }
 }
 const requests=new Map<string,Row>(),joins=new Map<string,Row>(),members=new Map<string,Row>(),updates=new Map<string,Row>(),lateResults=new Map<string,Row>(),suspensions=new Map<string,Row>(),communications=new Map<string,Row>(),joinOutcomes=new Map<string,Row>(),artifactRefs=new Map<string,Row>();
 const pendingRequests=new Set<string>(roots.flatMap(root=>[...(root.requestId?[root.requestId]:[]),...(root.recoveryOfRequestId?[root.recoveryOfRequestId]:[])])),pendingJoins=new Set<string>();
 const parse=(bytes:string)=>{const value=JSON.parse(bytes);if(stableJson(value)!==bytes)throw Error('Noncanonical host dependency bytes');return value;};
 const scoped=(row:Row)=>{if(!scopes.has(stableJson([row.project_id,row.conversation_id])))throw Error('Host dependency escapes its Project or lacks explicit Chat scope');};
 while(pendingRequests.size||pendingJoins.size){
  if(updates.size+lateResults.size+members.size+suspensions.size+communications.size>512)throw Error('Host evidence capture exceeds 512 records');
  if(requests.size+joins.size+pendingRequests.size+pendingJoins.size>512)throw Error('Host dependency closure exceeds 512 records');
  for(const requestId of [...pendingRequests]){
   pendingRequests.delete(requestId);if(requests.has(requestId))continue;
   const row=db.prepare(`SELECT id,project_id,conversation_id,requester_agent_id,recipient_agent_id,communication_event_id,payload_json,state,version,lifetime_kind,deadline_at,open_question_update_id,superseded_by_request_id,origin_run_id,created_at,updated_at,terminal_at FROM coordination_requests WHERE id=?`).get(requestId) as Row|undefined;
   if(!row){missingReferences.push({kind:'request',id:requestId});continue;}scoped(row);if(!participants.has(row.requester_agent_id)&&!participants.has(row.recipient_agent_id))throw Error('Host dependency exceeds root participant scope');parse(row.payload_json);requests.set(row.id,row);
   if(row.superseded_by_request_id)pendingRequests.add(row.superseded_by_request_id);
   for(const predecessor of db.prepare('SELECT id FROM coordination_requests WHERE superseded_by_request_id=?').all(row.id) as Row[])pendingRequests.add(predecessor.id);
   const history=db.prepare(`SELECT id,request_id,kind,actor_kind,actor_id,in_reply_to_update_id,payload_json,payload_hash,resulting_state,resulting_version,created_at FROM coordination_request_updates WHERE request_id=? ORDER BY resulting_version,id LIMIT 513`).all(row.id) as Row[];
   if(history.length>512)throw Error('Request update capture exceeds 512 records');
   let version=0,updatePrefixComplete=true;
   for(const update of history){parse(update.payload_json);if(update.resulting_version!==++version)updatePrefixComplete=false;updates.set(update.id,update);}
   updatePrefixComplete&&=version===row.version&&(!history.length||history.at(-1)!.resulting_state===row.state);requestVersions.push({requestId:row.id,version:row.version,updatePrefixComplete});
   if(row.open_question_update_id&&!history.some(update=>update.id===row.open_question_update_id&&update.kind==='question'))missingReferences.push({kind:'open_question',id:row.open_question_update_id});
   for(const result of db.prepare('SELECT id,request_id,kind,actor_agent_id,payload_json,payload_hash,created_at FROM coordination_request_late_results WHERE request_id=? ORDER BY id').all(row.id) as Row[]){parse(result.payload_json);lateResults.set(result.id,result);}
   for(const suspension of db.prepare('SELECT question_update_id,request_id,owner_agent_id,dependency_kind,dependency_id,state,created_at,updated_at,terminal_at FROM coordination_question_suspensions WHERE request_id=? ORDER BY question_update_id,dependency_kind,dependency_id').all(row.id) as Row[]){
    if(!history.some(update=>update.id===suspension.question_update_id&&update.kind==='question'))throw Error('Question suspension lacks its immutable question');
    suspensions.set(stableJson([suspension.question_update_id,suspension.dependency_kind,suspension.dependency_id]),suspension);if(suspension.dependency_kind==='join')pendingJoins.add(suspension.dependency_id);
   }
   for(const related of db.prepare(`SELECT DISTINCT j.id FROM coordination_joins j LEFT JOIN coordination_join_members m ON m.join_id=j.id WHERE m.request_id=? OR EXISTS(SELECT 1 FROM json_each(j.continuation_request_ids_json) WHERE value=?)`).all(row.id,row.id) as Row[])pendingJoins.add(related.id);
   if(row.communication_event_id){const communication=db.prepare('SELECT id,project_id,sender_json,intent,audience_json,payload_json,payload_hash,created_at FROM runtime_communications WHERE id=?').get(row.communication_event_id) as Row|undefined;
    if(!communication){missingReferences.push({kind:'communication',id:row.communication_event_id});continue;}if(communication.project_id!==row.project_id)throw Error('Request Communication scope is unavailable');for(const field of ['sender_json','audience_json','payload_json'])parse(communication[field]);communications.set(communication.id,communication);
   }
  }
  for(const joinId of [...pendingJoins]){
   pendingJoins.delete(joinId);if(joins.has(joinId))continue;
   const row=db.prepare(`SELECT id,project_id,conversation_id,owner_agent_id,mode,quorum,satisfying_outcomes_json,state,deadline_at,definition_hash,continuation_request_ids_json,wake_policy,origin_run_id,created_at,updated_at,terminal_at FROM coordination_joins WHERE id=?`).get(joinId) as Row|undefined;
   if(!row){missingReferences.push({kind:'join',id:joinId});continue;}scoped(row);if(!participants.has(row.owner_agent_id))throw Error('Host Join exceeds root participant scope');parse(row.satisfying_outcomes_json);const continuations=parse(row.continuation_request_ids_json);if(!Array.isArray(continuations)||continuations.some(ref=>typeof ref!=='string')||new Set(continuations).size!==continuations.length)throw Error('Invalid Join continuation identities');joins.set(row.id,row);
   const ordered=db.prepare('SELECT join_id,request_id,position FROM coordination_join_members WHERE join_id=? ORDER BY position').all(row.id) as Row[];
   for(const [position,member] of ordered.entries()){if(member.position!==position)throw Error('Join member order has a gap');members.set(stableJson([row.id,member.request_id]),member);pendingRequests.add(member.request_id);}
   for(const ref of continuations)pendingRequests.add(ref);
   const observed=db.prepare(`SELECT a.id,a.project_id,a.agent_id,a.kind,a.payload_json,a.created_at FROM activation_sources source JOIN agent_activations a ON a.id=source.activation_id WHERE source.source_kind='join' AND source.source_id=? ORDER BY a.created_at,a.id LIMIT 513`).all(row.id) as Row[];
   if(observed.length>512)throw Error('Join outcome capture exceeds 512 observations');
   for(const observation of observed){
    if(observation.project_id!==row.project_id||observation.agent_id!==row.owner_agent_id)throw Error('Join outcome escapes its owner');
    const payload=parse(observation.payload_json);if(payload.joinId!==row.id)throw Error('Join outcome source differs');
    // Frozen outcome data is preserved independently of activation delivery and reply authority.
    const {joinId,state,wakePolicy,progress,outcomes,continuations}=payload;
    joinOutcomes.set(observation.id,{id:observation.id,project_id:observation.project_id,owner_agent_id:observation.agent_id,kind:observation.kind,source_payload_sha256:payloadHash(payload),observations_json:stableJson({joinId,state,wakePolicy,progress,outcomes,...(continuations?{continuations}:{})}),created_at:observation.created_at});
   }
  }
 }
 for(const update of updates.values())if(update.in_reply_to_update_id){const question=updates.get(update.in_reply_to_update_id);if(!question){missingReferences.push({kind:'question',id:update.in_reply_to_update_id});continue;}if(question.request_id!==update.request_id||question.kind!=='question'||question.resulting_version>=update.resulting_version)throw Error('Answer lineage escapes its question');}
 for(const join of joins.values())for(const ref of JSON.parse(join.continuation_request_ids_json)){const request=requests.get(ref);if(request&&request.conversation_id!==join.conversation_id)throw Error('Join continuation escapes its Chat');}
 for(const member of members.values()){const join=joins.get(member.join_id)!,request=requests.get(member.request_id)!;if(request&&(join.conversation_id!==request.conversation_id||![request.requester_agent_id,request.recipient_agent_id].includes(join.owner_agent_id)))throw Error('Join member escapes its Chat or owner participant scope');}
 for(const [kind,owners] of [['request_update',updates],['communication',communications]] as const)for(const owner of owners.values()){
  for(const artifact of db.prepare('SELECT id,owner_kind,owner_id,project_id,role,title,media_type,blob_hash,byte_length,origin_agent_id,execution_id,created_at FROM runtime_artifacts WHERE owner_kind=? AND owner_id=? ORDER BY id').all(kind,owner.id) as Row[]){if(artifact.project_id!==(kind==='communication'?owner.project_id:requests.get(owner.request_id)?.project_id))throw Error('Artifact original escapes its Project');artifactRefs.set(artifact.id,artifact);}
 }
 const resources=selected.resources!.map(envelope),resourceMembers:Evidence[]=[],resourceContexts:Evidence[]=[],resourceReceipts:Evidence[]=[];
 for(const resource of selected.resources!){
  for(const member of db.prepare('SELECT agent_id,step_execution_id,origin FROM branch_resource_members WHERE step_execution_id=? ORDER BY agent_id').all(resource.step_execution_id) as Row[])resourceMembers.push(envelope(member));
  for(const context of db.prepare('SELECT step_execution_id,generation,chat_id,agent_ids_json FROM branch_ephemeral_contexts WHERE step_execution_id=? ORDER BY generation').all(resource.step_execution_id) as Row[])resourceContexts.push(envelope(context));
  if(resource.chat_id){const receipt=db.prepare('SELECT conversation_id,storage_cleanup_completed,server_cleanup_completed FROM conversation_deletion_receipts WHERE conversation_id=?').get(resource.chat_id) as Row|undefined;if(receipt)resourceReceipts.push(envelope(receipt));}
 }
 const rows=(map:Map<string,Row>)=>[...map].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,row])=>envelope(row));
 const cut:BranchHostCut={schema:'ponderosa.branch.host-dependencies.v1',executionId:id,restoreAuthority:'fresh_admission_required',nativeState:'not_captured',artifactStorage:'references_only',roots,coverage:{complete:missingReferences.length===0&&requestVersions.every(row=>row.updatePrefixComplete),missingReferences,requestVersions},requests:rows(requests),updates:rows(updates),lateResults:rows(lateResults),joins:rows(joins),members:[...members.values()].sort((a,b)=>a.join_id===b.join_id?a.position-b.position:a.join_id<b.join_id?-1:1).map(envelope),suspensions:rows(suspensions),communications:rows(communications),joinOutcomes:rows(joinOutcomes),artifactRefs:rows(artifactRefs),resources,resourceMembers,resourceContexts,resourceReceipts,bindingPin:{revisionId:pin.binding_revision_id,sha256:pin.content_hash,requiredSecretRefs:Object.keys(JSON.parse(pin.configuration_json).secretBindings??{}).sort()}};
 if(Buffer.byteLength(stableJson(cut))>8_000_000)throw Error('Host dependency cut exceeds 8 MB');
 return cut;
}

/** Historical bytes verify against their capture, never against mutable current Request views. */
export function verifyBranchHostCut(cut:BranchHostCut,executionId:string):boolean {
 try{return cut.schema==='ponderosa.branch.host-dependencies.v1'&&cut.executionId===executionId&&cut.restoreAuthority==='fresh_admission_required'&&cut.nativeState==='not_captured'&&cut.artifactStorage==='references_only'
  &&['requests','updates','lateResults','joins','members','suspensions','communications','joinOutcomes','artifactRefs','resources','resourceMembers','resourceContexts','resourceReceipts'].every(key=>(cut[key as keyof BranchHostCut] as Evidence[]).every(record=>payloadHash(record.row)===record.sha256));}catch{return false;}
}
