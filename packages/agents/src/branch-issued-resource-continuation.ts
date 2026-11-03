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
  return source.kind==='native'?replayScriptCut(source.db,executionId,retry?c.generationRetry.originalSelected:selected,definition,c.configuration,c.audit,undefined,undefined,context,retry?.replayHost??host)
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
 const saved=readIssuedResourceContinuation(db,executionId,checkpointId,expectedHash),source=saved.selected.resources![0]!,ids=saved.custody.agentIds;
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
