import type Database from 'better-sqlite3';
import type {CoordinationHistoricalGenerationSelection} from '@ponderosa/core';
import {readGenerationExitCapture} from './branch-generation-exit-capture.js';
import {captureBranchHostCut,verifyBranchHostCut,type BranchHostCut} from './branch-host-cut.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {hostUpdateFact,verifyHostProvenance} from './branch-host-provenance.js';
import type {Selected} from './branch-script-continuation.js';
type Row=Record<string,any>;
export interface GenerationOneProof {schema:'branch-resource-generation-one.v1';originalSelected:Selected;selection:CoordinationHistoricalGenerationSelection;retirementSha256:string}
/** The old failed attempt remains immutable evidence; only the actual new attempt is executable. */
export function generationOneEvidence(db:Database.Database,full:Selected){
 const e=full.execution![0],r=full.resources![0];
 if(!e||!r||e.parent_execution_id||full.resources!.length!==1||r.generation!==1||r.retry_draining||r.creation_key!==`branch-resource:${r.step_execution_id}:1`)throw Error('One standalone generation-one resource required');
 const seal=readGenerationExitCapture(db,e.id,r.step_execution_id,0);
 const configuration=db.prepare('SELECT configuration_json FROM branch_executions WHERE id=?').get(e.id) as Row|undefined;
 if(seal?.state!=='sealed'||!configuration||payloadHash(JSON.parse(configuration.configuration_json))!==seal.identity.configurationSha256||seal.identity.branchId!==e.branch_id||seal.identity.versionId!==e.version_id||seal.identity.bindingRevisionId!==e.binding_revision_id)throw Error('Exact generation-zero seal required');
 const row=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(e.id,`resource-generation-retired:${r.step_execution_id}:0`) as Row|undefined;
 if(!row)throw Error('Exact retirement linkage required');
 const retired=JSON.parse(row.result_json),old=seal.envelope.selected as Selected;
 if(stableJson(retired)!==row.result_json||payloadHash(retired)!==row.input_hash||retired.schema!=='branch-resource-generation-retired.v1'
  ||retired.resource.execution_id!==e.id||retired.resource.step_execution_id!==r.step_execution_id||retired.resource.generation!==0||retired.resource.chat_id!==seal.identity.chatId
  ||retired.priorGeneration.checkpointId!==seal.checkpointId||retired.priorGeneration.checkpointHash!==seal.checkpointHash||retired.priorGeneration.envelopeSha256!==seal.envelopeSha256
  ||old.resources!.length!==1||old.execution![0]?.id!==e.id||stableJson(retired.context)!==stableJson(seal.envelope.hostDependencies.resourceContexts[0]?.row)
  ||retired.members.some((m:Row)=>!seal.identity.agentIds.includes(m.agent_id))||retired.members.length!==seal.identity.agentIds.length)throw Error('Generation-one retirement differs');
 const oldResource=old.resources![0]!;
 if(Object.keys(retired.resource).some(k=>stableJson(retired.resource[k])!==stableJson(oldResource[k]))
  ||stableJson(retired.members)!==stableJson(seal.envelope.hostDependencies.resourceMembers.map((m:Row)=>m.row).sort((a:Row,b:Row)=>a.agent_id.localeCompare(b.agent_id)))
  ||retired.operations?.length!==2||['chat','import'].some((phase,i)=>{const op=retired.operations[i];return !op||op.execution_id!==e.id||op.command_key!==`resource-operation:${oldResource.creation_key}:${phase}`||op.result_json!==oldResource[`${phase}_operation_json`];}))throw Error('Exact retired resource/import inventory differs');
 const attempts=full.attempts!.filter(a=>a.step_execution_id===r.step_execution_id),prior=attempts.find(a=>a.number===1),current=attempts.find(a=>a.number===2);
 const sealedPrior=old.attempts!.find(a=>a.id===prior?.id),sealedCurrent=old.attempts!.find(a=>a.id===current?.id);
 if(attempts.length!==2||!prior||!current||!sealedPrior||!sealedCurrent||stableJson(prior)!==stableJson(sealedPrior)||prior.state!=='failed'||prior.error||prior.cancel_requested||prior.runtime_outcome_json
  ||!prior.request_id||current.recovery_of_request_id||current.cancel_requested||current.runtime_outcome_json||current.error||current.purpose!=='step'||!current.request_id||current.request_id===prior.request_id
  ||['id','step_execution_id','number','input_hash','purpose','available_at','created_at'].some(k=>current[k]!==sealedCurrent[k])||sealedCurrent.state!=='prepared'||sealedCurrent.request_id!==null)throw Error('Exact failed/retry attempt pair required');
 const historical=seal.envelope.hostDependencies as BranchHostCut;
 if(!verifyBranchHostCut(historical,e.id)||!historical.coverage.complete||historical.roots.length!==1||historical.roots[0]?.requestId!==prior.request_id||historical.artifactRefs.length
  ||historical.requests.some(q=>q.row.state==='outcome_unknown'||!['completed','failed','blocked','cancelled','expired','recipient_unavailable','superseded'].includes(q.row.state)))throw Error('Complete settled retained generation required');
 const request=historical.requests.find(q=>q.row.id===prior.request_id)?.row,update=historical.updates.find(u=>u.row.request_id===prior.request_id&&u.row.resulting_version===request?.version)?.row;
 const payload=update?hostUpdateFact(historical,update).payload as Row:undefined;
 if(request?.state!=='failed'||!update||update.resulting_state!=='failed'||stableJson(JSON.parse(prior.result_json))!==stableJson({failed:true,...(typeof payload?.text==='string'?{output:payload.text}:{})}))throw Error('Retained failed result differs');
 const currentIds=JSON.parse(r.import_operation_json).result.agentIds as string[];
 if(!Array.isArray(currentIds)||!currentIds.length||new Set(currentIds).size!==currentIds.length||currentIds.some(id=>seal.identity.agentIds.includes(id))||r.chat_id===seal.identity.chatId)throw Error('Fresh current generation identities required');
 const selection:CoordinationHistoricalGenerationSelection={executionId:e.id,stepId:r.step_execution_id,generation:0,checkpointId:seal.checkpointId,checkpointHash:seal.checkpointHash,envelopeSha256:seal.envelopeSha256,intakeFence:seal.intakeFence,discloseTo:[...currentIds].sort()};
 const selected:Selected={...full,attempts:full.attempts!.filter(a=>a.id!==prior.id)};
 return {selected,seal,retired,prior,current,selection,retirementSha256:row.input_hash};
}
/** Explicit partition capture never probes a deleted old Chat to rediscover its graph. */
export function captureGenerationOneHost(db:Database.Database,full:Selected){
 const proof=generationOneEvidence(db,full),host=captureBranchHostCut(db,full.execution![0]!.id,proof.selected);
 if(!host)throw Error('Current generation host cut unavailable');
 const oldContext=proof.retired.context;
 if(host.resourceContexts.some(c=>c.row.generation!==1&&stableJson(c.row)!==stableJson(oldContext)))throw Error('Unselected generation context differs');
 host.resourceContexts=host.resourceContexts.filter(c=>c.row.generation===1);
 if(host.requests.some(q=>proof.seal.envelope.hostDependencies.requests.some((old:Row)=>old.row.id===q.row.id)))throw Error('Retired root leaked into current host cut');
 const generationRetry:GenerationOneProof={schema:'branch-resource-generation-one.v1',originalSelected:full,selection:proof.selection,retirementSha256:proof.retirementSha256};
 return {selected:proof.selected,host,generationRetry};
}
/** Proof for shared serial replay only. The combined graph is NEVER a destination graph. */
export function generationOneReplay(db:Database.Database,selected:Selected,host:BranchHostCut,value:GenerationOneProof){
 if(value.schema!=='branch-resource-generation-one.v1')throw Error('Generation-one proof unavailable');
 const proof=generationOneEvidence(db,value.originalSelected);
 if(stableJson(proof.selected)!==stableJson(selected)||stableJson(proof.selection)!==stableJson(value.selection)||proof.retirementSha256!==value.retirementSha256)throw Error('Generation-one selected evidence differs');
 const old=proof.seal.envelope.hostDependencies as BranchHostCut;
 if(host.roots.length!==1||host.roots[0]?.attemptId!==proof.current.id||host.roots[0]?.requestId!==proof.current.request_id||host.requests.some(q=>old.requests.some(p=>p.row.id===q.row.id)))throw Error('Current and retired roots differ');
 const merge=(key:keyof BranchHostCut)=>{
  const map=new Map<string,Row>();for(const record of [...old[key] as Row[],...host[key] as Row[]]){const row=record.row,id=row.id??(key==='members'?stableJson([row.join_id,row.request_id]):key==='suspensions'?stableJson([row.question_update_id,row.dependency_kind,row.dependency_id]):stableJson(row)),prior=map.get(id);if(prior&&stableJson(prior)!==stableJson(record))throw Error('Retry host evidence differs');map.set(id,record);}return [...map.values()];
 };
 const replayHost={...host,roots:[...old.roots,...host.roots],coverage:{complete:true,missingReferences:[],requestVersions:[...old.coverage.requestVersions,...host.coverage.requestVersions]},
  requests:merge('requests'),updates:merge('updates'),lateResults:merge('lateResults'),joins:merge('joins'),members:merge('members'),suspensions:merge('suspensions'),communications:merge('communications'),joinOutcomes:merge('joinOutcomes'),artifactRefs:[]} as BranchHostCut;
 verifyHostProvenance(old);verifyHostProvenance(host);
 const oldResource=proof.seal.envelope.selected.resources[0];
 const retirementAudit=proof.retired.audit.map((a:Row)=>({id:a.id,transition_key:a.transition_key,kind:a.kind,evidence_json:a.evidence_json,created_at:a.created_at}));
 return {...proof,replayHost,currentHost:host,oldResource,retirementAudit};
}
