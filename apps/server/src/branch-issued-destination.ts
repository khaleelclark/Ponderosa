import {createHash} from 'node:crypto';
import {
 readIssuedResourceContinuation,stableJson,workspaceCreationId,
 type AgentStore,type BranchStore,type CoordinationV3Store,type CoordinationDestinationAuthority,
} from '@ponderosa/agents';
import type {BranchIssuedDestinationInput,BranchIssuedDestinationDto,CoordinationDestinationReservation,AgentPortablePackageDto} from '@ponderosa/core';
import {BRANCH_DISCLOSURE_OPERATOR,BranchDisclosureReviewService} from './branch-disclosure-review.js';
import type {BranchPackageEngine} from './routes/agent-packages.js';
import type {ChatCreator} from './routes/projects.js';

type Row=Record<string,any>;
const hash=(v:unknown)=>createHash('sha256').update(stableJson(v)).digest('hex');

/** Operator commands only. Imported identities remain idle until explicit final admission. */
export class BranchIssuedDestinationService {
 private readonly preparing=new Set<string>();
 constructor(private readonly store:AgentStore,private readonly branches:BranchStore,private readonly coordination:CoordinationV3Store,
  private readonly disclosures:BranchDisclosureReviewService,private readonly packages:()=>BranchPackageEngine,private readonly createChat:ChatCreator){}
 private get db(){return this.store.sqlite;}
 private authority():CoordinationDestinationAuthority {
  return {
   requireCustodyAndOwner:r=>{
    const owner=this.disclosures.requireCurrentOwner(r),d=r.destination;
    const target=this.db.prepare('SELECT branch_id,version_id,binding_revision_id,cancel_requested,state FROM branch_executions WHERE id=?').get(d.executionId) as Row|undefined;
    const source=this.db.prepare('SELECT version_id,binding_revision_id FROM branch_executions WHERE id=?').get(r.sourceExecutionId) as Row|undefined;
    if(!target||target.branch_id!==r.branchId||target.cancel_requested||!['queued','waiting'].includes(target.state)
      ||target.version_id!==source?.version_id||target.binding_revision_id!==source?.binding_revision_id)throw Error('Current destination Branch owner unavailable');
    const bytes=this.packages().verifyCheckpointNow(r.custody);
    return hash({owner,bytes,hostCutSha256:r.custody.intent.hostCutSha256});
   },
   authorizeDisclosure:this.disclosures.authorizeDisclosure,
   resolveArtifact:()=>{throw Error('Issued destination runtime artifacts unsupported');},
  };
 }
 private valid(input:BranchIssuedDestinationInput):void {
  if(input.historicalReviewHash!==undefined&&(typeof input.historicalReviewHash!=='string'||!/^[a-f0-9]{64}$/.test(input.historicalReviewHash)))throw Error('Exact server historical review hash required');
  if(typeof input.commandKey!=='string'||!input.commandKey.trim()||input.commandKey.length>200||!Number.isSafeInteger(input.checkpointId)||input.checkpointId<1
   ||typeof input.expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedHash)||input.reconcileEffects!==true)throw Error('Exact issued checkpoint command and effect reconciliation required');
 }
 private supported(pkg:AgentPortablePackageDto,r:CoordinationDestinationReservation):void {
  if(pkg.memory?.length||pkg.agents.some(a=>a.artifacts?.length||a.workingFiles?.length||a.workingFolder||a.workingRootRef||a.workingCopyMode==='separate_git'
    ||a.accessSettings?.restrictedCapabilityIds.length||a.managementPermissions.allowAutomaticDescendantDeletion||a.managementPermissions.allowAutomaticDescendantReorganization)
   ||stableJson(pkg.agents.map(a=>a.ref))!==stableJson(r.custody.agentIds))throw Error('Issued destination supports artifact-free nonsecret private organization state without source restrictions, native working copies or elevated management grants');
 }
 inspect(branchId:string,executionId:string,commandKey:string,includeReceipt=true):BranchIssuedDestinationDto {
  const plan=this.branches.issuedDestinationPlan(branchId,executionId,commandKey),r=plan.reservation;
  const row=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(plan.admissionId) as Row;
  const disclosure=row.stage_json?this.disclosures.readChoice(branchId,executionId,plan.admissionId):{revision:0,state:'unreviewed' as const};
  let state:BranchIssuedDestinationDto['state']='reserved';
  if(row.state==='admitted'&&includeReceipt){
   const receipt=this.coordination.readCoordinationDestination(plan.admissionId,hash(r),this.authority());
   const owner=this.db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(receipt.owner.executionId,receipt.owner.receiptId) as Row|undefined;
   const ownerResult=owner&&JSON.parse(owner.result_json);
   if(owner?.input_hash!==hash(plan)||stableJson(ownerResult?.idMap)!==stableJson(plan.idMap))throw Error('Destination exact Branch owner lineage differs');
   const resource=this.db.prepare('SELECT * FROM branch_resources WHERE step_execution_id=?').get(r.destination.resourceStepId) as Row|undefined;
   const members=(this.db.prepare("SELECT agent_id FROM branch_resource_members WHERE step_execution_id=? AND origin='template' ORDER BY agent_id").all(r.destination.resourceStepId) as {agent_id:string}[]).map(m=>m.agent_id);
   const chatOperation=this.branches.resourceOperation(r.destination.resourceStepId,'chat'),importOperation=this.branches.resourceOperation(r.destination.resourceStepId,'import');
   const context=this.db.prepare('SELECT * FROM branch_ephemeral_contexts WHERE step_execution_id=? AND generation=0').get(r.destination.resourceStepId) as Row|undefined;
   if(!resource||resource.execution_id!==r.destination.executionId||resource.chat_id!==r.destination.conversationId||resource.generation!==0
     ||resource.creation_key!==`branch-resource:${r.destination.resourceStepId}`||stableJson(members)!==stableJson(Object.values(receipt.agentMap).sort())
     ||chatOperation?.state!=='completed'||chatOperation.result?.chatId!==r.destination.conversationId||chatOperation.creationKey!==plan.chatCreationKey
     ||importOperation?.state!=='completed'||importOperation.creationOperationId!==receipt.owner.creationOperationId||importOperation.result?.rootAgentId!==resource.root_agent_id
     ||stableJson(importOperation.result?.agentRefs)!==stableJson(receipt.agentMap)||!context||context.chat_id!==r.destination.conversationId
     ||context.agent_ids_json!==stableJson(importOperation.result.agentIds))throw Error('Destination exact resource/import/context receipt differs');
   const readiness=ownerResult.readiness;
   const checkpoint=readiness&&this.db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE execution_id=? AND id=?').get(receipt.owner.executionId,readiness.checkpointId) as Row|undefined;
   if(!checkpoint||checkpoint.content_hash!==readiness.checkpointHash||hash(JSON.parse(checkpoint.snapshot_json))!==checkpoint.content_hash)throw Error('Destination final checkpoint receipt unavailable');
   return {...(r.historicalPartition?{historicalPartition:r.historicalPartition}:{}),commandKey,admissionId:plan.admissionId,checkpointId:r.checkpointId,checkpointHash:r.checkpointHash,destination:r.destination,disclosure,state:'admitted',restoreSupported:true,receipt};
  }
  if(row.state==='admitted')state='admitted';
  else if(row.stage_json){
   const stage=JSON.parse(row.stage_json),op=this.store.getAgentCreationOperation(stage.importPlan.creationOperationId);
   state=op?.status==='canonical_committed'&&(op.result as Row)?.branchDestinationPrepared===true?'awaiting_disclosure':'import_unknown';
  }
  return {...(r.historicalPartition?{historicalPartition:r.historicalPartition}:{}),commandKey,admissionId:plan.admissionId,checkpointId:r.checkpointId,checkpointHash:r.checkpointHash,destination:r.destination,disclosure,state,restoreSupported:state==='admitted'};
 }
 list(branchId:string,executionId:string):BranchIssuedDestinationDto[] {
  if(this.branches.execution(executionId)?.branchId!==branchId)throw Error('Branch execution unavailable');
  // Discovery is bounded; command receipt remains the exact recovery route.
  const rows=this.db.prepare('SELECT command_key FROM coordination_destination_admissions WHERE branch_id=? AND source_execution_id=? ORDER BY created_at DESC,id DESC LIMIT 50').all(branchId,executionId) as {command_key:string}[];
  return rows.map(row=>this.inspect(branchId,executionId,row.command_key,false));
 }
 async prepare(branchId:string,executionId:string,input:BranchIssuedDestinationInput):Promise<BranchIssuedDestinationDto> {
  this.valid(input);const lock=hash({branchId,executionId,commandKey:input.commandKey});
  if(this.preparing.has(lock))throw Error('Destination preparation already in progress; read its command receipt');
  this.preparing.add(lock);
  try{
   const prior=this.db.prepare('SELECT 1 FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,`issued-destination:${hash(input.commandKey)}`);
   let plan:Row;
   if(prior){
    plan=this.branches.issuedDestinationPlan(branchId,executionId,input.commandKey);
    if(stableJson(plan.input)!==stableJson(input))throw Error('Issued destination command input conflict');
    const status=this.inspect(branchId,executionId,input.commandKey);
    if(status.state!=='reserved')return status;
   }else{
    // Fully parse/validate private bytes before reserving any new managed identity.
    const saved=readIssuedResourceContinuation(this.db,executionId,input.checkpointId,input.expectedHash),pkg=await this.packages().readCheckpoint(saved.custody);
    this.supported(pkg,{custody:saved.custody} as CoordinationDestinationReservation);
    const chatCreationKey=`issued-destination-${lock}`,projectId=workspaceCreationId('project','workspace',chatCreationKey),conversationId=workspaceCreationId('conversation',projectId,`${chatCreationKey}:default`);
    plan=this.branches.reserveIssuedDestination(branchId,executionId,input,{projectId,conversationId,creationKey:chatCreationKey,operatorId:BRANCH_DISCLOSURE_OPERATOR},this.authority());
   }
   const r=plan.reservation as CoordinationDestinationReservation,d=r.destination;
   const pkg=await this.packages().readCheckpoint(r.custody);this.supported(pkg,r);
   const bindings=this.branches.bindingRevision(branchId,readIssuedResourceContinuation(this.db,executionId,r.checkpointId,r.checkpointHash).continuation.bindingRevisionId);
   const engines=bindings?.engines??{},root=pkg.agents.find(a=>a.ref===pkg.rootRef),defaultEngine=root?engines[root.engine]:undefined;
   if(!defaultEngine)throw Error('Current destination Engine mapping unavailable');
   this.packages().validateAgent(pkg,engines);
   this.db.transaction(()=>this.authority().requireCustodyAndOwner(r))();
   const chat=await this.createChat({label:'Restored workflow organization',defaultEngine},plan.chatCreationKey,{branchId,executionId:d.executionId});
   if(chat.id!==d.conversationId||chat.projectId!==d.projectId||chat.branchId!==branchId||chat.executionId!==d.executionId)throw Error('Prospective destination Chat receipt differs');
   this.db.transaction(()=>this.authority().requireCustodyAndOwner(r))();
   // Runtime stage runs in import reservation before any Agent publication. A
   // later ambiguous import keeps its exact identities held; never reallocate.
   await this.packages().importAgent(d.projectId,d.conversationId,pkg,engines,`issued-import-${plan.admissionId}`,{
    ...(input.accessSettingsResolution?{accessSettingsResolution:input.accessSettingsResolution}:{}),
    branchHooks:{
     stage:importPlan=>{
      this.authority().requireCustodyAndOwner(r);
      this.coordination.stageCoordinationDestination(plan.admissionId,{importPlan,agentMap:Object.fromEntries(importPlan.agents.map(a=>[a.sourceRef,a.agentId])),artifactMap:{}});
     },
     plan:()=>{this.db.transaction(()=>this.authority().requireCustodyAndOwner(r))();},commit:()=>{throw Error('Explicit human disclosure review required');},
     holdForDisclosure:()=>{this.authority().requireCustodyAndOwner(r);},
     transaction:operation=>this.branches.unitTransaction(operation)(),
    },
   });
   return this.inspect(branchId,executionId,input.commandKey);
  }finally{this.preparing.delete(lock);}
 }
 async admit(branchId:string,executionId:string,commandKey:string,reviewHash:string):Promise<BranchIssuedDestinationDto> {
  if(typeof reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(reviewHash))throw Error('Exact current disclosure review hash required');
  const plan=this.branches.issuedDestinationPlan(branchId,executionId,commandKey),status=this.inspect(branchId,executionId,commandKey);
  const admitKey=`issued-destination-admit:${hash(commandKey)}`,inputHash=hash({commandKey,reviewHash});
  const prior=this.db.prepare('SELECT input_hash FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,admitKey) as Row|undefined;
  if(prior){if(prior.input_hash!==inputHash)throw Error('Destination admission command input conflict');if(status.state!=='admitted')throw Error('Destination admission receipt unavailable');return status;}
  if(status.state==='admitted')throw Error('Destination admission command receipt missing');
  if(status.state!=='awaiting_disclosure')throw Error('Destination import is not durably prepared');
  // This is the HUMAN preview hash, never a caller-forged Runtime authority revision.
  const preview=await this.disclosures.prepare(branchId,executionId,plan.admissionId);
  if(!preview.active||preview.reviewHash!==reviewHash)throw Error('Explicit current human disclosure approval required');
  const row=this.db.prepare('SELECT stage_json FROM coordination_destination_admissions WHERE id=?').get(plan.admissionId) as Row,stage=JSON.parse(row.stage_json);
  this.branches.unitTransaction(()=>{
   const authority=this.authority(),review=this.coordination.reviewCoordinationDestination(plan.admissionId,authority);
   this.packages().finishDestinationImport(stage.importPlan.creationOperationId,(result,complete)=>{
    this.coordination.admitCoordinationDestination(plan.admissionId,review.reviewHash,authority,graph=>this.branches.composeIssuedDestination(plan,graph,result,complete));
    // Final provenance exists now; coverage remains inside the import and owner transaction.
    this.branches.checkpointIssuedDestination(plan);
   });
   this.db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(executionId,admitKey,inputHash,stableJson({admissionId:plan.admissionId,reviewHash}),new Date().toISOString());
  }).immediate();
  return this.inspect(branchId,executionId,commandKey);
 }
}
