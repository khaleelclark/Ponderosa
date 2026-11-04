import type Database from 'better-sqlite3';
import type {BranchRuntimeDataReadback,BranchRuntimeTreeReadback} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {retainedIssuedResourceSource} from './branch-issued-resource-continuation.js';

type Row=Record<string,any>;
type Installation=BranchRuntimeDataReadback|BranchRuntimeTreeReadback;
type InstallationReader=(planId:string,branchId:string)=>Installation|undefined;

/** Installation provenance only. Canonical selected/latest replay and current admission remain separate. */
export function readRetainedDestinationSource(db:Database.Database,id:string,readInstallation:InstallationReader) {
 return db.transaction(()=>{
 const source=db.prepare('SELECT * FROM coordination_destination_retained_sources WHERE id=?').get(id) as Row|undefined;
 if(!source)throw Error('Retained destination source association unavailable');
 const owners=db.prepare('SELECT * FROM coordination_destination_retained_owners WHERE source_id=? ORDER BY original_execution_id').all(id) as Row[];
 const plan=db.prepare('SELECT branch_id,state FROM branch_installation_plans WHERE id=?').get(source.installation_plan_id) as Row|undefined;
 if(!plan||plan.branch_id!==source.branch_id||!['applying','completed'].includes(plan.state))throw Error('Retained destination installation unavailable');
 const saved=readInstallation(source.installation_plan_id,source.branch_id);
 if(!saved)throw Error('Retained destination installation readback unavailable');
 const receipt=saved.receipt,tree=saved.data.schema==='ponderosa.branch-runtime-tree.v1';
 const all=tree?Object.values((saved as BranchRuntimeTreeReadback).data.branches).flatMap(b=>b.owners):(saved as BranchRuntimeDataReadback).data.owners;
 const commandKey=`portable-runtime${tree?'-tree':''}-manifest:${payloadHash(source.installation_plan_id)}`;
 // Tree insertion topologically orders owners; its manifest anchor need not be the selected root or first map entry.
 const anchors=db.prepare('SELECT execution_id,input_hash,result_json FROM branch_commands WHERE command_key=?').all(commandKey) as Row[];
 if(anchors.length!==1)throw Error('Retained destination manifest anchor aliases or is unavailable');
 const anchor=anchors[0]!,json=stableJson(saved);
 if(source.installation_command_key!==commandKey||source.installation_execution_id!==anchor.execution_id
  ||!Object.values(receipt.executionMap).includes(anchor.execution_id)||anchor.input_hash!==payloadHash(saved)||anchor.result_json!==json
  ||source.proof_json!==json||source.proof_sha256!==payloadHash(saved)||source.manifest_sha256!==saved.data.sha256
  ||receipt.planId!==source.installation_plan_id||receipt.manifestSha256!==saved.data.sha256||receipt.currentAuthority!==false||receipt.dispatched!==false
  ||receipt.executionMap[source.original_execution_id]!==source.local_execution_id)throw Error('Retained destination manifest/owner association differs');
 const expected=all.map(owner=>({source_id:id,original_execution_id:owner.sourceExecutionId,local_execution_id:receipt.executionMap[owner.sourceExecutionId],owner_json:stableJson(owner),owner_sha256:payloadHash(owner)})).sort((a,b)=>a.original_execution_id<b.original_execution_id?-1:a.original_execution_id>b.original_execution_id?1:0);
 if(!owners.length||stableJson(owners)!==stableJson(expected))throw Error('Retained destination complete owner set differs');
 for(const owner of all){
  const local=receipt.executionMap[owner.sourceExecutionId];
  const e=db.prepare('SELECT branch_id,state,provenance_json,admitted_at,admission_json FROM branch_executions WHERE id=?').get(local) as Row|undefined;
  const command=db.prepare("SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key='portable-runtime-data'").get(local) as Row|undefined;
  const branchId=tree?(saved as BranchRuntimeTreeReadback).receipt.branchMap[owner.sourceBranchId]:(saved as BranchRuntimeDataReadback).receipt.branchId;
  const provenance={source:'portable_runtime_data',...(tree?{tree:true}:{}),planId:source.installation_plan_id,sourceExecutionId:owner.sourceExecutionId,manifestSha256:saved.data.sha256,currentAuthority:false};
  if(!e||e.branch_id!==branchId||e.state!=='waiting'||e.admitted_at||e.admission_json||e.provenance_json!==stableJson(provenance)
   ||!command||command.input_hash!==saved.data.sha256||command.result_json!==stableJson({planId:source.installation_plan_id,sourceExecutionId:owner.sourceExecutionId,ownerSha256:owner.sha256,currentAuthority:false}))throw Error('Retained destination local held owner differs');
 }
 const original=all.find(owner=>owner.sourceExecutionId===source.original_execution_id);
 const localRoot=db.prepare('SELECT branch_id FROM branch_executions WHERE id=?').get(source.local_execution_id) as Row|undefined;
 if(localRoot?.branch_id!==source.branch_id)throw Error('Retained destination local root Branch differs');
 const checkpoint=original?.facts.find(f=>f.kind==='checkpoint'&&f.key===source.original_checkpoint_key&&f.sha256===source.original_checkpoint_sha256);
 if(!checkpoint||checkpoint.json!==source.original_snapshot_json||stableJson(JSON.parse(checkpoint.json))!==checkpoint.json
  ||payloadHash(JSON.parse(checkpoint.json))!==source.original_checkpoint_sha256)throw Error('Retained destination original committed checkpoint differs');
 const snapshot=JSON.parse(checkpoint.json) as Row;
 if(snapshot.schema!=='branch-unit-selected.v2'||snapshot.selected?.execution?.length!==1||snapshot.selected.execution[0].id!==source.original_execution_id)throw Error('Retained destination checkpoint owner differs');
 const identity=Object.fromEntries(Object.entries(source).filter(([key])=>key!=='id'));
 const ownerIdentity=owners.map(({source_id,...owner})=>owner);
 if(id!==payloadHash({...identity,owners:ownerIdentity}))throw Error('Retained destination complete identity hash differs');
 return {source,owners,installation:saved,snapshot,currentAuthority:false as const};
 }).deferred();
}

/** Historical replay in addition to installation provenance. No native source SQL or current grants. */
export function readRetainedIssuedDestinationSource(db:Database.Database,id:string,readInstallation:InstallationReader) {
 return db.transaction(()=>{
  const retained=readRetainedDestinationSource(db,id,readInstallation);
  if(retained.installation.data.schema!=='ponderosa.branch-runtime-data.v1')throw Error('Retained issued tree replay is not supported');
  const source=retained.source;
  const proof=retainedIssuedResourceSource(retained.installation.data,source.original_execution_id,source.original_checkpoint_key,source.original_checkpoint_sha256);
  if(stableJson(proof.selected)!==source.original_snapshot_json)throw Error('Retained issued association selected bytes differ');
  return {...retained,proof};
 }).deferred();
}

/** One complete immutable association in the existing owner transaction; never accepts or dispatches work. */
export function retainIssuedDestinationSource(db:Database.Database,input:{planId:string;branchId:string;originalExecutionId:string;checkpointKey:string;checkpointSha256:string},readInstallation:InstallationReader) {
 if(!db.inTransaction)throw Error('Retained source creation requires the owner transaction');
 return db.transaction(()=>{
 const saved=readInstallation(input.planId,input.branchId);
 if(!saved||saved.data.schema!=='ponderosa.branch-runtime-data.v1')throw Error('Retained standalone issued installation unavailable');
 const proof=retainedIssuedResourceSource(saved.data,input.originalExecutionId,input.checkpointKey,input.checkpointSha256);
 const receipt=saved.receipt,commandKey=`portable-runtime-manifest:${payloadHash(input.planId)}`;
 const commands=db.prepare('SELECT execution_id FROM branch_commands WHERE command_key=?').all(commandKey) as Row[];
 if(commands.length!==1)throw Error('Retained issued manifest anchor unavailable or aliased');
 const identity={branch_id:input.branchId,local_execution_id:receipt.executionMap[input.originalExecutionId],installation_plan_id:input.planId,
  installation_execution_id:commands[0]!.execution_id,installation_command_key:commandKey,manifest_sha256:saved.data.sha256,
  original_execution_id:input.originalExecutionId,original_checkpoint_key:input.checkpointKey,original_checkpoint_sha256:input.checkpointSha256,
  original_snapshot_json:stableJson(proof.selected),proof_json:stableJson(saved),proof_sha256:payloadHash(saved)};
 const owners=saved.data.owners.map(owner=>({original_execution_id:owner.sourceExecutionId,local_execution_id:receipt.executionMap[owner.sourceExecutionId],owner_json:stableJson(owner),owner_sha256:payloadHash(owner)})).sort((a,b)=>a.original_execution_id<b.original_execution_id?-1:a.original_execution_id>b.original_execution_id?1:0);
 const id=payloadHash({...identity,owners}),source={id,...identity};
 const prior=db.prepare('SELECT * FROM coordination_destination_retained_sources WHERE id=?').get(id) as Row|undefined;
 if(prior){if(stableJson(prior)!==stableJson(source))throw Error('Retained issued source retry differs');}
 else {
  db.prepare(`INSERT INTO coordination_destination_retained_sources(id,branch_id,local_execution_id,installation_plan_id,installation_execution_id,installation_command_key,manifest_sha256,original_execution_id,original_checkpoint_key,original_checkpoint_sha256,original_snapshot_json,proof_json,proof_sha256)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,identity.branch_id,identity.local_execution_id,identity.installation_plan_id,identity.installation_execution_id,identity.installation_command_key,identity.manifest_sha256,identity.original_execution_id,identity.original_checkpoint_key,identity.original_checkpoint_sha256,identity.original_snapshot_json,identity.proof_json,identity.proof_sha256);
  for(const owner of owners)db.prepare('INSERT INTO coordination_destination_retained_owners(source_id,original_execution_id,local_execution_id,owner_json,owner_sha256) VALUES(?,?,?,?,?)').run(id,owner.original_execution_id,owner.local_execution_id,owner.owner_json,owner.owner_sha256);
 }
 // Same-key retries verify the whole original owner set and all actual held installation bytes too.
 return readRetainedIssuedDestinationSource(db,id,readInstallation);
 }).immediate();
}

/** Read an already pinned installation association without requiring source-host
 * Project/Agent rows. The immutable manifest anchor is rechecked by the reader. */
export function readPinnedRetainedIssuedSource(db:Database.Database,id:string) {
 const row=db.prepare('SELECT proof_json FROM coordination_destination_retained_sources WHERE id=?').get(id) as Row|undefined;
 if(!row)throw Error('Pinned retained source unavailable');
 const saved=JSON.parse(row.proof_json) as Installation;
 const retained=readRetainedIssuedDestinationSource(db,id,()=>saved);
 if(!('finalExit' in retained.proof))throw Error('Only exact completed final retained sources may be admitted');
 return retained;
}
