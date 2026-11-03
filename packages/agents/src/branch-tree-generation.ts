import type Database from 'better-sqlite3';
import type {BranchPortableExecutionTree,BranchPortableRuntimeOwner} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {branchContinuationIds,remapBranchFrontier} from './branch-continuation-remap.js';
type Row=Record<string,any>;
export const treeFact=(o:BranchPortableRuntimeOwner,kind:string)=>JSON.parse(o.facts.find(f=>f.kind===kind)!.json);
export const portableTreeOwners=(d:BranchPortableExecutionTree)=>Object.values(d.branches).flatMap(b=>b.owners);
/** Eligibility follows complete root ancestry, including children created after a selected cut. */
export function portableRootTreeOwners(d:BranchPortableExecutionTree,rootId:string) {
 const all=portableTreeOwners(d),byId=new Map(all.map(o=>[o.sourceExecutionId,o]));
 const root=byId.get(rootId);if(!root||treeFact(root,'frontier').execution[0].parent_execution_id)throw Error('Tree root missing or called');
 return all.filter(owner=>{
  const seen=new Set<string>();
  for(;;){
   if(seen.has(owner.sourceExecutionId))throw Error('Tree ancestry cycle');seen.add(owner.sourceExecutionId);
   const parent=treeFact(owner,'frontier').execution[0].parent_execution_id;
   if(!parent)return owner===root;
   const next=byId.get(parent);if(!next)throw Error('Tree parent omitted');owner=next;
  }
 });
}
/** Exact command and held manifest lookup; children retain their ordinary Call provenance. */
export function captureForeignTreeGeneration(db:Database.Database,id:string,origin:Row):Row {
 const command=db.prepare('SELECT command_key,input_hash,result_json,created_at FROM branch_commands WHERE execution_id=? AND command_key=?').get(origin.importedExecutionId,`foreign-continuation:${payloadHash(origin.commandKey)}`) as Row|undefined;
 if(!command||payloadHash(JSON.parse(command.result_json))!==command.input_hash)throw Error('Tree continuation command unavailable');
 const receipt=JSON.parse(command.result_json);
 const manifests=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE command_key=?').all(`portable-runtime-tree-manifest:${payloadHash(receipt.review.selection.planId)}`) as Row[];
 if(manifests.length!==1||payloadHash(JSON.parse(manifests[0]!.result_json))!==manifests[0]!.input_hash||receipt.executionId!==id)throw Error('Tree continuation held manifest unavailable or ambiguous');
 const held=JSON.parse(manifests[0]!.result_json);
 if(stableJson(held.receipt)!==stableJson(receipt.review.nativeMaps)||held.data.sha256!==receipt.review.manifestSha256)throw Error('Tree continuation original import differs');
 return {receipt,held,command};
}
/** Held imports are evidence links, never fresh admissions. All typed frontier links must agree. */
export function heldTreeSource(data:BranchPortableExecutionTree,rootId:string) {
 let current=data,id=rootId;
 let aliases=Object.fromEntries(portableTreeOwners(data).map(o=>[o.sourceExecutionId,o.sourceExecutionId]));
 let branches=Object.fromEntries(Object.keys(data.branches).map(id=>[id,id]));
 const chain:Row[]=[],seen=new Set<string>();
 for(let depth=0;depth<=16;depth++){
  const all=portableTreeOwners(current),root=all.find(o=>o.sourceExecutionId===id);if(!root)throw Error('Tree generation root missing');
  const key=current.sha256+':'+id;if(seen.has(key))throw Error('Tree generation cycle');seen.add(key);
  chain.push({manifestSha256:current.sha256,ownerSha256:root.sha256,executionId:id});
  const origin=treeFact(root,'provenance');
  if(origin.source!=='portable_runtime_data')return {data:current,rootId:id,aliases,branches,chain};
  if(origin.tree!==true||depth===16)throw Error('Unsupported held tree generation');
  const held=treeFact(root,'tree-import'),old=held.data as BranchPortableExecutionTree,r=held.receipt,prior=portableTreeOwners(old);
  if(r.schema!=='ponderosa.branch-runtime-tree-import.v1'||r.rootBranchId!==r.branchMap[old.rootSourceBranchId]||r.manifestSha256!==old.sha256||r.planId!==origin.planId||r.executionMap[origin.sourceExecutionId]!==id||r.held!==true||r.currentAuthority!==false||r.dispatched!==false||stableJson(Object.keys(r.executionMap).sort())!==stableJson(prior.map(o=>o.sourceExecutionId).sort())||new Set(Object.values(r.executionMap)).size!==prior.length)throw Error('Held tree generation receipt differs');
  const ownerKeys=prior.map(o=>o.sourceExecutionId).sort(),related=new Set(portableRootTreeOwners(old,origin.sourceExecutionId).map(o=>o.sourceExecutionId));
  for(const map of [r.frontiers,r.reservedFrontiers,r.ownerPins])if(!map||stableJson(Object.keys(map).sort())!==stableJson(ownerKeys))throw Error('Held tree generation map closure differs');
  if(stableJson(Object.keys(r.branchMap).sort())!==stableJson(Object.keys(old.branches).sort())||new Set(Object.values(r.branchMap)).size!==Object.keys(old.branches).length)throw Error('Held tree generation Branch map differs');
  const manifests=all.flatMap(o=>o.facts.filter(f=>f.kind==='command'&&f.key===`portable-runtime-tree-manifest:${payloadHash(r.planId)}`));
  if(manifests.length!==1)throw Error('Held tree generation original command missing or ambiguous');
  const manifest=JSON.parse(manifests[0]!.json);if(manifest.input_hash!==payloadHash(held)||manifest.result_json!==stableJson(held))throw Error('Held tree generation original manifest command differs');
  const fresh=[...Object.values(r.executionMap),...Object.values(r.reservedFrontiers).flatMap((m:any)=>Object.values(m))],sourceIds=new Set(prior.flatMap(o=>[o.sourceExecutionId,...branchContinuationIds(treeFact(o,'frontier'))]));
  if(new Set(fresh).size!==fresh.length||fresh.some(v=>typeof v!=='string'||!v||sourceIds.has(v)))throw Error('Held tree generation identity reservations alias');
  for(const o of prior){
   const reserved=r.reservedFrontiers[o.sourceExecutionId],frontier=r.frontiers[o.sourceExecutionId];
   if(stableJson(Object.keys(reserved).sort())!==stableJson(branchContinuationIds(treeFact(o,'frontier')).sort())||frontier.disposition==='recreated_held'&&stableJson(reserved)!==stableJson(frontier.idMap))throw Error('Held tree generation frontier reservation differs');
   for(const item of treeFact(o,'frontier').items)if(reserved[item.id]!==`${reserved[item.map_invocation_id]}:${item.item_index}`)throw Error('Held tree generation Map reservation differs');
   const target=all.find(t=>t.sourceExecutionId===r.executionMap[o.sourceExecutionId]);if(!target)throw Error('Held tree generation closure omitted');
   const acceptance=target.facts.find(f=>f.kind==='acceptance'),accepted=acceptance&&JSON.parse(acceptance.json);if(accepted&&(accepted.admittedAt||accepted.admissionJson))throw Error('Held generation acquired admission');
   const e=treeFact(target,'frontier').execution[0],s=treeFact(o,'frontier'),pe=s.execution[0],pins=r.ownerPins[o.sourceExecutionId],f=r.frontiers[o.sourceExecutionId];
   if(stableJson(treeFact(target,'tree-import'))!==stableJson(held)||stableJson(treeFact(target,'provenance'))!==stableJson({source:'portable_runtime_data',tree:true,planId:r.planId,sourceExecutionId:o.sourceExecutionId,manifestSha256:old.sha256,currentAuthority:false})||e.admitted_at||e.admission_json||e.state!=='waiting'||e.wait_reason!=='Imported runtime tree is held; no execution authority'||e.output_text!==(pe.output_text??null)||e.cancel_requested||e.budget_exhausted||e.version_id!==pins?.versionId||e.binding_revision_id!==pins?.bindingRevisionId||e.branch_id!==r.branchMap[o.sourceBranchId]||e.parent_execution_id!==(pe.parent_execution_id?r.executionMap[pe.parent_execution_id]:null)||e.parent_attempt_id!==(pe.parent_attempt_id?r.frontiers[pe.parent_execution_id]?.idMap[pe.parent_attempt_id]:null)||e.input_text!==pe.input_text||e.input_hash!==(e.parent_attempt_id?payloadHash({parentAttempt:e.parent_attempt_id,input:e.input_text}):pe.input_hash)||['call_depth','depth_ceiling','traversals','loop_iterations','recovery_traversals'].some(k=>e[k]!==pe[k])||stableJson(treeFact(target,'configuration'))!==stableJson(treeFact(o,'configuration'))||e.occurrence_key!==(pe.parent_attempt_id?`call:${r.frontiers[pe.parent_execution_id]?.idMap[pe.parent_attempt_id]}`:`runtime-data:${r.planId}:${o.sourceExecutionId}`)||e.admission_source!==(pe.parent_execution_id?'call':'manual'))throw Error('Held tree generation frontier/pins/ancestry differs');
   const command=target.facts.find(f=>f.kind==='command'&&f.key==='portable-runtime-data'),value=command&&JSON.parse(command.json);
   if(!value||value.input_hash!==old.sha256||value.result_json!==stableJson({planId:r.planId,sourceExecutionId:o.sourceExecutionId,ownerSha256:o.sha256,currentAuthority:false})||target.facts.some(f=>f.kind==='transition'))throw Error('Held tree generation original owner command differs');
   const actual=treeFact(target,'frontier');
   if(f.disposition==='recreated_held'){
    if(payloadHash(treeFact(target,'definition'))!==payloadHash(treeFact(o,'definition')))throw Error('Held tree generation definition differs');
    const expected=remapBranchFrontier(s,f.idMap,o.sourceExecutionId,target.sourceExecutionId);
    const normalized=(rows:Row[])=>rows.map(row=>stableJson(Object.fromEntries(Object.entries(row).filter(([k])=>!['created_at','updated_at'].includes(k))))).sort();
    for(const k of Object.keys(expected))if(stableJson(normalized(expected[k]!))!==stableJson(normalized(actual[k])))throw Error('Held tree generation remap differs');
    const oldBindings=treeFact(o,'bindings'),newBindings=treeFact(target,'bindings');
    if(stableJson(newBindings.branches??{})!==stableJson(Object.fromEntries(Object.entries(oldBindings.branches??{}).map(([ref,b])=>[ref,r.branchMap[b as string]]))))throw Error('Held tree generation Call graph differs');
   }else if(f.disposition!=='evidence_only'||related.has(o.sourceExecutionId)||Object.keys(f.idMap).length||prior.some(child=>treeFact(child,'frontier').execution[0].parent_execution_id===o.sourceExecutionId)||Object.entries(actual).some(([key,rows])=>key!=='execution'&&(rows as Row[]).length))throw Error('Held tree generation evidence-only leaf differs');
  }
  aliases=Object.fromEntries(prior.map(o=>[o.sourceExecutionId,aliases[r.executionMap[o.sourceExecutionId]]!]));
  branches=Object.fromEntries(Object.keys(old.branches).map(b=>[b,branches[r.branchMap[b]]!]));
  id=origin.sourceExecutionId;current=old;
 }
 throw Error('Tree generation chain exceeds 16 retained generations');
}
