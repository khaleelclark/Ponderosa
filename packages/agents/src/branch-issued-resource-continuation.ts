import {readPinnedRetainedIssuedSource} from './coordination-v3-retained-destination-source.js';
import {retainedCompletedFinalResourceSource} from './branch-final-resource-reconciliation.js';
import {validateBranchRuntimeData} from './branch-runtime-package.js';
import {generationOneReplay,type GenerationOneProof} from './branch-resource-generation-one.js';
import type Database from 'better-sqlite3';
import type {BranchDefinition,BranchPortableRuntimeData,BranchPortableRuntimeOwner,CheckpointPackageReceipt} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {SCRIPT_CONTINUATION_COMPATIBILITY,replayScriptCut,replayRetainedIssuedResourceCut,type Selected,type ScriptOwnerContext} from './branch-script-continuation.js';
import {resourceCaptureFrontierHash,receiptMatchesSource} from './branch-resource-capture.js';
import {branchContinuationIds,remapBranchFrontier} from './branch-continuation-remap.js';
import {verifyBranchHostCut,type BranchHostCut} from './branch-host-cut.js';
import {verifyHostProvenance} from './branch-host-provenance.js';
import {validateBranchConfiguration} from './branch-parameters.js';
type Row=Record<string,any>;

/** Uses the existing Script/control/parallel replay; this envelope grants no admission. */
export function encodeIssuedResourceContinuation(db:Database.Database,executionId:string,selected:Selected,host:BranchHostCut,group=false,generationRetry?:GenerationOneProof):Row {
 if(!db.inTransaction)throw Error('Issued continuation encoding requires the capture transaction');
 const owner=db.prepare(`SELECT e.configuration_json,v.definition_json,v.content_hash version_hash,b.content_hash binding_hash,b.bindings_json
  FROM branch_executions e JOIN branch_versions v ON v.id=e.version_id AND v.branch_id=e.branch_id
  JOIN branch_bindings b ON b.id=e.binding_revision_id AND b.branch_id=e.branch_id WHERE e.id=?`).get(executionId) as Row|undefined;
 if(!owner)throw Error('Issued continuation owned pins unavailable');
 const configuration=JSON.parse(owner.configuration_json),{secretBindings,...safe}=configuration;
 const definition=JSON.parse(owner.definition_json) as BranchDefinition,e=selected.execution?.[0];
 if(!e||Object.keys(secretBindings??{}).length||safe.checkpointMode==='exit'||!['running','waiting','completed'].includes(e.state)
  ||e.depth_ceiling!==safe.limits.maxCallDepth||stableJson(validateBranchConfiguration(safe,definition,true))!==stableJson(safe)
  ||payloadHash(definition)!==owner.version_hash||payloadHash(JSON.parse(owner.bindings_json))!==owner.binding_hash
  ||host.bindingPin.revisionId!==e.binding_revision_id||host.bindingPin.sha256!==owner.binding_hash)throw Error('Issued continuation pins/configuration unsupported');
 const audit=db.prepare('SELECT id,transition_key,kind,evidence_json,created_at FROM branch_checkpoints WHERE execution_id=? ORDER BY id').all(executionId);
 const value={schema:'ponderosa.branch.issued-resource-continuation.v1',compatibility:SCRIPT_CONTINUATION_COMPATIBILITY,
  ...(group?{group:true}:{}),...(generationRetry?{generationRetry}:{}),versionId:e.version_id,versionHash:owner.version_hash,bindingRevisionId:e.binding_revision_id,bindingHash:owner.binding_hash,configuration:safe,
  audit,auditSha256:payloadHash(audit),frontierSha256:resourceCaptureFrontierHash(selected),hostCutSha256:payloadHash(host)};
 if(!issuedResourceContinuationSupported(db,executionId,selected,host,value))throw Error('Issued executable continuation replay unsupported');
 return value;
}

export function issuedResourceContinuationSupported(db:Database.Database,executionId:string,selected:Selected,host:BranchHostCut,c:Row):boolean {
 return issuedResourceReplay({kind:'native',db},executionId,selected,host,c);
}

type IssuedReplaySource={kind:'native';db:Database.Database}|{kind:'retained-issued-resource';owner:BranchPortableRuntimeOwner};
function issuedResourceReplay(source:IssuedReplaySource,executionId:string,selected:Selected,host:BranchHostCut,c:Row):boolean {
 try{
  const e=selected.execution?.[0];
  if(!e||e.id!==executionId||c?.schema!=='ponderosa.branch.issued-resource-continuation.v1'
   ||stableJson(c.compatibility)!==stableJson(SCRIPT_CONTINUATION_COMPATIBILITY)||c.versionId!==e.version_id||c.bindingRevisionId!==e.binding_revision_id
   ||c.frontierSha256!==resourceCaptureFrontierHash(selected)||c.hostCutSha256!==payloadHash(host)||c.auditSha256!==payloadHash(c.audit)
   ||!Array.isArray(c.audit)||!c.audit.length||Object.hasOwn(c.configuration,'secretBindings')||c.configuration.checkpointMode==='exit'
   ||!['running','waiting','completed'].includes(e.state)||e.depth_ceiling!==c.configuration.limits.maxCallDepth||!verifyBranchHostCut(host,executionId))return false;
  const retainedFact=(kind:string,key:string)=>source.kind==='retained-issued-resource'?source.owner.facts.find(f=>f.kind===kind&&f.key===key):undefined;
  const vf=retainedFact('definition',c.versionId),bf=retainedFact('bindings',c.bindingRevisionId);
  const version=source.kind==='native'?source.db.prepare('SELECT definition_json,content_hash FROM branch_versions WHERE id=? AND branch_id=?').get(c.versionId,e.branch_id) as Row|undefined:vf?{definition_json:vf.json,content_hash:vf.sha256}:undefined;
  const binding=source.kind==='native'?source.db.prepare('SELECT bindings_json,content_hash FROM branch_bindings WHERE id=? AND branch_id=?').get(c.bindingRevisionId,e.branch_id) as Row|undefined:bf?{bindings_json:bf.json,content_hash:bf.sha256}:undefined;
  if(!version||!binding||version.content_hash!==c.versionHash||binding.content_hash!==c.bindingHash
   ||payloadHash(JSON.parse(version.definition_json))!==c.versionHash||payloadHash(JSON.parse(binding.bindings_json))!==c.bindingHash
   ||host.bindingPin.revisionId!==c.bindingRevisionId||host.bindingPin.sha256!==c.bindingHash||host.bindingPin.requiredSecretRefs.length)return false;
  const definition=JSON.parse(version.definition_json) as BranchDefinition;
  if(stableJson(validateBranchConfiguration(c.configuration,definition,true))!==stableJson(c.configuration))return false;
  verifyHostProvenance(host);
  if(!selected.resources)return false;
  const rootPaths=selected.paths?.filter(path=>path.parent_path_id===null)??[];
  const resourceCleanup=e.state==='waiting'&&rootPaths.length===1&&rootPaths[0]?.state==='completed'&&selected.paths!.every(path=>!['active','waiting','joining'].includes(path.state));
  if(resourceCleanup&&(e.wait_reason!=='Waiting for ephemeral Agent work and runtime cleanup'||!['active','draining'].includes(selected.resources[0]?.state)))return false;
  if(source.kind==='retained-issued-resource'&&(c.generationRetry||c.group))return false;
  const retry=source.kind==='native'&&c.generationRetry?generationOneReplay(source.db,selected,host,c.generationRetry):undefined;
  if(selected.resources[0]?.generation>0&&!retry||retry&&c.group)return false;
  const context:ScriptOwnerContext={...(retry?{resourceRetry:retry}:{}),resourceFrontier:true,issuedResource:true,...(c.group===true?{issuedGroup:true}:{}),resourceCleanup,terminal:e.state==='completed'||resourceCleanup,waiting:e.state==='waiting'&&!resourceCleanup,descendantTraversals:0,descendantLoops:0,children:{}};
  return source.kind==='native'?(replayScriptCut(source.db,executionId,retry?c.generationRetry.originalSelected:selected,definition,c.configuration,c.audit,undefined,undefined,context,retry?.replayHost??host)||retainedFinalDestinationReplay(source.db,executionId,selected,host,c))
   :replayRetainedIssuedResourceCut(source,selected,definition,c.configuration,c.audit,context,host);
 }catch{return false;}
}

/** Exact sealed checkpoint read; later source audit events never become selected evidence. */
export function readIssuedResourceContinuation(db:Database.Database,executionId:string,checkpointId:number,expectedHash:string):{selected:Selected;hostDependencies:BranchHostCut;continuation:Row;custody:CheckpointPackageReceipt} {
 const row=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE execution_id=? AND id=?').get(executionId,checkpointId) as Row|undefined;
 if(!row||row.content_hash!==expectedHash)throw Error('Issued executable checkpoint unavailable');
 const snapshot=JSON.parse(row.snapshot_json),c=snapshot.issuedContinuation,receipt=snapshot.issuedResourceCustody as CheckpointPackageReceipt;
 if(stableJson(snapshot)!==row.snapshot_json||payloadHash(snapshot)!==expectedHash||snapshot.schema!=='branch-unit-selected.v2'||snapshot.captureKind!=='issued_resource'
  ||snapshot.selected.resources.length!==1||c?.group||!c||!receipt||!issuedResourceContinuationSupported(db,executionId,snapshot.selected,snapshot.hostDependencies,c))throw Error('Issued executable checkpoint integrity/compatibility unsupported');
 if(!issuedCheckpointCustodySupported(snapshot,executionId))throw Error('Issued executable custody binding differs');
 return {selected:snapshot.selected,hostDependencies:snapshot.hostDependencies,continuation:c,custody:receipt};
}

function issuedCheckpointCustodySupported(snapshot:Row,executionId:string):boolean {
 try{
  const receipt=snapshot.issuedResourceCustody as CheckpointPackageReceipt,c=snapshot.issuedContinuation;
  const {version,custodyId,boundaryId,sha256,byteLength,...source}=receipt,r=snapshot.selected.resources[0];
  return !(!receiptMatchesSource(receipt,source)||source.intent.executionId!==executionId||source.intent.resourceStepId!==r.step_execution_id
  ||source.intent.resourceGeneration!==r.generation||source.sourceChatId!==r.chat_id||source.intent.frontierSha256!==c.frontierSha256
  ||source.intent.hostCutSha256!==c.hostCutSha256||source.intent.bindingSha256!==c.bindingHash||source.intent.configurationSha256!==payloadHash(c.configuration)
  ||stableJson(source.agentIds)!==stableJson(JSON.parse(r.import_operation_json).result.agentIds));
 }catch{return false;}
}

/** Committed selected and independent latest evidence; never source or destination execution authority. */
export function retainedIssuedResourceSource(value:BranchPortableRuntimeData,executionId:string,checkpointKey:string,checkpointSha256:string) {
 const data=validateBranchRuntimeData(value),owner=data.owners.find(o=>o.sourceExecutionId===executionId);
 if(!owner)throw Error('Retained issued owner unavailable');
 // A trusted exact automatic final checkpoint may supply retained source data.
 // Current destination custody and admission remain separate; no Request is replayed here.
 if(owner.facts.some(f=>f.kind==='command'&&f.key.startsWith('resource-final-exit:'))){
  try{return {data,owner,...retainedCompletedFinalResourceSource(owner,checkpointKey,checkpointSha256)};}
  catch(error){throw Error(`Portable continuation remains held: ${(error as Error).message}`);}
 }
 const fact=(kind:string)=>{const facts=owner.facts.filter(f=>f.kind===kind);if(facts.length!==1)throw Error('Retained issued owner evidence is missing or ambiguous');return JSON.parse(facts[0]!.json);};
 const selectedFact=owner.facts.find(f=>f.kind==='checkpoint'&&f.key===checkpointKey&&f.sha256===checkpointSha256);
 if(!selectedFact)throw Error('Retained issued selected checkpoint unavailable');
 const selected=JSON.parse(selectedFact.json) as Row,latestFrontier=fact('frontier'),latestHost=fact('host');
 const fullAudit=owner.facts.filter(f=>f.kind==='transition').map(f=>JSON.parse(f.json));
 const source:IssuedReplaySource={kind:'retained-issued-resource',owner};
 const supported=(snapshot:Row)=>snapshot.schema==='branch-unit-selected.v2'&&snapshot.captureKind==='issued_resource'&&snapshot.restore_supported===false
  &&snapshot.selected?.resources?.length===1&&!snapshot.issuedContinuation?.group
  &&issuedCheckpointCustodySupported(snapshot,executionId)
  &&issuedResourceReplay(source,executionId,snapshot.selected,snapshot.hostDependencies,snapshot.issuedContinuation);
 if(stableJson(selected)!==selectedFact.json||payloadHash(selected)!==checkpointSha256||!supported(selected))throw Error('Retained issued selected replay unsupported');
 // Latest needs its own committed envelope and own complete host/audit; no synthesized continuation or selected lending.
 const latestFact=owner.facts.find(f=>{
  if(f.kind!=='checkpoint')return false;
  const snapshot=JSON.parse(f.json) as Row;
  if(snapshot?.schema!=='branch-unit-selected.v2'||snapshot.captureKind!=='issued_resource'||!snapshot.selected||!snapshot.hostDependencies||!snapshot.issuedContinuation)return false;
  return stableJson(snapshot.selected)===stableJson(latestFrontier)&&stableJson(snapshot.hostDependencies)===stableJson(latestHost)
   &&stableJson(snapshot.issuedContinuation?.audit)===stableJson(fullAudit)&&supported(snapshot);
 });
 if(!latestFact)throw Error('Retained issued independent latest envelope unavailable');
 const latest=JSON.parse(latestFact.json) as Row;
 const custodyFor=(snapshot:Row)=>{
  const receipt=snapshot.issuedResourceCustody as CheckpointPackageReceipt;
  const f=owner.facts.find(f=>f.kind==='custody'&&f.key===receipt.custodyId);
  if(!f)throw Error('Retained issued custody evidence unavailable');
  const custody=JSON.parse(f.json) as Row;
  if(custody.disposition!=='retained_data'||custody.currentAuthority!==false||typeof custody.wireJson!=='string'
   ||stableJson(custody.receipt)!==stableJson(receipt)||stableJson(JSON.parse(custody.wireJson))!==stableJson(custody.package)
   ||!Array.isArray(custody.package?.agents)||stableJson(custody.package.agents.map((a:Row)=>a.ref))!==stableJson(receipt.agentIds)
   ||custody.package.agents.some((a:Row)=>a.sourceChat?.ref!==receipt.sourceChatId))throw Error('Retained issued original custody bytes/membership differ');
  return custody;
 };
 return {data,owner,selected,latest,selectedCustody:custodyFor(selected),latestCustody:custodyFor(latest),currentAuthority:false as const};
}

/** Pure reconstruction for the future synchronous admission composer. No SQL/effects. */
export function reconstructIssuedResourceContinuation(db:Database.Database,executionId:string,checkpointId:number,expectedHash:string,
 destination:{executionId:string;conversationId:string;resourceGeneration:number},
 maps:{idMap:Record<string,string>;requestMap:Record<string,string>;agentMap:Record<string,string>}) {
 const saved=readIssuedResourceContinuation(db,executionId,checkpointId,expectedHash);
 return reconstructVerifiedIssuedResourceContinuation(saved,executionId,checkpointId,expectedHash,destination,maps);
}
export function reconstructVerifiedIssuedResourceContinuation(saved:ReturnType<typeof readIssuedResourceContinuation>,executionId:string,checkpointId:number,expectedHash:string,
 destination:{executionId:string;conversationId:string;resourceGeneration:number},maps:{idMap:Record<string,string>;requestMap:Record<string,string>;agentMap:Record<string,string>}) {
 const source=saved.selected.resources![0]!,ids=saved.custody.agentIds;
 if(!destination.executionId||destination.executionId===executionId||!destination.conversationId||destination.conversationId===source.chat_id||destination.resourceGeneration!==0
  ||stableJson(Object.keys(maps.agentMap).sort())!==stableJson([...ids].sort())||new Set(Object.values(maps.agentMap)).size!==ids.length
  ||Object.values(maps.agentMap).some(id=>typeof id!=='string'||!id||ids.includes(id)))throw Error('Fresh complete destination resource mapping required');
 const keys=saved.hostDependencies.requests.map(x=>x.row.id);
 if(stableJson(Object.keys(maps.requestMap).sort())!==stableJson(keys.sort())||new Set(Object.values(maps.requestMap)).size!==keys.length
  ||Object.values(maps.requestMap).some(id=>typeof id!=='string'||!id||keys.includes(id)))throw Error('Fresh complete destination Request map required');
 branchContinuationIds(saved.selected);
 const frontier=remapBranchFrontier(saved.selected,maps.idMap,executionId,destination.executionId,maps.requestMap),stepId=maps.idMap[source.step_execution_id]!;
 const resource={step_execution_id:stepId,execution_id:destination.executionId,template_ref:source.template_ref,state:source.state,
  requested_count:ids.length,root_agent_id:maps.agentMap[source.root_agent_id],chat_id:destination.conversationId,generation:0,retry_draining:0,error:null,
  creation_key:`branch-resource:${stepId}`};
 const requestBindings=saved.hostDependencies.roots.map(root=>{
  const requestId=root.requestId&&maps.requestMap[root.requestId],attempt=saved.selected.attempts!.find(a=>a.id===root.attemptId),stepExecutionId=attempt&&maps.idMap[attempt.step_execution_id];
  if(!root.requestId||!requestId||!stepExecutionId)throw Error('Fresh complete destination Request binding required');
  return {sourceRequestId:root.requestId,requestId,stepExecutionId};
 });
 const execution=saved.selected.execution![0]!;
 return {frontier,resource,agentIds:ids.map(id=>maps.agentMap[id]!),requestBindings,executionState:execution.state,
  executionCounters:{traversals:execution.traversals,loopIterations:execution.loop_iterations,depthCeiling:execution.depth_ceiling},
  sourceCheckpoint:{executionId,checkpointId,expectedHash},continuation:saved.continuation};
}

/** Internal retained boundary replay used by final-exit command validation. */
export function retainedIssuedEnvelopeSupported(owner:BranchPortableRuntimeOwner,snapshot:Row):boolean {
 return snapshot.schema==='branch-unit-selected.v2'&&snapshot.captureKind==='issued_resource'&&snapshot.restore_supported===false
  &&snapshot.selected?.resources?.length===1&&issuedCheckpointCustodySupported(snapshot,owner.sourceExecutionId)
  &&issuedResourceReplay({kind:'retained-issued-resource',owner},owner.sourceExecutionId,snapshot.selected,snapshot.hostDependencies,snapshot.issuedContinuation);
}
export function retainedIssuedLatestSupported(owner:BranchPortableRuntimeOwner,selected:Selected,host:BranchHostCut,continuation:Row):boolean {
 return issuedResourceReplay({kind:'retained-issued-resource',owner},owner.sourceExecutionId,selected,host,continuation);
}

/** A completed imported final cut has no new executable suffix. Re-capture only
 * its exact committed remap and admission audit, so cleanup can retain real bytes. */
function retainedFinalDestinationReplay(db:Database.Database,executionId:string,selected:Selected,host:BranchHostCut,c:Row):boolean {
 try{
  const admissions=db.prepare("SELECT * FROM coordination_destination_admissions WHERE state='admitted' AND retained_source_id IS NOT NULL AND json_extract(reservation_json,'$.destination.executionId')=?").all(executionId) as Row[];
  if(admissions.length!==1)return false;
  const admission=admissions[0]!,r=JSON.parse(admission.reservation_json),receipt=JSON.parse(admission.receipt_json),stage=JSON.parse(admission.stage_json);
  const retained=readPinnedRetainedIssuedSource(db,admission.retained_source_id),proof=retained.proof;
  const planRow=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(r.sourceExecutionId,`issued-destination:${payloadHash(r.commandKey)}`) as Row|undefined;
  if(!planRow)return false;
  const plan=JSON.parse(planRow.result_json),ownerRow=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,`issued-destination-owner:${admission.id}`) as Row|undefined;
  if(!ownerRow||ownerRow.input_hash!==payloadHash(plan)||planRow.input_hash!==payloadHash(plan.input)
   ||stableJson(plan.reservation)!==admission.reservation_json||plan.admissionId!==admission.id
   ||receipt.reservationHash!==admission.reservation_hash||receipt.stageHash!==payloadHash(stage)
   ||receipt.activationIds.length||r.retainedSourceId!==retained.source.id)return false;
  const owned=JSON.parse(ownerRow.result_json),graph=owned.coordinationDestination;
  if(graph?.destination?.admissionId!==admission.id||graph.destination.retainedSourceId!==retained.source.id
   ||stableJson(graph.requestMap)!==stableJson(receipt.requestMap)||stableJson(graph.updateMap)!==stableJson(receipt.updateMap)
   ||stableJson(owned.idMap)!==stableJson(plan.idMap))return false;
  const restored=reconstructVerifiedIssuedResourceContinuation({selected:proof.selected.selected,hostDependencies:proof.selected.hostDependencies,continuation:proof.selected.issuedContinuation,custody:proof.selected.issuedResourceCustody},
   proof.owner?.sourceExecutionId??retained.source.original_execution_id,r.checkpointId,r.checkpointHash,
   {executionId,conversationId:r.destination.conversationId,resourceGeneration:0},{idMap:plan.idMap,requestMap:receipt.requestMap,agentMap:stage.agentMap});
  const normalized=(rows:Row[])=>rows.map(row=>stableJson(Object.fromEntries(Object.entries(row).filter(([key])=>!['created_at','updated_at'].includes(key))))).sort();
  for(const key of Object.keys(restored.frontier))if(stableJson(normalized(restored.frontier[key]!))!==stableJson(normalized(selected[key]!)))return false;
  const resource=selected.resources?.[0],e=selected.execution?.[0];
  if(selected.resources?.length!==1||!resource||!e||e.state!=='waiting'||e.wait_reason!=='Waiting for ephemeral Agent work and runtime cleanup'
   ||e.traversals!==restored.executionCounters.traversals||e.loop_iterations!==restored.executionCounters.loopIterations
   ||e.depth_ceiling!==restored.executionCounters.depthCeiling||!['active','draining'].includes(resource.state)
   ||Object.entries(restored.resource).some(([key,value])=>key!=='state'&&resource[key]!==value))return false;
  const expectedRequests=Object.values(receipt.requestMap).sort();
  if(stableJson(host.requests.map(q=>q.row.id).sort())!==stableJson(expectedRequests)||host.requests.some(q=>q.row.state!=='completed')
   ||host.joins.length||host.suspensions.length||host.artifactRefs.length||host.lateResults.length)return false;
  verifyHostProvenance(host);
  const actual=db.prepare('SELECT id,transition_key,kind,evidence_json,created_at FROM branch_checkpoints WHERE execution_id=? ORDER BY id').all(executionId) as Row[];
  if(stableJson(actual)!==stableJson(c.audit)||actual.length!==6
   ||actual.map(e=>e.kind).join('|')!=='trigger_accepted|resource_operation|resource_operation|issued_restored_prefix|workflow_started|resource_created')return false;
  const owner=db.prepare('SELECT * FROM branch_executions WHERE id=?').get(executionId) as Row;
  const chatOperation=JSON.parse(resource.chat_operation_json),importOperation=JSON.parse(resource.import_operation_json);
  if(stableJson(chatOperation)!==stableJson({schema:'branch-resource-operation.v1',phase:'chat',token:`destination:${admission.id}:chat`,state:'completed',generation:0,result:{chatId:r.destination.conversationId},creationKey:plan.chatCreationKey})
   ||importOperation.schema!=='branch-resource-operation.v1'||importOperation.phase!=='import'||importOperation.state!=='completed'
   ||importOperation.token!==`destination:${admission.id}:import`||importOperation.creationOperationId!==stage.importPlan.creationOperationId
   ||importOperation.result.rootAgentId!==resource.root_agent_id||stableJson(importOperation.result.agentRefs)!==stableJson(stage.agentMap))return false;
  const expected=[
   {versionId:owner.version_id,bindingRevisionId:owner.binding_revision_id,inputHash:owner.input_hash},
   chatOperation,importOperation,
   {sourceCheckpoint:restored.sourceCheckpoint,admissionId:admission.id,idMap:plan.idMap},
   {admission:JSON.parse(owner.admission_json)},
   {...importOperation.result,requestId:restored.requestBindings.find(b=>b.stepExecutionId===resource.step_execution_id)?.requestId,creationKey:resource.creation_key},
  ];
  if(actual.some((event,index)=>event.evidence_json!==stableJson(expected[index])))return false;
  return true;
 }catch{return false;}
}
