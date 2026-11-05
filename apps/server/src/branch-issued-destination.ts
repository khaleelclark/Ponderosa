import {portableLinkTarget,validateWorkingTopology} from './portable-working-files.js';
import {lstatSync,readFileSync,readlinkSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {
 stableJson,workspaceCreationId,
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
    const saved=this.branches.issuedDestinationSource(r.branchId,r.sourceExecutionId,r.checkpointId,r.checkpointHash);
    const bytes=saved.kind==='retained-issued-resource'?hash(saved.proof.selectedCustody):this.packages().verifyCheckpointNow(r.custody);
    if(r.retainedSourceId&&saved.kind==='retained-issued-resource')this.verifyFinalWorkingFiles(r,saved.proof.selectedCustody.package);
    return hash({owner,bytes,hostCutSha256:r.custody.intent.hostCutSha256});
   },
   authorizeDisclosure:this.disclosures.authorizeDisclosure,
   resolveArtifact:()=>{throw Error('Issued destination runtime artifacts unsupported');},
  };
 }
 private verifyFinalWorkingFiles(r:CoordinationDestinationReservation,pkg:AgentPortablePackageDto):void {
  const row=this.db.prepare('SELECT stage_json FROM coordination_destination_admissions WHERE branch_id=? AND command_key=?').get(r.branchId,r.commandKey) as Row|undefined;
  if(!row?.stage_json)return;
  const stage=JSON.parse(row.stage_json),operation=this.store.getAgentCreationOperation(stage.importPlan.creationOperationId);
  if(operation?.status==='preparing')return;
  this.packages().verifyImportedArtifactBytes(r.destination.projectId,stage.importPlan.artifacts);
  const result=operation?.result as Row|undefined;
  if(!result||!Array.isArray(result.liveWorkingRoots)||!Array.isArray(result.workingRoots))throw Error('Final imported working root receipts unavailable');
  const refs=[...new Set(pkg.agents.map(a=>a.workingRootRef!))];
  for(const ref of refs){
   const live=result.liveWorkingRoots.filter((v:Row)=>v.ref===ref),recovery=result.workingRoots.filter((v:Row)=>v.ref===ref);
   if(live.length!==1||recovery.length!==1)throw Error('Exact final imported root map required');
   const nodes=pkg.agents.filter(a=>a.workingRootRef===ref),members=nodes.map(a=>stage.agentMap[a.ref]).sort();
   if(stableJson([...live[0].agentIds].sort())!==stableJson(members)||stableJson([...recovery[0].agentIds].sort())!==stableJson(members))throw Error('Final imported root members differ');
   for(const id of members)if(this.store.getAgent(id)?.workingCopy.rootPath!==live[0].path)throw Error('Final live root ownership changed');
   for(const path of [live[0].path,recovery[0].destination]){
    if(!lstatSync(path).isDirectory())throw Error('Final imported root changed');
    for(const node of nodes){
     validateWorkingTopology(node.workingFiles??[],node.workingFolder?.directories??[],node.workingFolder?.links??[],node.workingFolder?.cyclicLinks??'refuse');
     for(const dir of node.workingFolder?.directories??[])if(!lstatSync(join(path,dir.path)).isDirectory())throw Error('Final imported directory changed');
     for(const file of node.workingFiles??[]){
      const artifact=node.artifacts?.find(a=>a.ref===file.artifactRef);
      if(!artifact||!lstatSync(join(path,file.path)).isFile()||!readFileSync(join(path,file.path)).equals(Buffer.from(artifact.dataBase64,'base64')))throw Error('Final imported file changed; preserve current data and review');
     }
     for(const link of node.workingFolder?.links??[]){
      if(link.targetRootRef!==undefined)throw Error('Final imported cross-root links remain held');
      const target=portableLinkTarget(link),name=join(path,link.path),entry=lstatSync(name,{bigint:true});
      if(realpathSync(dirname(name))!==dirname(name))throw Error('Final imported link parent changed; preserve current data and review');
      if(link.kind==='symlink'){
       if(!entry.isSymbolicLink()||readlinkSync(name)!==link.target||realpathSync(name)!==join(path,target)||link.mtime!==undefined&&entry.mtime.toISOString()!==link.mtime)
        throw Error('Final imported symlink changed; preserve current data and review');
      }else{
       const original=lstatSync(join(path,target),{bigint:true});
       if(!entry.isFile()||!original.isFile()||entry.dev!==original.dev||entry.ino!==original.ino)
        throw Error('Final imported hardlink changed; preserve current data and review');
      }
     }
    }
   }
  }
 }
 private valid(input:BranchIssuedDestinationInput):void {
  if(input.historicalReviewHash!==undefined&&(typeof input.historicalReviewHash!=='string'||!/^[a-f0-9]{64}$/.test(input.historicalReviewHash)))throw Error('Exact server historical review hash required');
  if(typeof input.commandKey!=='string'||!input.commandKey.trim()||input.commandKey.length>200||!Number.isSafeInteger(input.checkpointId)||input.checkpointId<1
   ||typeof input.expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedHash)||input.reconcileEffects!==true)throw Error('Exact issued checkpoint command and effect reconciliation required');
 }
 private supported(pkg:AgentPortablePackageDto,r:CoordinationDestinationReservation):void {
  if(r.retainedSourceId)return; // The exact complete plain-folder family is verified by the retained source reader.
  if(pkg.memory?.length||pkg.agents.some(a=>a.artifacts?.length||a.workingFiles?.length||a.workingFolder||a.workingRootRef||a.workingCopyMode==='separate_git'
    ||a.accessSettings?.restrictedCapabilityIds.length||a.managementPermissions.allowAutomaticDescendantDeletion||a.managementPermissions.allowAutomaticDescendantReorganization)
   ||stableJson(pkg.agents.map(a=>a.ref))!==stableJson(r.custody.agentIds))throw Error('Issued destination supports artifact-free nonsecret private organization state without source restrictions, native working copies or elevated management grants');
 }
 inspect(branchId:string,executionId:string,commandKey:string,includeReceipt=true):BranchIssuedDestinationDto {
  const plan=this.branches.issuedDestinationPlan(branchId,executionId,commandKey),r=plan.reservation;
  const row=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(plan.admissionId) as Row;
  const disclosure=row.stage_json?this.disclosures.readChoice(branchId,executionId,plan.admissionId):{revision:0,state:'unreviewed' as const};
  let state:BranchIssuedDestinationDto['state']='reserved';
   const terminalRetained=Boolean(r.retainedSourceId&&this.db.prepare("SELECT 1 FROM branch_executions e JOIN branch_resources r ON r.execution_id=e.id WHERE e.id=? AND e.state='completed' AND r.step_execution_id=? AND r.state='retired'").get(r.destination.executionId,r.destination.resourceStepId));
   const capturePending=Boolean(r.retainedSourceId&&this.branches.issuedResourceCapture(r.destination.executionId,r.destination.resourceStepId,`retained-final-destination:${plan.admissionId}`)?.state!=='retained');
  if(row.state==='admitted'&&includeReceipt){
   if(terminalRetained)this.branches.requireFinalResourceExit(r.destination.executionId,r.destination.resourceStepId);
   const receipt=terminalRetained
    ?this.coordination.readRetainedFinalDestinationAudit(plan.admissionId,hash(r),reservation=>this.disclosures.authorizeRetainedReceipt(plan.admissionId,reservation))
    :this.coordination.readCoordinationDestination(plan.admissionId,hash(r),this.authority());
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
   return {...(r.historicalPartition?{historicalPartition:r.historicalPartition}:{}),commandKey,admissionId:plan.admissionId,checkpointId:r.checkpointId,checkpointHash:r.checkpointHash,destination:r.destination,disclosure,state:capturePending?'capture_pending':'admitted',restoreSupported:!terminalRetained&&!capturePending,receipt};
  }
  if(row.state==='admitted')state=capturePending?'capture_pending':'admitted';
  else if(row.stage_json){
   const stage=JSON.parse(row.stage_json),op=this.store.getAgentCreationOperation(stage.importPlan.creationOperationId);
   state=op?.status==='canonical_committed'&&(op.result as Row)?.branchDestinationPrepared===true?'awaiting_disclosure':'import_unknown';
  }
  return {...(r.historicalPartition?{historicalPartition:r.historicalPartition}:{}),commandKey,admissionId:plan.admissionId,checkpointId:r.checkpointId,checkpointHash:r.checkpointHash,destination:r.destination,disclosure,state,restoreSupported:state==='admitted'&&!terminalRetained};
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
    const saved=this.branches.issuedDestinationSource(branchId,executionId,input.checkpointId,input.expectedHash);
    const pkg=saved.kind==='retained-issued-resource'?saved.proof.selectedCustody.package as AgentPortablePackageDto:await this.packages().readCheckpoint(saved.custody);
    if(saved.kind==='native')this.supported(pkg,{custody:saved.custody} as CoordinationDestinationReservation);
    const chatCreationKey=`issued-destination-${lock}`,projectId=workspaceCreationId('project','workspace',chatCreationKey),conversationId=workspaceCreationId('conversation',projectId,`${chatCreationKey}:default`);
    plan=this.branches.reserveIssuedDestination(branchId,executionId,input,{projectId,conversationId,creationKey:chatCreationKey,operatorId:BRANCH_DISCLOSURE_OPERATOR},this.authority());
   }
   const r=plan.reservation as CoordinationDestinationReservation,d=r.destination;
   const saved=this.branches.issuedDestinationSource(branchId,executionId,r.checkpointId,r.checkpointHash);
   const pkg=saved.kind==='retained-issued-resource'?saved.proof.selectedCustody.package as AgentPortablePackageDto:await this.packages().readCheckpoint(r.custody);this.supported(pkg,r);
   const bindings=this.branches.bindingRevision(branchId,saved.kind==='retained-issued-resource'?this.branches.getBranch(branchId)!.bindingRevisionId!:saved.continuation.bindingRevisionId);
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
    ...(r.retainedSourceId?{workingRootDestinations:{[pkg.agents[0]!.workingRootRef!]:join(this.store.getProject(chat.projectId)!.hostPath,'..',`final-resource-recovery-${plan.admissionId}`)},workingFilesActivation:{sharedRoot:this.store.getProject(chat.projectId)!.hostPath}}:{}),
    branchHooks:{
     ...(r.retainedSourceId?{retainFinalWorkingData:(value:AgentPortablePackageDto)=>{const source=this.branches.issuedDestinationSource(branchId,executionId,r.checkpointId,r.checkpointHash);if(source.kind!=='retained-issued-resource'||!('finalExit' in source.proof)||stableJson(value)!==stableJson(source.proof.selectedCustody.package))throw Error('Exact retained final working package required');this.authority().requireCustodyAndOwner(r);}}:{}),
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
 private async finishRetainedCapture(plan:Row):Promise<void> {
  const r=plan.reservation;if(!r.retainedSourceId)return;
  const key=`retained-final-destination:${plan.admissionId}`;
  const journal=this.branches.issuedResourceCapture(r.destination.executionId,r.destination.resourceStepId,key);
  if(!journal)throw Error('Destination final capture journal unavailable; destination held');
  if(journal.state==='retained')return;
  // A missing custody claim is the existing host authority's proof that capture
  // never began. Every retained, failed or ambiguous claim requires review.
  const observed=await this.packages().inspectCheckpoint(journal.source);
  if(observed.state!=='missing'){
   const committed=this.branches.issuedResourceCapture(r.destination.executionId,r.destination.resourceStepId,key);
   if(observed.state==='retained'&&committed?.state==='retained'&&stableJson(committed.source)===stableJson(journal.source)
    &&stableJson(committed.receipt)===stableJson(observed.receipt)){this.packages().verifyCheckpointNow(committed.receipt);return;}
   throw Error(`Destination final capture custody is ${observed.state}; destination held for review`);
  }
  this.branches.unitTransaction(()=>this.authority().requireCustodyAndOwner(r))();
  try{
   await this.packages().captureCheckpoint(journal.source,receipt=>this.branches.sealIssuedResourceCapture(r.destination.executionId,r.destination.resourceStepId,key,receipt),{wholeWorkingFolder:true});
  }catch(error){
   // An overlapping exact retry may have committed the same journal while this
   // caller waited for custody. Read that receipt; never reseal retained bytes.
   const committed=this.branches.issuedResourceCapture(r.destination.executionId,r.destination.resourceStepId,key);
   if(committed?.state!=='retained'||stableJson(committed.source)!==stableJson(journal.source))throw error;
   this.packages().verifyCheckpointNow(committed.receipt);
  }
  if(this.branches.issuedResourceCapture(r.destination.executionId,r.destination.resourceStepId,key)?.state!=='retained')
   throw Error('Destination final capture receipt unavailable; destination held');
 }
 async admit(branchId:string,executionId:string,commandKey:string,reviewHash:string):Promise<BranchIssuedDestinationDto> {
  if(typeof reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(reviewHash))throw Error('Exact current disclosure review hash required');
  const plan=this.branches.issuedDestinationPlan(branchId,executionId,commandKey),status=this.inspect(branchId,executionId,commandKey);
  const admitKey=`issued-destination-admit:${hash(commandKey)}`,inputHash=hash({commandKey,reviewHash});
  const prior=this.db.prepare('SELECT input_hash FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,admitKey) as Row|undefined;
  if(prior){if(prior.input_hash!==inputHash)throw Error('Destination admission command input conflict');if(!['admitted','capture_pending'].includes(status.state))throw Error('Destination admission receipt unavailable');
   if(status.state==='capture_pending'){await this.finishRetainedCapture(plan);return this.inspect(branchId,executionId,commandKey);}return status;}
  if(status.state==='admitted')throw Error('Destination admission command receipt missing');
  if(status.state!=='awaiting_disclosure')throw Error('Destination import is not durably prepared');
  // This is the HUMAN preview hash, never a caller-forged Runtime authority revision.
  const preview=await this.disclosures.prepare(branchId,executionId,plan.admissionId);
  if(!preview.active||preview.reviewHash!==reviewHash)throw Error('Explicit current human disclosure approval required');
  const row=this.db.prepare('SELECT stage_json FROM coordination_destination_admissions WHERE id=?').get(plan.admissionId) as Row,stage=JSON.parse(row.stage_json);
  let retainedCapture:ReturnType<BranchStore['reserveIssuedResourceCapture']>|undefined;
  this.branches.unitTransaction(()=>{
   const authority=this.authority(),review=this.coordination.reviewCoordinationDestination(plan.admissionId,authority);
   this.packages().finishDestinationImport(stage.importPlan.creationOperationId,(result,complete)=>{
    this.coordination.admitCoordinationDestination(plan.admissionId,review.reviewHash,authority,graph=>this.branches.composeIssuedDestination(plan,graph,result,complete));
    // Final provenance exists now; coverage remains inside the import and owner transaction.
    this.branches.checkpointIssuedDestination(plan);
    if(plan.reservation.retainedSourceId)retainedCapture=this.branches.reserveIssuedResourceCapture(plan.reservation.destination.executionId,plan.reservation.destination.resourceStepId,0,`retained-final-destination:${plan.admissionId}`);
   });
   this.db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(executionId,admitKey,inputHash,stableJson({admissionId:plan.admissionId,reviewHash}),new Date().toISOString());
  }).immediate();
  if(retainedCapture)await this.finishRetainedCapture(plan);
  return this.inspect(branchId,executionId,commandKey);
 }
}
