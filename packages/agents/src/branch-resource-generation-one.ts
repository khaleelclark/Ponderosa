import type Database from 'better-sqlite3';
import type {CoordinationHistoricalGenerationSelection} from '@ponderosa/core';
import {readGenerationExitCapture} from './branch-generation-exit-capture.js';
import {captureBranchHostCut,verifyBranchHostCut,type BranchHostCut} from './branch-host-cut.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {hostUpdateFact,verifyHostProvenance} from './branch-host-provenance.js';
import {hasParallelControls,parallelDefinitionSupported} from './branch-parallel-continuation.js';
import type {Selected} from './branch-script-continuation.js';
type Row=Record<string,any>;
export interface GenerationOneProof {schema:'branch-resource-generation-one.v1';originalSelected:Selected;selection:CoordinationHistoricalGenerationSelection;retirementSha256:string;history?:Array<{selection:CoordinationHistoricalGenerationSelection;retirementSha256:string}>}
export const MAX_RETAINED_RESOURCE_GENERATIONS=32;
/** Server-owned, ordered, exhaustive selections. The singular field preserves generation-one captures. */
export function generationHistoricalSelections(value:GenerationOneProof):CoordinationHistoricalGenerationSelection[]{return value.history?.map(v=>v.selection)??[value.selection];}
/** Every consumed attempt is proved independently; only the actual current attempt is executable. */
export function generationOneEvidence(db:Database.Database,full:Selected,exiting=false){
 const e=full.execution?.[0],r=full.resources?.[0],generation=r?.generation;
 if(!e||!r||e.parent_execution_id||full.resources!.length!==1||!Number.isSafeInteger(generation)||generation<1||generation>MAX_RETAINED_RESOURCE_GENERATIONS||r.retry_draining!==(exiting?1:0)||r.creation_key!==`branch-resource:${r.step_execution_id}:${generation}`)throw Error('One bounded standalone later-generation resource required');
 const owner=db.prepare('SELECT e.configuration_json,v.definition_json FROM branch_executions e JOIN branch_versions v ON v.id=e.version_id WHERE e.id=?').get(e.id) as Row|undefined;
 const definition=owner&&JSON.parse(owner.definition_json),step=full.steps!.find(s=>s.id===r.step_execution_id),node=definition?.steps.find((s:Row)=>s.id===step?.step_id),policy=node?.failure;
 if(!definition||definition.steps.some((s:Row)=>s.kind==='branch_call')||full.resources!.length!==1||
  (hasParallelControls(definition)?!parallelDefinitionSupported(definition,false,true):definition.controls.some((c:Row)=>!['condition','route'].includes(c.kind))))throw Error('Supported standalone retry history required');
 // ponytail: one resource invocation; multiple live map/resource owners need a separate exhaustive group proof.
 if(hasParallelControls(definition)&&(full.steps!.filter(s=>s.step_id===step?.step_id).length!==1||full.maps!.some(m=>m.item_count!==1)||full.paths!.some(p=>['active','waiting'].includes(p.state)&&p.id!==step?.path_id)||full.steps!.some(s=>s.id!==r.step_execution_id&&!['completed','failed'].includes(s.state))||full.attempts!.some(a=>a.step_execution_id!==r.step_execution_id&&a.request_id)))throw Error('Parallel history requires one resource path and settled local siblings');
 if(!owner||policy?.action!=='retry'||policy.freshContext!==true||!Number.isSafeInteger(policy.maxAttempts)||policy.maxAttempts<generation+1+(exiting?1:0)||policy.maxAttempts>MAX_RETAINED_RESOURCE_GENERATIONS+1||!Number.isSafeInteger(policy.delayMs)||policy.delayMs<0)throw Error('Configured bounded fresh-context retry budget required');
 const attempts=full.attempts!.filter(a=>a.step_execution_id===r.step_execution_id),current=attempts.find(a=>a.number===generation+1);
 if(attempts.length!==generation+1+(exiting?1:0)||new Set(attempts.map(a=>a.number)).size!==attempts.length||!current||!current.request_id||attempts.some(a=>a.recovery_of_request_id||a.cancel_requested||a.runtime_outcome_json||a.error||a.purpose!=='step'||a.fence!==0))throw Error('Exhaustive consumed retry attempts required');
 if(exiting){const successor=attempts.find(a=>a.number===generation+2);if(current.state!=='failed'||!successor||successor.state!=='prepared'||successor.request_id!==null)throw Error('Failed current attempt and prepared retry required');}
 else if(!['waiting','completed'].includes(current.state))throw Error('Known current executable attempt required');
 const currentIds=JSON.parse(r.import_operation_json).result.agentIds as string[];
 if(!Array.isArray(currentIds)||!currentIds.length||new Set(currentIds).size!==currentIds.length)throw Error('Fresh current generation identities required');
 const seenAgents=new Set(currentIds),seenChats=new Set([r.chat_id]),seenRequests=new Set([current.request_id]);
 const generations:Array<{seal:Row;retired:Row;prior:Row;next:Row;oldResource:Row;selection:CoordinationHistoricalGenerationSelection;retirementSha256:string;retirementAudit:Row[]}>=[];
 for(let g=0;g<generation;g++){
  const seal=readGenerationExitCapture(db,e.id,r.step_execution_id,g);
  if(seal?.state!=='sealed'||payloadHash(JSON.parse(owner.configuration_json))!==seal.identity.configurationSha256||seal.identity.branchId!==e.branch_id||seal.identity.versionId!==e.version_id||seal.identity.bindingRevisionId!==e.binding_revision_id)throw Error('Exact prior-generation seal required');
  const row=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(e.id,`resource-generation-retired:${r.step_execution_id}:${g}`) as Row|undefined;
  if(!row)throw Error('Exact retirement linkage required');
  const retired=JSON.parse(row.result_json),old=seal.envelope.selected as Selected,oldResource=old.resources?.[0];
  if(stableJson(retired)!==row.result_json||payloadHash(retired)!==row.input_hash||retired.schema!=='branch-resource-generation-retired.v1'
   ||retired.resource.execution_id!==e.id||retired.resource.step_execution_id!==r.step_execution_id||retired.resource.generation!==g||retired.resource.chat_id!==seal.identity.chatId
   ||retired.priorGeneration.checkpointId!==seal.checkpointId||retired.priorGeneration.checkpointHash!==seal.checkpointHash||retired.priorGeneration.envelopeSha256!==seal.envelopeSha256
   ||old.resources!.length!==1||old.execution![0]?.id!==e.id||!oldResource||stableJson(retired.context)!==stableJson(seal.envelope.hostDependencies.resourceContexts[0]?.row)
   ||retired.members.some((m:Row)=>!seal.identity.agentIds.includes(m.agent_id))||retired.members.length!==seal.identity.agentIds.length)throw Error('Prior-generation retirement differs');
  if(stableJson(retired.resource)!==stableJson(Object.fromEntries(Object.entries(oldResource).filter(([key])=>!['capture_json','chat_operation_json','import_operation_json'].includes(key))))
   ||stableJson(retired.members)!==stableJson(seal.envelope.hostDependencies.resourceMembers.map((m:Row)=>m.row).sort((a:Row,b:Row)=>a.agent_id.localeCompare(b.agent_id)))
   ||retired.operations?.length!==2||['chat','import'].some((phase,i)=>{const op=retired.operations[i];return !op||op.execution_id!==e.id||op.command_key!==`resource-operation:${oldResource.creation_key}:${phase}`||op.result_json!==oldResource[`${phase}_operation_json`];}))throw Error('Exact retired resource/import inventory differs');
  const prior=attempts.find(a=>a.number===g+1),next=attempts.find(a=>a.number===g+2),sealedPrior=old.attempts!.find(a=>a.id===prior?.id),sealedNext=old.attempts!.find(a=>a.id===next?.id);
  if(!prior||!next||!sealedPrior||!sealedNext||stableJson(prior)!==stableJson(sealedPrior)||prior.state!=='failed'||!prior.request_id||!next.request_id||next.request_id===prior.request_id
   ||old.attempts!.filter(a=>a.step_execution_id===r.step_execution_id).length!==g+2||attempts.filter(a=>a.number<=g+1).some(a=>!old.attempts!.some(b=>stableJson(a)===stableJson(b)))
   ||['id','step_execution_id','number','input_hash','purpose','available_at','created_at'].some(k=>next[k]!==sealedNext[k])||sealedNext.state!=='prepared'||sealedNext.request_id!==null)throw Error('Exact failed/retry attempt chain required');
  const historical=seal.envelope.hostDependencies as BranchHostCut;
  if(!verifyBranchHostCut(historical,e.id)||!historical.coverage.complete||historical.roots.length!==1||historical.roots[0]?.attemptId!==prior.id||historical.roots[0]?.requestId!==prior.request_id||historical.artifactRefs.length
   ||historical.resourceContexts.length!==1||historical.resourceContexts[0]?.row.generation!==g||historical.requests.some(q=>q.row.state==='outcome_unknown'||!['completed','failed','blocked','cancelled','expired','recipient_unavailable','superseded'].includes(q.row.state)))throw Error('Complete settled retained generation required');
  if(historical.requests.some(q=>q.row.conversation_id!==seal.identity.chatId||q.row.superseded_by_request_id||[q.row.requester_agent_id,q.row.recipient_agent_id].filter(Boolean).some(id=>!seal.identity.agentIds.includes(id)))
   ||historical.joins.some(j=>j.row.conversation_id!==seal.identity.chatId||!seal.identity.agentIds.includes(j.row.owner_agent_id))||historical.roots.some(root=>root.recoveryOfRequestId))throw Error('Retained generation exceeds original participant scope');
  const auditProjection=(a:Row)=>({id:a.id,transition_key:a.transition_key,kind:a.kind,evidence_json:a.evidence_json,created_at:a.created_at});
  if(!Array.isArray(retired.audit)||!retired.audit.length||stableJson(retired.audit.map(auditProjection))!==stableJson((db.prepare('SELECT id,transition_key,kind,evidence_json,created_at FROM branch_checkpoints WHERE execution_id=? AND id<=? ORDER BY id').all(e.id,retired.audit.at(-1).id))))throw Error('Exhaustive retained retirement audit chain differs');
  const nativeProof=(row:Row|undefined)=>row?Object.fromEntries(Object.entries(row).filter(([key])=>key!=='audit_published')):undefined;
  // Selected attempt rows exclude operational process identity; use the original owned ledger for its native inventory.
  const nativeAttempts=old.attempts!.map(a=>db.prepare('SELECT id,fence,process_identity_json FROM branch_attempts WHERE id=? AND step_execution_id=?').get(a.id,a.step_execution_id) as Row|undefined).filter((a):a is Row=>!!a?.process_identity_json);
  if(nativeAttempts.length!==seal.envelope.nativeScriptExits.length||nativeAttempts.some(a=>!seal.envelope.nativeScriptExits.some((n:Row)=>n.attemptId===a.id&&n.fence===a.fence&&stableJson(n.processIdentity)===stableJson(JSON.parse(a.process_identity_json))&&stableJson(nativeProof(n.proof))===stableJson(nativeProof(db.prepare("SELECT * FROM branch_checkpoints WHERE execution_id=? AND kind='script_process_exit' AND transition_key=?").get(e.id,`process-exit:${a.id}:${a.fence}`) as Row|undefined)))))throw Error('Exhaustive retained native exit chain differs');
  if(g>0){
   const prefix=generations.map(v=>({selection:{...v.selection,discloseTo:[...seal.identity.agentIds].sort()},retirementSha256:v.retirementSha256}));
   const expected:GenerationOneProof={schema:'branch-resource-generation-one.v1',originalSelected:old,selection:prefix[0]!.selection,retirementSha256:prefix[0]!.retirementSha256,...(g>1?{history:prefix}:{})};
   if(stableJson(seal.envelope.generationRetry)!==stableJson(expected))throw Error('Retained generation chain prefix differs');
  }
  verifyHostProvenance(historical);
  const request=historical.requests.find(q=>q.row.id===prior.request_id)?.row,update=historical.updates.find(u=>u.row.request_id===prior.request_id&&u.row.resulting_version===request?.version)?.row,payload=update?hostUpdateFact(historical,update).payload as Row:undefined;
  if(request?.state!=='failed'||!update||update.resulting_state!=='failed'||stableJson(JSON.parse(prior.result_json))!==stableJson({failed:true,...(typeof payload?.text==='string'?{output:payload.text}:{})}))throw Error('Retained failed result differs');
  if(seenChats.has(seal.identity.chatId)||seal.identity.agentIds.some((id:string)=>seenAgents.has(id))||historical.requests.some(q=>seenRequests.has(q.row.id)))throw Error('Historical generation identities alias');
  seenChats.add(seal.identity.chatId);for(const id of seal.identity.agentIds)seenAgents.add(id);for(const q of historical.requests)seenRequests.add(q.row.id);
  const selection:CoordinationHistoricalGenerationSelection={executionId:e.id,stepId:r.step_execution_id,generation:g,checkpointId:seal.checkpointId,checkpointHash:seal.checkpointHash,envelopeSha256:seal.envelopeSha256,intakeFence:seal.intakeFence,discloseTo:[...currentIds].sort()};
  generations.push({seal,retired,prior,next,oldResource,selection,retirementSha256:row.input_hash,retirementAudit:retired.audit.map((a:Row)=>({id:a.id,transition_key:a.transition_key,kind:a.kind,evidence_json:a.evidence_json,created_at:a.created_at}))});
 }
 const selected:Selected={...full,attempts:full.attempts!.filter(a=>a.step_execution_id!==r.step_execution_id||a.id===current.id)};
 return {selected,current,generations,generation,selection:generations[0]!.selection,retirementSha256:generations[0]!.retirementSha256};
}
/** Explicit partition capture never probes a deleted old Chat to rediscover its graph. */
export function captureGenerationOneHost(db:Database.Database,full:Selected,exiting=false){
 const proof=generationOneEvidence(db,full,exiting),host=captureBranchHostCut(db,full.execution![0]!.id,proof.selected);
 if(!host)throw Error('Current generation host cut unavailable');
 const old=host.resourceContexts.filter(c=>c.row.generation!==proof.generation);
 if(old.length!==proof.generations.length||proof.generations.some(g=>old.filter(c=>stableJson(c.row)===stableJson(g.retired.context)).length!==1))throw Error('Unselected generation context differs');
 host.resourceContexts=host.resourceContexts.filter(c=>c.row.generation===proof.generation);
 if(host.requests.some(q=>proof.generations.some(g=>g.seal.envelope.hostDependencies.requests.some((old:Row)=>old.row.id===q.row.id))))throw Error('Retired root leaked into current host cut');
 const generationRetry:GenerationOneProof={schema:'branch-resource-generation-one.v1',originalSelected:full,selection:proof.selection,retirementSha256:proof.retirementSha256,
  ...(proof.generation>1?{history:proof.generations.map(g=>({selection:g.selection,retirementSha256:g.retirementSha256}))}:{})};
 return {selected:proof.selected,host,generationRetry};
}
/** Validation-only union of exact immutable frames. Never supplied to the graph writer. */
export function generationOneReplay(db:Database.Database,selected:Selected,host:BranchHostCut,value:GenerationOneProof){
 if(value.schema!=='branch-resource-generation-one.v1')throw Error('Generation retry proof unavailable');
 const proof=generationOneEvidence(db,value.originalSelected),expected:GenerationOneProof={schema:value.schema,originalSelected:value.originalSelected,selection:proof.selection,retirementSha256:proof.retirementSha256,
  ...(proof.generation>1?{history:proof.generations.map(g=>({selection:g.selection,retirementSha256:g.retirementSha256}))}:{})};
 if(stableJson(proof.selected)!==stableJson(selected)||stableJson(value)!==stableJson(expected))throw Error('Generation retry selected evidence differs');
 const frames=[...proof.generations.map(g=>g.seal.envelope.hostDependencies as BranchHostCut),host];
 if(host.roots.length!==1||host.roots[0]?.attemptId!==proof.current.id||host.roots[0]?.requestId!==proof.current.request_id||host.requests.some(q=>frames.slice(0,-1).some(old=>old.requests.some(p=>p.row.id===q.row.id))))throw Error('Current and retired roots differ');
 const merge=(key:keyof BranchHostCut)=>{
  const map=new Map<string,Row>();for(const frame of frames)for(const record of frame[key] as Row[]){const row=record.row,id=row.id??(key==='members'?stableJson([row.join_id,row.request_id]):key==='suspensions'?stableJson([row.question_update_id,row.dependency_kind,row.dependency_id]):stableJson(row)),prior=map.get(id);if(prior&&stableJson(prior)!==stableJson(record))throw Error('Retry host evidence differs');map.set(id,record);}return [...map.values()];
 };
 const replayHost={...host,roots:frames.flatMap(f=>f.roots),coverage:{complete:true,missingReferences:[],requestVersions:frames.flatMap(f=>f.coverage.requestVersions)},
  requests:merge('requests'),updates:merge('updates'),lateResults:merge('lateResults'),joins:merge('joins'),members:merge('members'),suspensions:merge('suspensions'),communications:merge('communications'),joinOutcomes:merge('joinOutcomes'),artifactRefs:[]} as BranchHostCut;
 verifyHostProvenance(host);
 return {...proof,replayHost,currentHost:host};
}
