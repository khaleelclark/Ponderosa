import {groupJournalDigest} from './group-journal-audit.js';
import {sqliteCollectionGeneration} from './collection-page.js';
import {createHash} from 'node:crypto';
import {groupOwnerReviewEvidence,issuedGroupOwners,issuedGroupResources,readIssuedGroup,listGroupAuditJournals,stableJson,workspaceCreationId,type AgentStore,type BranchStore,type CoordinationV3Store,type CoordinationDestinationGroupAuthority} from '@ponderosa/agents';
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
  },true,receipt=>this.packages().readCheckpoint(receipt));
 }
 private get db(){return this.store.sqlite;}
 private authority():CoordinationDestinationGroupAuthority {
  return {requireGroupCustodyAndOwner:r=>{
   const source=this.disclosures.requireCurrentGroupOwner(r),saved=readIssuedGroup(this.db,r.sourceExecutionId,r.checkpointId,r.checkpointHash),sourceOwners=issuedGroupOwners(saved),planRow=this.db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(r.sourceExecutionId,`issued-group-destination:${hash(r.commandKey)}`) as Row|undefined;
   // During reserve the exact prospective targets are already accepted; the journal is written just after Runtime reserve.
   const plan=planRow?JSON.parse(planRow.result_json):undefined;
   for(const o of sourceOwners){
    const resources=r.resources.filter(item=>item.custody.intent.executionId===o.executionId),target=this.branches.execution(resources[0]?.destination.executionId??''),original=o.selected.execution[0];
    const targetRow=this.db.prepare('SELECT cancel_requested,provenance_json FROM branch_executions WHERE id=?').get(target?.id??'') as Row|undefined;
    const provenance=targetRow?JSON.parse(targetRow.provenance_json):undefined;
    const parentSource=original.parent_execution_id,expectedParent=parentSource?r.resources.find(item=>item.custody.intent.executionId===parentSource)?.destination.executionId:undefined;
    if(!target||!resources.length||resources.some(item=>item.destination.executionId!==target.id)||target.branchId!==original.branch_id||target.versionId!==o.versionId||target.bindingRevisionId!==o.bindingRevisionId
     ||!targetRow||targetRow.cancel_requested||!['queued','waiting'].includes(target.state)||stableJson(target.configuration)!==stableJson(o.configuration)
     ||target.parentExecutionId!==expectedParent||target.parentAttemptId!=null||parentSource&&(!provenance?.parentAttemptId||provenance.parentExecutionId!==expectedParent||target.inputHash!==hash({parentAttempt:provenance.parentAttemptId,input:original.input_text})||plan&&provenance.parentAttemptId!==plan.idMap[original.parent_attempt_id]))throw Error('Current per-owner group target unavailable');
   }
   const revisions=r.resources.map(item=>this.packages().verifyCheckpointNow(item.custody));return hash({source,revisions});
  },authorizeGroupDisclosure:this.disclosures.authorizeDisclosure,resolveArtifact:()=>{throw Error('Group runtime artifacts unsupported');}};
 }
 private reviewEvidence(plan:Row,committed:boolean):import('@ponderosa/core').BranchGroupReviewEvidence {
  const evidence=plan.reviewEvidence;
  if(evidence===undefined){if(plan.reviewEvidenceHash!==undefined)throw Error('Group review evidence missing');return {state:'unavailable',reason:'legacy_missing_saved_evidence'};}
  if(stableJson(Object.keys(evidence).sort())!==stableJson(['idMap','ownerMap','owners'])||hash(evidence)!==plan.reviewEvidenceHash||stableJson(evidence.idMap)!==stableJson(plan.idMap)||stableJson(evidence.ownerMap)!==stableJson(plan.ownerMap))throw Error('Saved group review evidence differs');
  const saved=readIssuedGroup(this.db,plan.reservation.sourceExecutionId,plan.input.checkpointId,plan.input.expectedHash),owners=issuedGroupOwners(saved);
  if(!Array.isArray(evidence.owners)||evidence.owners.length!==owners.length)throw Error('Group review owner inventory differs');
  for(const o of owners){
   const v=evidence.owners.find((v:Row)=>v.sourceExecutionId===o.executionId),target=this.db.prepare('SELECT parent_execution_id,parent_attempt_id,admission_source,admitted_at,admission_json FROM branch_executions WHERE id=?').get(plan.ownerMap[o.executionId]) as Row|undefined;
   const admission=target&&JSON.parse(target.admission_json),version=this.db.prepare('SELECT definition_json FROM branch_versions WHERE id=?').get(o.versionId) as Row|undefined;
   if(!v||!target||!admission?.budget||!version)throw Error('Exact group owner review receipt unavailable');
   const expected=groupOwnerReviewEvidence(o,JSON.parse(version.definition_json),plan.idMap,plan.ownerMap,{source:target.admission_source,admittedAt:target.admitted_at,kind:admission.kind,budget:admission.budget});
   if(stableJson(v)!==stableJson(expected)||committed&&((target.parent_execution_id??null)!==v.destinationParentExecutionId||(target.parent_attempt_id??null)!==v.destinationParentAttemptId))throw Error('Exact group owner review receipt differs');
  }
  return {state:'verified',evidenceHash:plan.reviewEvidenceHash,ancestry:committed?'committed':'prospective',...evidence};
 }
 private supported(pkg:AgentPortablePackageDto,receipt:Row){
  if(pkg.memory?.length||pkg.agents.some(a=>a.artifacts?.length||a.workingFiles?.length||a.workingFolder||a.workingRootRef||a.workingCopyMode==='separate_git'
   ||a.accessSettings?.restrictedCapabilityIds.length||a.managementPermissions.allowAutomaticDescendantDeletion||a.managementPermissions.allowAutomaticDescendantReorganization)
   ||stableJson(pkg.agents.map(a=>a.ref))!==stableJson(receipt.agentIds))throw Error('Group supports only artifact-free private organizations without memory, working roots, restrictions or elevated grants');
 }
 previewTreeCapture(branchId:string,executionId:string):import('@ponderosa/core').BranchTreeGroupCapturePreview {
  if(this.branches.execution(executionId)?.branchId!==branchId)throw Error('Tree capture owner unavailable');
  const p=this.branches.previewIssuedTreeCapture(executionId);
  return {reviewHash:p.reviewHash,versionId:p.versionId,currentAuthority:false,actionEligible:false,owners:p.resources};
 }
 discoverTreeCaptures(branchId:string,executionId:string){
  if(this.branches.execution(executionId)?.branchId!==branchId)throw Error('Tree capture owner unavailable');
  const rows=this.db.prepare("SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key LIKE 'issued-tree-capture:%' ORDER BY command_key LIMIT 101").all(executionId) as Row[];
  if(rows.length>100)throw Error('Tree capture discovery exceeds bounded inventory');
  return {items:rows.map(row=>{const v=JSON.parse(row.result_json);return {commandKey:v.commandKey,...this.treeCaptureStatus(branchId,executionId,v.commandKey)};})};
 }
 treeCaptureStatus(branchId:string,executionId:string,commandKey:string){
  if(this.branches.execution(executionId)?.branchId!==branchId)throw Error('Tree capture owner unavailable');
  const v=this.branches.issuedTreeCapture(executionId,commandKey);if(!v)throw Error('Tree capture unavailable');
  return {state:v.state,reviewHash:v.reviewHash,versionId:v.versionId,currentAuthority:false,actionEligible:false,
   checkpointId:v.checkpointId,checkpointHash:v.checkpointHash,sources:v.sources.map((source:Row)=>({executionId:source.intent.executionId,resourceStepId:source.intent.resourceStepId,sourceChatId:source.sourceChatId,sealed:v.receipts.some((r:Row)=>r.checkpointId===source.checkpointId)}))};
 }
 async captureTree(branchId:string,executionId:string,commandKey:string,expected:{reviewHash:string;versionId:string}){
  if(this.branches.execution(executionId)?.branchId!==branchId)throw Error('Tree capture owner unavailable');
  let v=this.branches.reserveIssuedTreeCapture(executionId,commandKey,expected);
  for(const source of v.sources)if(!v.receipts.some((r:Row)=>r.checkpointId===source.checkpointId)){
   const preview=this.previewTreeCapture(branchId,executionId);
   if(preview.reviewHash!==expected.reviewHash||preview.versionId!==expected.versionId)throw Error('Tree capture preview changed before package effect');
   await this.packages().captureCheckpoint(source,receipt=>this.branches.sealIssuedTreeMember(executionId,commandKey,receipt));
   v=this.branches.reserveIssuedTreeCapture(executionId,commandKey,expected);
  }
  if(v.state!=='retained')throw Error('Tree capture incomplete');
  for(const receipt of v.receipts)await this.packages().readCheckpoint(receipt);
  const retained=this.branches.issuedTreeCapture(executionId,commandKey);
  if(!retained||stableJson(retained)!==stableJson(v))throw Error('Tree capture changed during package readback');
  return {state:'retained' as const,checkpointId:v.checkpointId as number,checkpointHash:v.checkpointHash as string,receipts:v.receipts as import('@ponderosa/core').CheckpointPackageReceipt[]};
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
  const generation=hash({connection:sqliteCollectionGeneration(this.db),changes:this.db.prepare('SELECT total_changes() value').get(),external:this.db.pragma('data_version',{simple:true})});
  let after='';
  if(input.cursor){if(input.cursor.length>4096)throw Error('Group cursor too long');const c=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));if(c.kind!==input.kind||c.generation!==generation||typeof c.after!=='string')throw Error('Group discovery cursor stale or invalid');after=c.after;}
  const rows=listGroupAuditJournals(this.db,input.kind).filter(row=>stableJson([row.execution_id,row.command_key])>after).slice(0,limit+1);
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
   return {auditSelection:{kind:input.kind,branchId,executionId,journalKey:row.command_key,journalSha256:groupJournalDigest(row),custodySha256:hash(capture?{sources:v.sources,receipts:v.receipts}:v.reservation.resources.map((r:Row)=>r.custody)),...(commandKey===undefined?{}:{commandKey}),...(capture?{}:{admissionId:v.admissionId,reservationHash:v.reservationHash})},branchId,executionId,kind:input.kind,commandKey,discovery:commandKey===undefined?'unsupported_legacy_key':'exact',state:capture?v.state:retirement?'retired':admission?.state??'unavailable',admissionId:capture?undefined:v.admissionId,checkpointId:capture?v.checkpointId:v.input.checkpointId,checkpointHash:capture?v.checkpointHash:v.input.expectedHash,reviewHash:capture?v.reviewHash:undefined,versionId:capture?v.versionId:undefined,resourceCount:capture?v.sources?.length:v.reservation.resources?.length,ownerPresent:this.branches.execution(executionId)?.branchId===branchId} as import('@ponderosa/core').BranchGroupDiscoveryItem;
  });
  return {items,...(rows.length>limit?{nextCursor:Buffer.from(JSON.stringify({kind:input.kind,generation,after:stableJson([rows[limit-1]!.execution_id,rows[limit-1]!.command_key])})).toString('base64url')}:{})};
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
  const base={reviewEvidence:this.reviewEvidence(plan,row.state==='admitted'),ownerMap:plan.ownerMap,scope:plan.ownerMap&&Object.keys(plan.ownerMap).length>1?'owner_tree':'standalone',commandKey,admissionId:plan.admissionId,checkpointId:plan.input.checkpointId,checkpointHash:plan.input.expectedHash,resources:plan.reservation.resources,disclosure:choice};
  if(row.state==='admitted'){
   const receipt=this.coordination.readCoordinationDestinationGroup(plan.admissionId,plan.reservationHash,this.authority());
   const saved=readIssuedGroup(this.db,executionId,plan.input.checkpointId,plan.input.expectedHash);
   for(const o of issuedGroupOwners(saved)){
    const original=o.selected.execution[0],id=plan.ownerMap?.[o.executionId]??receipt.owners[0].executionId,e=this.branches.execution(id);
    if(!e||e.branchId!==original.branch_id||(e.parentExecutionId??null)!==(original.parent_execution_id?plan.ownerMap[original.parent_execution_id]:null)||(e.parentAttemptId??null)!==(original.parent_attempt_id?plan.idMap[original.parent_attempt_id]:null))throw Error('Exact group owner ancestry readback differs');
   }
   for(const owner of receipt.owners){
    const command=this.db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(owner.executionId,owner.receiptId) as Row;
    const result=command&&JSON.parse(command.result_json),readiness=result?.readiness;
    const cp=readiness&&this.db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=? AND execution_id=?').get(readiness.checkpointId,owner.executionId) as Row;
    if(command?.input_hash!==hash(plan)||stableJson(result?.idMap)!==stableJson(plan.idMap)||stableJson(result?.ownerMap)!==stableJson(plan.ownerMap)||!cp||cp.content_hash!==readiness.checkpointHash||hash(JSON.parse(cp.snapshot_json))!==cp.content_hash)throw Error('Exact group owner/checkpoint readback differs');
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
   const sourceOwners=issuedGroupOwners(saved);
   const ownerEngines=(receipt:Row)=>{const o=sourceOwners.find(o=>o.executionId===receipt.intent.executionId)!;return this.branches.bindingRevision(o.selected.execution[0].branch_id,o.bindingRevisionId)?.engines??{};};
   for(const receipt of saved.issuedGroupCustody){const pkg=await this.packages().readCheckpoint(receipt);this.supported(pkg,receipt);this.packages().validateAgent(pkg,ownerEngines(receipt));pkgs.set(receipt.custodyId,pkg);}
   const creationKey=`issued-group-${lock}`,projectId=workspaceCreationId('project','workspace',creationKey),conversationIds=issuedGroupResources(saved).map((_:Row,i:number)=>workspaceCreationId('conversation',projectId,`${creationKey}:chat:${i}`));
   const plan=this.branches.reserveIssuedGroupDestination(branchId,executionId,input,{projectId,conversationIds,creationKey,operatorId:BRANCH_DISCLOSURE_OPERATOR},this.authority());
   const existing=this.inspect(branchId,executionId,input.commandKey);if(existing.state==='admitted'||existing.state==='awaiting_disclosure')return existing;
   // Canonical Project/Chat writers publish exact pre-reserved identities. No imported working root is activated.
   const sourceBranch=this.branches.getBranch(branchId);
   if(!sourceBranch?.chatId)throw Error('Group source Chat owner unavailable');
   const sourceChat=this.store.getConversation(sourceBranch.chatId),sourceProject=sourceChat&&this.store.getProject(sourceChat.projectId);
   const firstPackage=pkgs.get(plan.reservation.resources[0].custody.custodyId)!;
   const defaultEngine=ownerEngines(plan.reservation.resources[0].custody)[firstPackage.agents.find(a=>a.ref===firstPackage.rootRef)!.engine];
   if(!sourceProject||!defaultEngine)throw Error('Current group Project/Engine unavailable');
   this.db.transaction(()=>this.authority().requireGroupCustodyAndOwner(plan.reservation))();
   const identity={idempotencyKey:creationKey,payloadHash:hash({projectId,branchId,executionId:plan.reservation.destination.executionId})};
   const project=this.store.getProjectCreation(identity)??this.store.createProject({label:'Restored workflow group',hostPath:sourceProject.hostPath,defaultEngine},identity);
   if(project.id!==projectId)throw Error('Prospective group Project differs');
   for(let index=0;index<plan.reservation.resources.length;index++){
    const item=plan.reservation.resources[index],d=item.destination,pkg=pkgs.get(item.custody.custodyId)!,owner=sourceOwners.find(o=>o.executionId===item.custody.intent.executionId)!,ownerBranchId=owner.selected.execution[0].branch_id;
    this.db.transaction(()=>this.authority().requireGroupCustodyAndOwner(plan.reservation))();
    const targetEngine=ownerEngines(item.custody)[pkg.agents.find(a=>a.ref===pkg.rootRef)!.engine];if(!targetEngine)throw Error('Current per-owner engine binding unavailable');
    const chat=this.store.createConversation(projectId,{title:`Restored organization ${index+1}`,defaultEngine:targetEngine},{idempotencyKey:`${creationKey}:chat:${index}`,payloadHash:hash(item)},{branchId:ownerBranchId,executionId:d.executionId});
    if(chat.id!==d.conversationId||chat.branchId!==ownerBranchId||chat.executionId!==d.executionId)throw Error('Prospective group Chat differs');
    const slot=this.db.prepare('SELECT stage_json FROM coordination_destination_group_chats WHERE admission_id=? AND source_chat_id=?').get(plan.admissionId,item.custody.sourceChatId) as Row;
    if(slot.stage_json){const op=this.store.getAgentCreationOperation(JSON.parse(slot.stage_json).importPlan.creationOperationId);
     if(op?.status==='canonical_committed'&&(op.result as Row)?.branchDestinationPrepared===true)continue;
     throw Error('Uncertain group slot remains held; no reimport');}
    await this.packages().importAgent(projectId,d.conversationId,pkg,ownerEngines(item.custody),`issued-group-import-${plan.admissionId}-${index}`,{
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
