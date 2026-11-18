import {generationHistoricalSelections} from '@ponderosa/agents';
import {createHash} from 'node:crypto';
import {
 readDestinationHistoricalPartition,destinationHistoricalFacts,destinationDisclosurePolicy,readIssuedGroup,issuedGroupOwners,issuedGroupHost,stableJson,
 type AgentStore,type BranchStore,type CoordinationV3Store,
} from '@ponderosa/agents';
import type {
 BranchDisclosureChoice,BranchDisclosureReceipt,BranchDisclosureReviewDto,
 CoordinationDestinationReservation,CoordinationDestinationReview,
} from '@ponderosa/core';

type Review=Omit<CoordinationDestinationReview,'reviewHash'|'disclosureRevision'>;
type Row=Record<string,any>;
const hash=(v:unknown)=>createHash('sha256').update(stableJson(v)).digest('hex');
// The existing host/origin operator boundary represents this single local human.
// Never derive this from a header, profile, rate-limit pseudonym or request body.
export const BRANCH_DISCLOSURE_OPERATOR='local-operator';
const currentKey=(id:string)=>`issued-disclosure:${hash(id)}`;
const commandKey=(key:string)=>`issued-disclosure-command:${hash(key)}`;
const keyValid=(key:unknown):key is string=>typeof key==='string'&&!!key.trim()&&key.length<=200;

/** Explicit human choice only. This grants no artifact access and admits no work. */
export class BranchDisclosureReviewService {
 constructor(private readonly store:AgentStore,private readonly branches:BranchStore,private readonly coordination:CoordinationV3Store,
  private readonly verifyCustody:(executionId:string,checkpointId:number,expectedHash:string)=>Promise<void>,private readonly group=false,private readonly verifyHistoricalPackage?:(receipt:import('@ponderosa/core').CheckpointPackageReceipt)=>Promise<unknown>) {}
 private get db(){return this.store.sqlite;}
 private admission(branchId:string,executionId:string,id:string):Row {
  const row=this.db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=? AND branch_id=? AND source_execution_id=?').get(id,branchId,executionId) as Row|undefined;
  if(!row||!row.stage_json||!['staged','admitted'].includes(row.state))throw Error('Staged disclosure destination unavailable');
  const r=JSON.parse(row.reservation_json),snapshot=JSON.parse(row.snapshot_json);
  if(stableJson(r)!==row.reservation_json||hash(r)!==row.reservation_hash||stableJson(snapshot)!==row.snapshot_json||hash(snapshot)!==r.checkpointHash
   ||r.operatorId!==BRANCH_DISCLOSURE_OPERATOR||r.branchId!==branchId||r.sourceExecutionId!==executionId)throw Error('Disclosure reservation integrity/operator mismatch');
  if(Boolean(r.resources)!==this.group)throw Error('Use exact group disclosure surface');
  this.auditRead(row);
  return row;
 }
 private auditRead(row:Row):void {
  // Existing product rule: the single local operator owns Project audit surfaces.
  // Keep this explicit; an Agent relationship or artifact recipient grant is unrelated.
  const snapshot=JSON.parse(row.snapshot_json),host=this.group?issuedGroupHost(snapshot):snapshot.hostDependencies;
  if(!host?.coverage?.complete||host.artifactRefs?.length||!Array.isArray(host.requests)||!host.requests.length)throw Error('Disclosure requires complete artifact-free issued facts');
  const reservation=JSON.parse(row.reservation_json);
  if(reservation.retainedSourceId){
   const source=this.branches.retainedDestinationInstallationEvidence(reservation.retainedSourceId);
   if(source.source.branch_id!==row.branch_id||source.source.local_execution_id!==row.source_execution_id||source.source.original_snapshot_json!==row.snapshot_json)throw Error('Imported operator audit source differs');
   return;
  }
  const projects=new Set<string>(host.requests.map((e:Row)=>e.row.project_id));
  for(const projectId of projects)if(!this.store.getProject(projectId)||this.db.prepare('SELECT 1 FROM project_deletion_pending WHERE project_id=?').get(projectId))throw Error('Original Project operator audit-read unavailable');
 }
 private historicalAuditRead(entries:ReturnType<typeof readDestinationHistoricalPartition>):void {
  const projects=new Set<string>();
  for(const p of entries){projects.add((p.seal as Row).identity.projectId);for(const e of (p.seal as Row).envelope.hostDependencies.requests)projects.add(e.row.project_id);}
  for(const projectId of projects)if(!this.store.getProject(projectId)||this.db.prepare('SELECT 1 FROM project_deletion_pending WHERE project_id=?').get(projectId))throw Error('Original historical Project operator audit-read unavailable');
 }
 requireCurrentGroupOwner(reservation:CoordinationDestinationReservation):string {
  if(!this.db.inTransaction||!reservation.resources||reservation.resources.length<2||reservation.resources.length>32)throw Error('Bounded group owner transaction required');
  const saved=readIssuedGroup(this.db,reservation.sourceExecutionId,reservation.checkpointId,reservation.checkpointHash),owners=issuedGroupOwners(saved),seals=[];
  this.branches.assertIssuedGroupSourcesCurrent(saved);
  if(owners.find(o=>o.executionId===reservation.sourceExecutionId)?.selected.execution[0].branch_id!==reservation.branchId)throw Error('Group source root differs');
  for(const c of owners){
   const original=c.selected.execution[0],e=this.db.prepare(`SELECT e.*,b.deleting,b.enabled,b.active_version_id,b.binding_revision_id current_binding,b.configuration_json current_configuration
    FROM branch_executions e JOIN branches b ON b.id=e.branch_id WHERE e.id=? AND b.id=?`).get(c.executionId,original.branch_id) as Row;
   if(!e||e.deleting||!e.enabled||!['completed','failed','canceled'].includes(e.state)||e.active_version_id!==c.versionId||e.current_binding!==c.bindingRevisionId
    ||e.version_id!==c.versionId||e.binding_revision_id!==c.bindingRevisionId||e.parent_execution_id!==original.parent_execution_id||e.parent_attempt_id!==original.parent_attempt_id
    ||Object.keys(JSON.parse(e.current_configuration).secretBindings??{}).length||hash(Object.fromEntries(Object.entries(JSON.parse(e.current_configuration)).filter(([k])=>k!=='secretBindings')))!==hash(c.configuration)
    ||!this.branches.resourceHistoryCustodySettled(e.id))throw Error('Current per-owner group source unavailable');
   seals.push({executionId:e.id,configuration:e.current_configuration,version:e.active_version_id,binding:e.current_binding});
  }
  for(const item of reservation.resources){
   const receipt=saved.issuedGroupCustody.find((r:Row)=>r.intent.resourceStepId===item.custody.intent.resourceStepId);
   const r=this.db.prepare('SELECT * FROM branch_resources WHERE step_execution_id=? AND execution_id=?').get(item.custody.intent.resourceStepId,item.custody.intent.executionId) as Row;
   const members=(this.db.prepare('SELECT agent_id FROM branch_resource_members WHERE step_execution_id=? ORDER BY agent_id').all(r?.step_execution_id) as Row[]).map(m=>m.agent_id);
   if(stableJson(receipt)!==stableJson(item.custody)||!r||r.state!=='retired'||r.generation!==0||r.chat_id!==receipt.sourceChatId||stableJson(members)!==stableJson([...receipt.agentIds].sort()))throw Error('Current group resource custody differs');
   for(const id of members)if(this.db.prepare(`SELECT 1 FROM provider_process_authority WHERE agent_id=? UNION ALL SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running','outcome_unknown') UNION ALL SELECT 1 FROM agent_deletion_pending WHERE agent_id=? LIMIT 1`).get(id,id,id))throw Error('Group source participant not drained');
  }
  for(const fact of issuedGroupHost(saved).requests){const live=this.db.prepare('SELECT state FROM coordination_requests WHERE id=?').get(fact.row.id) as Row|undefined;
   if(live&&!['completed','failed','blocked','cancelled','expired','recipient_unavailable','superseded'].includes(live.state))throw Error('Group source effect unresolved');}
  return hash({custody:saved.issuedGroupCustody,owners:seals});
 }
 private policy(r:CoordinationDestinationReservation,stage:Row):unknown {
  return this.group?r.resources!.map(item=>({sourceChatId:item.custody.sourceChatId,policy:destinationDisclosurePolicy(this.db,{...r,custody:item.custody,destination:item.destination},{importPlan:stage.imports[item.custody.sourceChatId],agentMap:Object.fromEntries(item.custody.agentIds.map(id=>[id,stage.agentMap[id]])),artifactMap:{}})})):destinationDisclosurePolicy(this.db,r,stage as any);
 }
 requireCurrentOwner(reservation:CoordinationDestinationReservation):string {
  if(!this.db.inTransaction)throw Error('Disclosure custody proof requires owner transaction');
  const saved=this.branches.issuedDestinationSource(reservation.branchId,reservation.sourceExecutionId,reservation.checkpointId,reservation.checkpointHash);
  if(saved.kind==='retained-issued-resource'){
   if(!reservation.retainedSourceId)throw Error('Pinned imported source required');
   const source=this.branches.retainedDestinationInstallationEvidence(reservation.retainedSourceId),branch=this.branches.getBranch(reservation.branchId);
   if(source.source.local_execution_id!==reservation.sourceExecutionId||source.source.original_snapshot_json!==stableJson(saved.proof.selected)
    ||!branch?.enabled||!branch.versionId||!branch.bindingRevisionId||hash(this.branches.version(branch.id,branch.versionId)!.definition)!==saved.continuation.versionHash
    ||stableJson(this.branches.configuration(branch.id))!==stableJson(saved.continuation.configuration)
    ||stableJson(saved.custody)!==stableJson(reservation.custody))throw Error('Current imported destination owner differs');
   return hash({source:source.source,branch,pins:this.branches.localConfiguration(branch.id),custody:saved.proof.selectedCustody});
  }
  if(stableJson(saved.custody)!==stableJson(reservation.custody)||saved.custody.intent.hostCutSha256!==hash(saved.hostDependencies))throw Error('Disclosure issued custody differs');
  const e=this.db.prepare(`SELECT e.*,b.deleting,b.enabled,b.active_version_id,b.binding_revision_id current_binding,b.configuration_json current_configuration
   FROM branch_executions e JOIN branches b ON b.id=e.branch_id WHERE e.id=? AND b.id=?`).get(reservation.sourceExecutionId,reservation.branchId) as Row|undefined;
  const r=this.db.prepare('SELECT * FROM branch_resources WHERE execution_id=? AND step_execution_id=?').get(reservation.sourceExecutionId,saved.custody.intent.resourceStepId) as Row|undefined;
  const openingCapture=r&&this.branches.resourceCaptureJournal(r.step_execution_id);
  if(!e||e.deleting||!e.enabled||!['completed','failed','canceled'].includes(e.state)||e.active_version_id!==saved.continuation.versionId
   ||e.current_binding!==saved.continuation.bindingRevisionId||Object.keys(JSON.parse(e.current_configuration).secretBindings??{}).length
   ||hash(Object.fromEntries(Object.entries(JSON.parse(e.current_configuration)).filter(([k])=>k!=='secretBindings')))!==saved.custody.intent.configurationSha256
   ||!r||r.generation!==0&&!(r.generation>0&&saved.continuation.generationRetry&&stableJson(reservation.historicalPartition)===stableJson(generationHistoricalSelections(saved.continuation.generationRetry)))||r.generation!==saved.custody.intent.resourceGeneration||r.chat_id!==saved.custody.sourceChatId
   ||r.state!=='retired'||!this.branches.resourceHistoryCustodySettled(reservation.sourceExecutionId,saved.continuation.generationRetry)||openingCapture&&openingCapture.state!=='retained')throw Error('Current disclosure custody/owner unavailable');
  const ids=(this.db.prepare('SELECT agent_id FROM branch_resource_members WHERE step_execution_id=? ORDER BY agent_id').all(r.step_execution_id) as {agent_id:string}[]).map(m=>m.agent_id);
  if(stableJson(ids)!==stableJson([...saved.custody.agentIds].sort()))throw Error('Disclosure current resource membership changed');
  for(const id of ids)if(this.db.prepare(`SELECT 1 FROM agent_deletion_pending WHERE agent_id=? UNION ALL SELECT 1 FROM provider_process_authority WHERE agent_id=?
    UNION ALL SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running') LIMIT 1`).get(id,id,id))throw Error('Disclosure source participant unavailable or not drained');
  for(const fact of saved.hostDependencies.requests){
   const live=this.db.prepare('SELECT state FROM coordination_requests WHERE id=?').get(fact.row.id) as Row|undefined;
   if(live&&!['completed','failed','blocked','cancelled','expired','recipient_unavailable','superseded'].includes(live.state))throw Error('Disclosure source effects remain unresolved');
  }
  return hash({receipt:saved.custody,owner:{branchId:e.branch_id,version:e.active_version_id,binding:e.current_binding,configuration:e.current_configuration},members:ids});
 }
 private state(row:Row):Row {
  const current=this.db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(row.source_execution_id,currentKey(row.id)) as Row|undefined;
  if(!current)return {revision:0,state:'unreviewed'};
  const value=JSON.parse(current.result_json);
  if(stableJson(value)!==current.result_json||hash(value)!==current.input_hash||value.admissionId!==row.id||!Number.isSafeInteger(value.revision)||value.revision<1||!['approved','revoked'].includes(value.state))throw Error('Disclosure choice integrity failure');
  return value;
 }
 /** The current local operator may inspect committed imported history after cleanup.
  * This does not approve disclosure to new Agents or revive an old approval. */
 authorizeRetainedReceipt(id:string,reservation:CoordinationDestinationReservation):string {
  const row=this.admission(reservation.branchId,reservation.sourceExecutionId,id);
  const branch=this.db.prepare('SELECT deleting FROM branches WHERE id=?').get(reservation.branchId) as Row|undefined;
  if(!reservation.retainedSourceId||!branch||branch.deleting||row.state!=='admitted'||row.reservation_json!==stableJson(reservation))
   throw Error('Current retained destination operator audit unavailable');
  return hash({operatorId:BRANCH_DISCLOSURE_OPERATOR,admissionId:id,reservationHash:row.reservation_hash});
 }
 readChoice(branchId:string,executionId:string,id:string):{revision:number;state:'unreviewed'|'approved'|'revoked';reviewHash?:string} {
  const current=this.state(this.admission(branchId,executionId,id));
  return {revision:current.revision,state:current.state,reviewHash:current.reviewHash};
 }
 private candidate(row:Row):BranchDisclosureReviewDto {
  const {review,policy}=this.group?this.coordination.inspectCoordinationDestinationGroupDisclosure(row.id,{
   requireGroupCustodyAndOwner:r=>this.requireCurrentGroupOwner(r),authorizeGroupDisclosure:()=>{throw Error('Preview grants no disclosure');},resolveArtifact:()=>{throw Error('Group artifacts unsupported');},
  }):this.coordination.inspectCoordinationDestinationDisclosure(row.id,r=>this.requireCurrentOwner(r));
  const snapshot=JSON.parse(row.snapshot_json),host=this.group?issuedGroupHost(snapshot):snapshot.hostDependencies,policyRevision=hash(policy),hostCutSha256=hash(host);
  const groups:Record<string,Row[]>={request:host.requests,update:host.updates,communication:host.communications,join:host.joins};
  const historical=readDestinationHistoricalPartition(this.db,review.reservation,review.stage);this.historicalAuditRead(historical);
  const facts=review.facts.map(f=>{
   if(f.kind==='historical_generation'){
    const p=historical.find(p=>hash(p.selection)===f.id);
    if(!p||hash({seal:p.seal,retirement:p.retirement})!==f.sha256)throw Error('Historical disclosure seal differs');
    return {...f,content:{seal:p.seal,retirement:p.retirement}};
   }
   const evidence=groups[f.kind]?.find(e=>e.row.id===f.id);
   if(!evidence||evidence.sha256!==f.sha256||hash(evidence.row)!==f.sha256)throw Error('Disclosure fact content integrity failure');
   return {...f,content:evidence.row};
  });
  const state=this.state(row),reviewHash=hash({review,policyRevision,hostCutSha256});
  return {admissionId:row.id,reviewHash,revision:state.revision,state:state.state,active:state.state==='approved'&&state.reviewHash===reviewHash,policyRevision,hostCutSha256,review,facts,policy};
 }
 async prepare(branchId:string,executionId:string,id:string):Promise<BranchDisclosureReviewDto> {
  const row=this.admission(branchId,executionId,id),r=JSON.parse(row.reservation_json);
  if(r.retainedSourceId)this.db.transaction(()=>this.requireCurrentOwner(r))();
  else await this.verifyCustody(executionId,r.checkpointId,r.checkpointHash);
  const historical=this.db.transaction(()=>readDestinationHistoricalPartition(this.db,r,JSON.parse(row.stage_json)))();
  this.historicalAuditRead(historical);
  for(const p of historical){
   if(!this.verifyHistoricalPackage)throw Error('Historical package verifier unavailable');
   await this.verifyHistoricalPackage((p.seal as Row).receipt);
  }
  const after=this.db.transaction(()=>readDestinationHistoricalPartition(this.db,r,JSON.parse(row.stage_json)))();
  if(hash(after)!==hash(historical))throw Error('Historical custody changed during review');
  return this.db.transaction(()=>this.candidate(this.admission(branchId,executionId,id)))();
 }
 private active(current:Row):boolean {
  if(current.state!=='approved')return false;
  try{this.authorizeDisclosure(current.review);return true;}catch{return false;}
 }
 private receipt(row:Row,command:Row):BranchDisclosureReceipt {
  const current=this.state(row);
  return {...command,active:command.revision===current.revision&&this.active(current)} as BranchDisclosureReceipt;
 }
 readCommand(branchId:string,executionId:string,id:string,key:string):BranchDisclosureReceipt {
  if(!keyValid(key))throw Error('Disclosure command key required');
  return this.db.transaction(()=>{
   const row=this.admission(branchId,executionId,id),command=this.db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,commandKey(key)) as Row|undefined;
   if(!command)throw Error('Disclosure command not found');
   const value=JSON.parse(command.result_json);
   if(value.admissionId!==id||value.commandKey!==key||hash(value.input)!==command.input_hash||stableJson(value)!==command.result_json)throw Error('Disclosure command integrity conflict');
   if(hash(value.evidence)!==value.evidenceHash)throw Error('Disclosure command evidence integrity failure');
   const {input,evidence,evidenceHash,...receipt}=value;return this.receipt(row,receipt);
  })();
 }
 async choose(branchId:string,executionId:string,id:string,input:BranchDisclosureChoice):Promise<BranchDisclosureReceipt> {
  if(!keyValid(input.commandKey)||!['approve','revoke'].includes(input.action)||!/^[a-f0-9]{64}$/.test(input.reviewHash)
   ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw Error('Exact human disclosure choice required');
  const replay=()=>{
   const old=this.db.prepare('SELECT input_hash FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,commandKey(input.commandKey)) as Row|undefined;
   if(!old)return;
   if(old.input_hash!==hash({admissionId:id,...input}))throw Error('Disclosure command key input conflict');
   return this.readCommand(branchId,executionId,id,input.commandKey);
  };
  const previous=replay();if(previous)return previous;
  // Revocation must remain possible after custody/policy has become unavailable.
  const preview=input.action==='approve'?await this.prepare(branchId,executionId,id):undefined;
  return this.db.transaction(()=>{
   const previous=replay();if(previous)return previous;
   const row=this.admission(branchId,executionId,id),current=this.state(row);
   if(current.revision!==input.expectedRevision)throw Error('Disclosure revision changed; refresh');
   const candidate=input.action==='approve'?this.candidate(row):undefined;
   if(candidate&&(candidate.reviewHash!==input.reviewHash||candidate.reviewHash!==preview!.reviewHash))throw Error('Disclosure facts/recipients/final policy changed; review again');
   if(!candidate&&(current.state==='unreviewed'||current.reviewHash!==input.reviewHash))throw Error('Disclosure revocation must name the current choice');
   const revision=current.revision+1,state=input.action==='approve'?'approved':'revoked';
   const value=candidate?{admissionId:id,revision,state,reviewHash:candidate.reviewHash,review:candidate.review,hostCutSha256:candidate.hostCutSha256,policyRevision:candidate.policyRevision,policy:candidate.policy}
    :{...current,revision,state};
   const now=new Date().toISOString();
   this.db.prepare(`INSERT INTO branch_commands VALUES(?,?,?,?,?) ON CONFLICT(execution_id,command_key) DO UPDATE SET input_hash=excluded.input_hash,result_json=excluded.result_json,created_at=excluded.created_at`)
    .run(executionId,currentKey(id),hash(value),stableJson(value),now);
   const command={admissionId:id,commandKey:input.commandKey,action:input.action,reviewHash:input.reviewHash,revision,state,input:{admissionId:id,...input},evidence:value,evidenceHash:hash(value)};
   this.db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(executionId,commandKey(input.commandKey),hash(command.input),stableJson(command),now);
   const {input:ignored,evidence,evidenceHash,...receipt}=command;return this.receipt(row,receipt);
  })();
 }
 /** Supply this bound function to Runtime's authorizeDisclosure. Never serializable. */
 readonly authorizeDisclosure=(review:Review):string=>{
  if(!this.db.inTransaction)return this.db.transaction(()=>this.authorizeDisclosure(review))();
  const r=review.reservation,row=this.admission(r.branchId,r.sourceExecutionId,review.admissionId),current=this.state(row);
  const historical=readDestinationHistoricalPartition(this.db,r,review.stage,undefined,row.state==='admitted'?row.id:undefined);this.historicalAuditRead(historical);
  const historicalFacts=destinationHistoricalFacts(historical);
  if(stableJson(review.facts.filter(f=>f.kind==='historical_generation'))!==stableJson(historicalFacts))throw Error('Historical human disclosure facts changed');

  if(current.state!=='approved'||stableJson(review)!==stableJson(current.review)||stableJson(review.reservation)!==row.reservation_json||stableJson(review.stage)!==row.stage_json
   ||current.hostCutSha256!==hash(this.group?issuedGroupHost(JSON.parse(row.snapshot_json)):JSON.parse(row.snapshot_json).hostDependencies)
   ||current.policyRevision!==hash(current.policy)||current.policyRevision!==hash(this.policy(r,review.stage))
   ||current.reviewHash!==hash({review,hostCutSha256:current.hostCutSha256,policyRevision:current.policyRevision}))throw Error('Explicit current human disclosure approval required');
  return `branch-disclosure:${hash({admissionId:row.id,revision:current.revision,reviewHash:current.reviewHash})}`;
 };
}
