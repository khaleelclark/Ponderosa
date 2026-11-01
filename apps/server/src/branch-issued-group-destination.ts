import {sqliteCollectionGeneration} from './collection-page.js';
import {createHash} from 'node:crypto';
import {readIssuedGroup,stableJson,workspaceCreationId,type AgentStore,type BranchStore,type CoordinationV3Store,type CoordinationDestinationGroupAuthority} from '@ponderosa/agents';
import type {BranchIssuedDestinationInput,AgentPortablePackageDto} from '@ponderosa/core';
import {BRANCH_DISCLOSURE_OPERATOR,BranchDisclosureReviewService} from './branch-disclosure-review.js';
import type {BranchPackageEngine} from './routes/agent-packages.js';
type Row=Record<string,any>;
const hash=(v:unknown)=>createHash('sha256').update(stableJson(v)).digest('hex');

/** Bounded generation-zero resource consumer; imports stay held through one human choice. */
export class BranchIssuedGroupDestinationService {
 private readonly preparing=new Set<string>();
 readonly disclosures:BranchDisclosureReviewService;
 constructor(private readonly store:AgentStore,private readonly branches:BranchStore,private readonly coordination:CoordinationV3Store,private readonly packages:()=>BranchPackageEngine){
  this.disclosures=new BranchDisclosureReviewService(store,branches,coordination,async(executionId,checkpointId,expectedHash)=>{
   const saved=readIssuedGroup(this.db,executionId,checkpointId,expectedHash);
   for(const receipt of saved.issuedGroupCustody)await this.packages().readCheckpoint(receipt);
   readIssuedGroup(this.db,executionId,checkpointId,expectedHash);
  },true);
 }
 private get db(){return this.store.sqlite;}
 private authority():CoordinationDestinationGroupAuthority {
  return {requireGroupCustodyAndOwner:r=>{
   const source=this.disclosures.requireCurrentGroupOwner(r),target=this.branches.execution(r.resources[0]!.destination.executionId);
   const saved=readIssuedGroup(this.db,r.sourceExecutionId,r.checkpointId,r.checkpointHash);
   const targetRow=this.db.prepare('SELECT cancel_requested FROM branch_executions WHERE id=?').get(target?.id??'') as Row|undefined;
   if(!target||target.branchId!==r.branchId||target.versionId!==saved.issuedContinuation.versionId||target.bindingRevisionId!==saved.issuedContinuation.bindingRevisionId
    ||!targetRow||targetRow.cancel_requested
    ||!['queued','waiting'].includes(target.state)||r.resources.some(item=>item.destination.executionId!==target.id))throw Error('Current group target owner unavailable');
   const revisions=r.resources.map(item=>this.packages().verifyCheckpointNow(item.custody));return hash({source,revisions});
  },authorizeGroupDisclosure:this.disclosures.authorizeDisclosure,resolveArtifact:()=>{throw Error('Group runtime artifacts unsupported');}};
 }
 private supported(pkg:AgentPortablePackageDto,receipt:Row){
  if(pkg.memory?.length||pkg.agents.some(a=>a.artifacts?.length||a.workingFiles?.length||a.workingFolder||a.workingRootRef||a.workingCopyMode==='separate_git'
   ||a.accessSettings?.restrictedCapabilityIds.length||a.managementPermissions.allowAutomaticDescendantDeletion||a.managementPermissions.allowAutomaticDescendantReorganization)
   ||stableJson(pkg.agents.map(a=>a.ref))!==stableJson(receipt.agentIds))throw Error('Group supports only artifact-free private organizations without memory, working roots, restrictions or elevated grants');
 }
 previewCapture(branchId:string,executionId:string){
  if(this.branches.execution(executionId)?.branchId!==branchId)throw Error('Group capture owner unavailable');
  const p=this.branches.previewIssuedGroupCapture(executionId);
  return {reviewHash:p.reviewHash,versionId:p.versionId,bindingRevisionId:p.bindingRevisionId,frontierHash:hash(p.snapshot.selected),hostCutHash:hash(p.snapshot.hostDependencies),resources:p.resources};
 }
 /** Operator audit discovery also works after owner deletion; never executes a saved command. */
 discover(input:{kind:'captures'|'admissions';limit?:number;cursor?:string}):import('@ponderosa/core').BranchGroupDiscoveryPage {
  const limit=input.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Group discovery limit must be 1..100');
  if(!['captures','admissions'].includes(input.kind))throw Error('Group discovery kind required');
  const prefix=input.kind==='captures'?'issued-group-capture:%':'issued-group-destination:%';
  const generation=hash({connection:sqliteCollectionGeneration(this.db),changes:this.db.prepare('SELECT total_changes() value').get(),external:this.db.pragma('data_version',{simple:true})});
  let after=0;
  if(input.cursor){if(input.cursor.length>4096)throw Error('Group cursor too long');const c=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));if(c.kind!==input.kind||c.generation!==generation||!Number.isSafeInteger(c.after)||c.after<0)throw Error('Group discovery cursor stale or invalid');after=c.after;}
  const rows=this.db.prepare('SELECT rowid,execution_id,command_key,input_hash,result_json FROM branch_commands WHERE command_key LIKE ? AND rowid>? ORDER BY rowid LIMIT ?').all(prefix,after,limit+1) as Row[];
  const items=rows.slice(0,limit).map(row=>{
   const v=JSON.parse(row.result_json);if(stableJson(v)!==row.result_json)throw Error('Noncanonical group journal');
   const capture=input.kind==='captures',e=capture?v.snapshot?.selected?.execution?.[0]:undefined;
   const resources=capture?v.snapshot?.selected?.resources:v.reservation?.resources;
   if(!Array.isArray(resources)||resources.length<2||resources.length>32||capture&&(v.snapshot?.captureKind!=='issued_group'||!['capturing','retained'].includes(v.state)||v.sources?.length!==resources.length)||!capture&&v.schema!=='ponderosa.branch.issued-group-destination.v1')throw Error('Group discovery journal shape differs');
   const branchId=capture?e?.branch_id:v.reservation?.branchId,executionId=capture?e?.id:v.reservation?.sourceExecutionId,commandKey=capture?v.commandKey:v.input?.commandKey;
   if(typeof branchId!=='string'||executionId!==row.execution_id||!capture&&v.reservation?.operatorId!==BRANCH_DISCLOSURE_OPERATOR)throw Error('Group audit journal scope differs');
   if(capture&&commandKey!==undefined&&(v.reviewHash!==hash(v.snapshot)||v.versionId!==e?.version_id))throw Error('Group discovery preview differs');
   if(commandKey!==undefined&&(typeof commandKey!=='string'||!commandKey.trim()||commandKey.length>200||row.command_key!==`${capture?'issued-group-capture':'issued-group-destination'}:${hash(commandKey)}`||row.input_hash!==hash(capture?{commandKey}:v.input)))throw Error('Group discovery key integrity differs');
   const admission=!capture?this.db.prepare('SELECT state,reservation_hash,reservation_json FROM coordination_destination_admissions WHERE id=?').get(v.admissionId) as Row|undefined:undefined;
   const retirement=!capture?this.db.prepare('SELECT receipt_json,evidence_json FROM coordination_destination_retirements WHERE admission_id=?').get(v.admissionId) as Row|undefined:undefined;
   if(admission&&(admission.reservation_hash!==v.reservationHash||admission.reservation_json!==stableJson(v.reservation)))throw Error('Group discovery reservation differs');
   if(retirement){const evidence=JSON.parse(retirement.evidence_json);if(evidence.row?.reservation_json!==stableJson(v.reservation)||hash(v.reservation)!==v.reservationHash)throw Error('Group retired discovery evidence differs');}
   return {branchId,executionId,kind:input.kind,commandKey,discovery:commandKey===undefined?'unsupported_legacy_key':'exact',state:capture?v.state:retirement?'retired':admission?.state??'unavailable',admissionId:capture?undefined:v.admissionId,checkpointId:capture?v.checkpointId:v.input.checkpointId,checkpointHash:capture?v.checkpointHash:v.input.expectedHash,reviewHash:capture?v.reviewHash:undefined,versionId:capture?v.versionId:undefined,resourceCount:capture?v.sources?.length:v.reservation.resources?.length,ownerPresent:this.branches.execution(executionId)?.branchId===branchId} as import('@ponderosa/core').BranchGroupDiscoveryItem;
  });
  return {items,...(rows.length>limit?{nextCursor:Buffer.from(JSON.stringify({kind:input.kind,generation,after:rows[limit-1]!.rowid})).toString('base64url')}:{})};
 }
 captureStatus(branchId:string,executionId:string,commandKey:string){
  if(this.branches.execution(executionId)?.branchId!==branchId)throw Error('Group capture owner unavailable');
  return this.branches.issuedGroupCaptureStatus(executionId,commandKey);
 }
 async capture(branchId:string,executionId:string,commandKey:string,expectedReview:{reviewHash:string;versionId:string}){
  if(this.branches.execution(executionId)?.branchId!==branchId)throw Error('Group capture owner unavailable');
  let journal=this.branches.reserveIssuedGroupCapture(executionId,commandKey,expectedReview);
  for(const source of journal.sources)if(!journal.receipts.some((r:Row)=>r.checkpointId===source.checkpointId)){
   const current=this.previewCapture(branchId,executionId);
   if(current.reviewHash!==expectedReview.reviewHash||current.versionId!==expectedReview.versionId)throw Error('Group capture preview changed before package effect');
   await this.packages().captureCheckpoint(source,receipt=>this.branches.sealIssuedGroupMember(executionId,commandKey,receipt));
   journal=this.branches.reserveIssuedGroupCapture(executionId,commandKey,expectedReview);
  }
  if(journal.state!=='retained')throw Error('Group capture remains unsealed');
  readIssuedGroup(this.db,executionId,journal.checkpointId,journal.checkpointHash);
  return {state:journal.state,checkpointId:journal.checkpointId,checkpointHash:journal.checkpointHash,receipts:journal.receipts};
 }
 inspect(branchId:string,executionId:string,commandKey:string){
  const plan=this.branches.issuedGroupDestinationPlan(branchId,executionId,commandKey),row=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(plan.admissionId) as Row;
  const choice=row.stage_json?this.disclosures.readChoice(branchId,executionId,plan.admissionId):{revision:0,state:'unreviewed'};
  const base={commandKey,admissionId:plan.admissionId,checkpointId:plan.input.checkpointId,checkpointHash:plan.input.expectedHash,resources:plan.reservation.resources,disclosure:choice};
  if(row.state==='admitted'){
   const receipt=this.coordination.readCoordinationDestinationGroup(plan.admissionId,plan.reservationHash,this.authority());
   for(const owner of receipt.owners){
    const command=this.db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(owner.executionId,owner.receiptId) as Row;
    const result=command&&JSON.parse(command.result_json),readiness=result?.readiness;
    const cp=readiness&&this.db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=? AND execution_id=?').get(readiness.checkpointId,owner.executionId) as Row;
    if(command?.input_hash!==hash(plan)||stableJson(result?.idMap)!==stableJson(plan.idMap)||!cp||cp.content_hash!==readiness.checkpointHash||hash(JSON.parse(cp.snapshot_json))!==cp.content_hash)throw Error('Exact group owner/checkpoint readback differs');
   }
   return {...base,state:'admitted',restoreSupported:true,receipt};
  }
  const slots=this.db.prepare('SELECT stage_json FROM coordination_destination_group_chats WHERE admission_id=?').all(plan.admissionId) as Row[];
  const prepared=slots.length===plan.reservation.resources.length&&slots.every(slot=>{if(!slot.stage_json)return false;const op=this.store.getAgentCreationOperation(JSON.parse(slot.stage_json).importPlan.creationOperationId);return op?.status==='canonical_committed'&&(op.result as Row)?.branchDestinationPrepared===true;});
  return {...base,state:prepared?'awaiting_disclosure':slots.some(s=>s.stage_json)?'import_unknown':'reserved',restoreSupported:false};
 }
 async prepare(branchId:string,executionId:string,input:BranchIssuedDestinationInput){
  if(typeof input.commandKey!=='string'||!input.commandKey.trim()||input.commandKey.length>200||!Number.isSafeInteger(input.checkpointId)||input.checkpointId<1||!/^[a-f0-9]{64}$/.test(input.expectedHash)||input.reconcileEffects!==true)throw Error('Exact group checkpoint command/reconciliation required');
  const lock=hash({branchId,executionId,commandKey:input.commandKey});if(this.preparing.has(lock))throw Error('Group preparation in progress; read exact command');this.preparing.add(lock);
  try{
   const prior=this.db.prepare('SELECT input_hash FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,`issued-group-destination:${hash(input.commandKey)}`) as Row|undefined;
   if(prior){if(prior.input_hash!==hash(input))throw Error('Group command input conflict');const status=this.inspect(branchId,executionId,input.commandKey);if(status.state==='admitted'||status.state==='awaiting_disclosure')return status;}
   const saved=readIssuedGroup(this.db,executionId,input.checkpointId,input.expectedHash),pkgs=new Map<string,AgentPortablePackageDto>();
   const bindings=this.branches.bindingRevision(branchId,saved.issuedContinuation.bindingRevisionId),engines=bindings?.engines??{};
   for(const receipt of saved.issuedGroupCustody){const pkg=await this.packages().readCheckpoint(receipt);this.supported(pkg,receipt);this.packages().validateAgent(pkg,engines);pkgs.set(receipt.custodyId,pkg);}
   const creationKey=`issued-group-${lock}`,projectId=workspaceCreationId('project','workspace',creationKey),conversationIds=saved.selected.resources.map((_:Row,i:number)=>workspaceCreationId('conversation',projectId,`${creationKey}:chat:${i}`));
   const plan=this.branches.reserveIssuedGroupDestination(branchId,executionId,input,{projectId,conversationIds,creationKey,operatorId:BRANCH_DISCLOSURE_OPERATOR},this.authority());
   const existing=this.inspect(branchId,executionId,input.commandKey);if(existing.state==='admitted'||existing.state==='awaiting_disclosure')return existing;
   // Canonical Project/Chat writers publish exact pre-reserved identities. No imported working root is activated.
   const sourceBranch=this.branches.getBranch(branchId);
   if(!sourceBranch?.chatId)throw Error('Group source Chat owner unavailable');
   const sourceChat=this.store.getConversation(sourceBranch.chatId),sourceProject=sourceChat&&this.store.getProject(sourceChat.projectId);
   const firstPackage=pkgs.get(plan.reservation.resources[0].custody.custodyId)!;
   const defaultEngine=engines[firstPackage.agents.find(a=>a.ref===firstPackage.rootRef)!.engine];
   if(!sourceProject||!defaultEngine)throw Error('Current group Project/Engine unavailable');
   this.db.transaction(()=>this.authority().requireGroupCustodyAndOwner(plan.reservation))();
   const identity={idempotencyKey:creationKey,payloadHash:hash({projectId,branchId,executionId:plan.reservation.destination.executionId})};
   const project=this.store.getProjectCreation(identity)??this.store.createProject({label:'Restored workflow group',hostPath:sourceProject.hostPath,defaultEngine},identity);
   if(project.id!==projectId)throw Error('Prospective group Project differs');
   for(let index=0;index<plan.reservation.resources.length;index++){
    const item=plan.reservation.resources[index],d=item.destination,pkg=pkgs.get(item.custody.custodyId)!;
    this.db.transaction(()=>this.authority().requireGroupCustodyAndOwner(plan.reservation))();
    const chat=this.store.createConversation(projectId,{title:`Restored organization ${index+1}`,defaultEngine},{idempotencyKey:`${creationKey}:chat:${index}`,payloadHash:hash(item)},{branchId,executionId:d.executionId});
    if(chat.id!==d.conversationId||chat.branchId!==branchId||chat.executionId!==d.executionId)throw Error('Prospective group Chat differs');
    const slot=this.db.prepare('SELECT stage_json FROM coordination_destination_group_chats WHERE admission_id=? AND source_chat_id=?').get(plan.admissionId,item.custody.sourceChatId) as Row;
    if(slot.stage_json){const op=this.store.getAgentCreationOperation(JSON.parse(slot.stage_json).importPlan.creationOperationId);
     if(op?.status==='canonical_committed'&&(op.result as Row)?.branchDestinationPrepared===true)continue;
     throw Error('Uncertain group slot remains held; no reimport');}
    await this.packages().importAgent(projectId,d.conversationId,pkg,engines,`issued-group-import-${plan.admissionId}-${index}`,{
     ...(input.accessSettingsResolution?{accessSettingsResolution:input.accessSettingsResolution}:{}),branchHooks:{
      stage:importPlan=>{this.authority().requireGroupCustodyAndOwner(plan.reservation);this.coordination.stageCoordinationDestinationGroupResource(plan.admissionId,item.custody.sourceChatId,{importPlan,agentMap:Object.fromEntries(importPlan.agents.map(a=>[a.sourceRef,a.agentId])),artifactMap:{}});},
      plan:()=>{this.db.transaction(()=>this.authority().requireGroupCustodyAndOwner(plan.reservation))();},
      commit:()=>{throw Error('Explicit whole-group disclosure required');},holdForDisclosure:()=>{this.authority().requireGroupCustodyAndOwner(plan.reservation);},transaction:operation=>this.branches.unitTransaction(operation)(),
     },
    });
   }
   return this.inspect(branchId,executionId,input.commandKey);
  }finally{this.preparing.delete(lock);}
 }
 async admit(branchId:string,executionId:string,commandKey:string,reviewHash:string){
  if(typeof reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(reviewHash))throw Error('Exact whole-group human review hash required');
  const plan=this.branches.issuedGroupDestinationPlan(branchId,executionId,commandKey),status=this.inspect(branchId,executionId,commandKey),key=`issued-group-admit:${hash(commandKey)}`,inputHash=hash({commandKey,reviewHash});
  const prior=this.db.prepare('SELECT input_hash FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,key) as Row|undefined;
  if(prior){if(prior.input_hash!==inputHash||status.state!=='admitted')throw Error('Group admission command conflict');return status;}
  if(status.state!=='awaiting_disclosure')throw Error('Group imports not prepared');
  const preview=await this.disclosures.prepare(branchId,executionId,plan.admissionId);
  if(!preview.active||preview.reviewHash!==reviewHash)throw Error('Current whole-group human approval required');
  const stage=JSON.parse((this.db.prepare('SELECT stage_json FROM coordination_destination_admissions WHERE id=?').get(plan.admissionId) as Row).stage_json);
  this.branches.unitTransaction(()=>{
   const authority=this.authority(),review=this.coordination.reviewCoordinationDestinationGroup(plan.admissionId,authority);
   const operations=plan.reservation.resources.map((item:Row)=>stage.imports[item.custody.sourceChatId].creationOperationId);
   const imports:Parameters<BranchStore['composeIssuedGroupDestination']>[2]=[];
   const finish=(index:number):void=>{
    if(index===operations.length){
     this.coordination.admitCoordinationDestinationGroup(plan.admissionId,review.reviewHash,authority,graph=>this.branches.composeIssuedGroupDestination(plan,graph,imports));
     // Final provenance exists now; snapshot is still inside every import wrapper and the outer owner commit.
     this.branches.checkpointIssuedGroupDestination(plan);return;
    }
    this.packages().finishDestinationImport(operations[index],(result,complete)=>{imports.push({result,complete});finish(index+1);});
   };
   finish(0);
   this.db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(executionId,key,inputHash,stableJson({admissionId:plan.admissionId,reviewHash}),new Date().toISOString());
  }).immediate();return this.inspect(branchId,executionId,commandKey);
 }
}
