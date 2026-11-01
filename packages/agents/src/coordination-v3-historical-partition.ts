import type Database from 'better-sqlite3';
import type {CoordinationDestinationReservation,CoordinationDestinationStage,CoordinationDestinationReview,CoordinationDestinationReceipt} from '@ponderosa/core';
import {TERMINAL_REQUEST_STATES} from '@ponderosa/core';
import {readGenerationExitCapture} from './branch-generation-exit-capture.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {validateRetainedCoordinationGraph} from './coordination-v3-cut-restoration-authority.js';
import {verifyRetainedProviderExitEvidence} from './provider-exit-evidence.js';
import type {BranchHostCut} from './branch-host-cut.js';

type Partition=NonNullable<CoordinationDestinationReceipt['historicalPartition']>;
/** Pure retained evidence selection. No old actor, Request, activation or audience is rewritten. */
export function readDestinationHistoricalPartition(db:Database.Database,r:CoordinationDestinationReservation,stage?:CoordinationDestinationStage,currentCut?:BranchHostCut,committedAdmissionId?:string):Partition {
 if(!db.inTransaction)throw Error('Historical partition requires destination owner transaction');
 if(r.historicalPartition===undefined)return [];
 if(committedAdmissionId){
  const row=db.prepare("SELECT receipt_json,receipt_sha256,input_json FROM host_lifecycle_commits WHERE kind='coordination-historical-partition' AND identity=?").get(committedAdmissionId) as {receipt_json:string;receipt_sha256:string;input_json:string}|undefined;
  if(!row)throw Error('Committed historical evidence receipt unavailable');
  const v=JSON.parse(row.receipt_json);
  if(stableJson(v)!==row.receipt_json||payloadHash(v)!==row.receipt_sha256||v.schema!=='coordination-historical-partition.v1'||v.admissionId!==committedAdmissionId||v.reservationHash!==payloadHash(r)||stage&&v.stageHash!==payloadHash(stage)||row.input_json!==stableJson({reservationHash:v.reservationHash,stageHash:v.stageHash,reviewHash:v.reviewHash})||stableJson(v.entries.map((e:any)=>e.selection))!==stableJson(r.historicalPartition))throw Error('Immutable historical evidence receipt differs');
  for(const p of v.entries){
   if(p.historical!==true||p.dispatchable!==false||payloadHash({seal:p.seal,retirement:p.retirement})!==p.sha256||p.seal.envelopeSha256!==p.selection.envelopeSha256||payloadHash(p.seal.envelope)!==p.selection.envelopeSha256||stableJson(p.seal.intakeFence)!==stableJson(p.selection.intakeFence)||stage&&stableJson(p.destinationAgentIds)!==stableJson(p.selection.discloseTo.map((id:string)=>stage.agentMap[id]).sort()))throw Error('Retained historical partition map differs');
   const fence=db.prepare("SELECT receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind='branch-generation-exit-fence' AND identity=?").get(p.selection.intakeFence.identity) as {receipt_json:string;receipt_sha256:string}|undefined;
   if(!fence||fence.receipt_sha256!==p.selection.intakeFence.sha256||payloadHash(JSON.parse(fence.receipt_json))!==fence.receipt_sha256)throw Error('Retained historical intake fence differs');
   verifyRetainedProviderExitEvidence(db,p.seal.envelope.providerExitEvidence);
  }
  return v.entries;
 }

 if(!Array.isArray(r.historicalPartition)||!r.historicalPartition.length||r.historicalPartition.length>32)throw Error('Bounded explicit historical generation inventory required');
 const seen=new Set<string>(),requests=new Map<string,string>();
 const entries=r.historicalPartition.map(selection=>{
  const key=stableJson([selection.executionId,selection.stepId,selection.generation]);
  if(seen.has(key))throw Error('Historical generation selections alias');seen.add(key);
  if(selection.executionId!==r.sourceExecutionId||!Number.isSafeInteger(selection.generation)||selection.generation<0||!Array.isArray(selection.discloseTo)||!selection.discloseTo.length||new Set(selection.discloseTo).size!==selection.discloseTo.length||selection.discloseTo.some(id=>typeof id!=='string'||!id))throw Error('Exact historical source/current recipients required');
  const seal=readGenerationExitCapture(db,selection.executionId,selection.stepId,selection.generation);
  if(!seal||seal.state!=='sealed'||seal.identity.branchId!==r.branchId||seal.checkpointId!==selection.checkpointId||seal.checkpointHash!==selection.checkpointHash||seal.envelopeSha256!==selection.envelopeSha256||stableJson(seal.intakeFence)!==stableJson(selection.intakeFence))throw Error('Exact prospective sealed historical generation required');
  // Original Project/Chat ownership is sealed by the intake fence, independently of the fresh destination.
  const originalChat=db.prepare('SELECT project_id,branch_id,branch_execution_id FROM conversations WHERE id=?').get(seal.identity.chatId) as {project_id:string;branch_id:string;branch_execution_id:string}|undefined;
  if(originalChat&&(originalChat.project_id!==seal.identity.projectId||originalChat.branch_id!==seal.identity.branchId||originalChat.branch_execution_id!==selection.executionId))throw Error('Historical original Chat/Branch/Project scope differs');
  const resources=r.resources??[{custody:r.custody,destination:r.destination}];
  if(resources.some(v=>v.custody.sourceChatId===seal.identity.chatId)||resources.some(v=>v.custody.agentIds.some(id=>seal.identity.agentIds.includes(id))))throw Error('Historical and executable identities must be disjoint');
  if(!resources.some(v=>v.custody.intent.executionId===selection.executionId&&v.custody.intent.resourceStepId===selection.stepId&&v.custody.intent.resourceGeneration>selection.generation))throw Error('Historical generation must precede the selected current resource');
  const retired=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(selection.executionId,`resource-generation-retired:${selection.stepId}:${selection.generation}`) as {input_hash:string;result_json:string}|undefined;
  if(!retired)throw Error('Original generation retirement linkage required');
  const retirement=JSON.parse(retired.result_json);
  if(stableJson(retirement)!==retired.result_json||payloadHash(retirement)!==retired.input_hash||retirement.schema!=='branch-resource-generation-retired.v1'||retirement.resource.execution_id!==selection.executionId||retirement.resource.step_execution_id!==selection.stepId||retirement.resource.generation!==selection.generation||retirement.resource.chat_id!==seal.identity.chatId||retirement.priorGeneration.checkpointId!==seal.checkpointId||retirement.priorGeneration.checkpointHash!==seal.checkpointHash||retirement.priorGeneration.envelopeSha256!==seal.envelopeSha256)throw Error('Historical retirement linkage differs');
  const cut=seal.envelope.hostDependencies as BranchHostCut;
  if(!cut.coverage.complete||cut.artifactRefs.length||cut.requests.some(q=>!TERMINAL_REQUEST_STATES.has(q.row.state)||q.row.state==='outcome_unknown')||cut.joins.some(j=>j.row.state==='open'))throw Error('Historical partition requires complete settled artifact-free original facts');
  validateRetainedCoordinationGraph(cut,new Date().toISOString(),true);
  for(const q of cut.requests){
   const prior=requests.get(q.row.id);if(prior&&prior!==q.sha256)throw Error('Shared historical Request differs');requests.set(q.row.id,q.sha256);
   if(currentCut?.requests.some(e=>e.row.id===q.row.id))throw Error('Historical Request cannot become an executable root');
  }
  if(currentCut?.requests.some(q=>seal.identity.agentIds.includes(q.row.requester_agent_id)||seal.identity.agentIds.includes(q.row.recipient_agent_id)))throw Error('Historical Agent cannot be an executable participant');
  const destinationAgentIds=stage?selection.discloseTo.map(id=>stage.agentMap[id]):[];
  if(stage&&destinationAgentIds.some(id=>!id))throw Error('Historical disclosure must select exact current import refs');
  const retirementReceipt={inputHash:retired.input_hash,resultJson:retired.result_json};
  return {sha256:payloadHash({seal,retirement:retirementReceipt}),selection,seal,retirement:retirementReceipt,destinationAgentIds:[...destinationAgentIds].sort(),historical:true as const,dispatchable:false as const};
 });
 if(Buffer.byteLength(stableJson(entries))>32*1024*1024)throw Error('Historical partition exceeds retained bound');
 return entries;
}
export function destinationHistoricalFacts(entries:Partition):CoordinationDestinationReview['facts'] {
 return entries.map(p=>({kind:'historical_generation',id:payloadHash(p.selection),sha256:p.sha256,
 originalAgentIds:[...(p.seal as any).identity.agentIds],destinationAgentIds:p.destinationAgentIds,
 originalAudience:{requests:(p.seal as any).envelope.hostDependencies.requests.map((e:any)=>({requestId:e.row.id,projectId:e.row.project_id,conversationId:e.row.conversation_id,requesterAgentId:e.row.requester_agent_id,recipientAgentId:e.row.recipient_agent_id})),communications:(p.seal as any).envelope.hostDependencies.communications.map((e:any)=>({id:e.row.id,audience:JSON.parse(e.row.audience_json)}))},originalActor:{updates:(p.seal as any).envelope.hostDependencies.updates.map((e:any)=>({id:e.row.id,kind:e.row.actor_kind,idOfActor:e.row.actor_id})),communications:(p.seal as any).envelope.hostDependencies.communications.map((e:any)=>({id:e.row.id,sender:JSON.parse(e.row.sender_json)}))}}));
}
/** One immutable evidence receipt in the SAME transaction as current graph/import/owner composition. */
export function commitDestinationHistoricalPartition(db:Database.Database,id:string,r:CoordinationDestinationReservation,stage:CoordinationDestinationStage,cut:BranchHostCut,reviewHash:string):Partition {
 const entries=readDestinationHistoricalPartition(db,r,stage,cut);if(!entries.length)return entries;
 const value={schema:'coordination-historical-partition.v1',admissionId:id,reservationHash:payloadHash(r),stageHash:payloadHash(stage),reviewHash,entries};
 db.prepare('INSERT INTO host_lifecycle_commits(kind,identity,input_json,receipt_json,receipt_sha256) VALUES(?,?,?,?,?)').run('coordination-historical-partition',id,stableJson({reservationHash:value.reservationHash,stageHash:value.stageHash,reviewHash}),stableJson(value),payloadHash(value));
 return entries;
}
export function verifyDestinationHistoricalPartition(db:Database.Database,id:string,r:CoordinationDestinationReservation,stage:CoordinationDestinationStage,cut:BranchHostCut,receipt:CoordinationDestinationReceipt):void {
 const entries=readDestinationHistoricalPartition(db,r,stage,cut,id);
 if(!entries.length){if(receipt.historicalPartition!==undefined)throw Error('Unexpected historical partition receipt');return;}
 const row=db.prepare("SELECT receipt_json,receipt_sha256,input_json FROM host_lifecycle_commits WHERE kind='coordination-historical-partition' AND identity=?").get(id) as {receipt_json:string;receipt_sha256:string;input_json:string}|undefined;
 const value={schema:'coordination-historical-partition.v1',admissionId:id,reservationHash:payloadHash(r),stageHash:payloadHash(stage),reviewHash:receipt.reviewHash,entries};
 if(!row||row.receipt_json!==stableJson(value)||row.receipt_sha256!==payloadHash(value)||row.input_json!==stableJson({reservationHash:value.reservationHash,stageHash:value.stageHash,reviewHash:receipt.reviewHash})||stableJson(receipt.historicalPartition)!==stableJson(entries))throw Error('Exact historical evidence receipt differs');
}
