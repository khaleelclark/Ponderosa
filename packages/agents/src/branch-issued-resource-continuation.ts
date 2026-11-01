import type Database from 'better-sqlite3';
import type {BranchDefinition,CheckpointPackageReceipt} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {SCRIPT_CONTINUATION_COMPATIBILITY,replayScriptCut,type Selected,type ScriptOwnerContext} from './branch-script-continuation.js';
import {resourceCaptureFrontierHash,receiptMatchesSource} from './branch-resource-capture.js';
import {branchContinuationIds,remapBranchFrontier} from './branch-continuation-remap.js';
import {verifyBranchHostCut,type BranchHostCut} from './branch-host-cut.js';
import {verifyHostProvenance} from './branch-host-provenance.js';
import {validateBranchConfiguration} from './branch-parameters.js';
type Row=Record<string,any>;

/** Uses the existing Script/control/parallel replay; this envelope grants no admission. */
export function encodeIssuedResourceContinuation(db:Database.Database,executionId:string,selected:Selected,host:BranchHostCut):Row {
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
  versionId:e.version_id,versionHash:owner.version_hash,bindingRevisionId:e.binding_revision_id,bindingHash:owner.binding_hash,configuration:safe,
  audit,auditSha256:payloadHash(audit),frontierSha256:resourceCaptureFrontierHash(selected),hostCutSha256:payloadHash(host)};
 if(!issuedResourceContinuationSupported(db,executionId,selected,host,value))throw Error('Issued executable continuation replay unsupported');
 return value;
}

export function issuedResourceContinuationSupported(db:Database.Database,executionId:string,selected:Selected,host:BranchHostCut,c:Row):boolean {
 try{
  const e=selected.execution?.[0];
  if(!e||e.id!==executionId||c?.schema!=='ponderosa.branch.issued-resource-continuation.v1'
   ||stableJson(c.compatibility)!==stableJson(SCRIPT_CONTINUATION_COMPATIBILITY)||c.versionId!==e.version_id||c.bindingRevisionId!==e.binding_revision_id
   ||c.frontierSha256!==resourceCaptureFrontierHash(selected)||c.hostCutSha256!==payloadHash(host)||c.auditSha256!==payloadHash(c.audit)
   ||!Array.isArray(c.audit)||!c.audit.length||Object.hasOwn(c.configuration,'secretBindings')||c.configuration.checkpointMode==='exit'
   ||!['running','waiting','completed'].includes(e.state)||e.depth_ceiling!==c.configuration.limits.maxCallDepth||!verifyBranchHostCut(host,executionId))return false;
  const version=db.prepare('SELECT definition_json,content_hash FROM branch_versions WHERE id=? AND branch_id=?').get(c.versionId,e.branch_id) as Row|undefined;
  const binding=db.prepare('SELECT bindings_json,content_hash FROM branch_bindings WHERE id=? AND branch_id=?').get(c.bindingRevisionId,e.branch_id) as Row|undefined;
  if(!version||!binding||version.content_hash!==c.versionHash||binding.content_hash!==c.bindingHash
   ||payloadHash(JSON.parse(version.definition_json))!==c.versionHash||payloadHash(JSON.parse(binding.bindings_json))!==c.bindingHash
   ||host.bindingPin.revisionId!==c.bindingRevisionId||host.bindingPin.sha256!==c.bindingHash||host.bindingPin.requiredSecretRefs.length)return false;
  const definition=JSON.parse(version.definition_json) as BranchDefinition;
  if(stableJson(validateBranchConfiguration(c.configuration,definition,true))!==stableJson(c.configuration))return false;
  verifyHostProvenance(host);
  const resourceCleanup=e.state==='waiting'&&selected.paths?.length===1&&selected.paths[0]?.state==='completed';
  if(resourceCleanup&&(e.wait_reason!=='Waiting for ephemeral Agent work and runtime cleanup'||selected.resources[0]?.state!=='draining'))return false;
  const context:ScriptOwnerContext={resourceFrontier:true,issuedResource:true,resourceCleanup,terminal:e.state==='completed'||resourceCleanup,waiting:e.state==='waiting'&&!resourceCleanup,descendantTraversals:0,descendantLoops:0,children:{}};
  return replayScriptCut(db,executionId,selected,definition,c.configuration,c.audit,undefined,undefined,context,host);
 }catch{return false;}
}

/** Exact sealed checkpoint read; later source audit events never become selected evidence. */
export function readIssuedResourceContinuation(db:Database.Database,executionId:string,checkpointId:number,expectedHash:string):{selected:Selected;hostDependencies:BranchHostCut;continuation:Row;custody:CheckpointPackageReceipt} {
 const row=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE execution_id=? AND id=?').get(executionId,checkpointId) as Row|undefined;
 if(!row||row.content_hash!==expectedHash)throw Error('Issued executable checkpoint unavailable');
 const snapshot=JSON.parse(row.snapshot_json),c=snapshot.issuedContinuation,receipt=snapshot.issuedResourceCustody as CheckpointPackageReceipt;
 if(stableJson(snapshot)!==row.snapshot_json||payloadHash(snapshot)!==expectedHash||snapshot.schema!=='branch-unit-selected.v2'||snapshot.captureKind!=='issued_resource'
  ||!c||!receipt||!issuedResourceContinuationSupported(db,executionId,snapshot.selected,snapshot.hostDependencies,c))throw Error('Issued executable checkpoint integrity/compatibility unsupported');
 const {version,custodyId,boundaryId,sha256,byteLength,...source}=receipt,r=snapshot.selected.resources[0];
 if(!receiptMatchesSource(receipt,source)||source.intent.executionId!==executionId||source.intent.resourceStepId!==r.step_execution_id
  ||source.intent.resourceGeneration!==r.generation||source.sourceChatId!==r.chat_id||source.intent.frontierSha256!==c.frontierSha256
  ||source.intent.hostCutSha256!==c.hostCutSha256||source.intent.bindingSha256!==c.bindingHash||source.intent.configurationSha256!==payloadHash(c.configuration)
  ||stableJson(source.agentIds)!==stableJson(JSON.parse(r.import_operation_json).result.agentIds))throw Error('Issued executable custody binding differs');
 return {selected:snapshot.selected,hostDependencies:snapshot.hostDependencies,continuation:c,custody:receipt};
}

/** Pure reconstruction for the future synchronous admission composer. No SQL/effects. */
export function reconstructIssuedResourceContinuation(db:Database.Database,executionId:string,checkpointId:number,expectedHash:string,
 destination:{executionId:string;conversationId:string;resourceGeneration:number},
 maps:{idMap:Record<string,string>;requestMap:Record<string,string>;agentMap:Record<string,string>}) {
 const saved=readIssuedResourceContinuation(db,executionId,checkpointId,expectedHash),source=saved.selected.resources[0]!,ids=saved.custody.agentIds;
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
 const requestBindings=saved.hostDependencies.roots.map(root=>({sourceRequestId:root.requestId!,requestId:maps.requestMap[root.requestId!],
  stepExecutionId:maps.idMap[saved.selected.attempts.find(a=>a.id===root.attemptId)!.step_execution_id]!}));
 const execution=saved.selected.execution[0]!;
 return {frontier,resource,agentIds:ids.map(id=>maps.agentMap[id]!),requestBindings,executionState:execution.state,
  executionCounters:{traversals:execution.traversals,loopIterations:execution.loop_iterations,depthCeiling:execution.depth_ceiling},
  sourceCheckpoint:{executionId,checkpointId,expectedHash},continuation:saved.continuation};
}
