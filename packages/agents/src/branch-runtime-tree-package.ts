import {automaticScriptDefinitionSupported} from './branch-script-origin.js';
import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {BranchPortableExecutionTree,BranchPortableRuntimeOwner,BranchRuntimeTreePlan,BranchRuntimeTreeReadback,BranchRuntimeTreeReceipt,BranchPortableDefinitionTree} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {validateBranchRuntimeData} from './branch-runtime-package.js';
import {validateBranchConfiguration} from './branch-parameters.js';
import {manualSerialTreeDefinitionSupported,scriptFrontierSupported,type Selected,type ScriptOwnerContext} from './branch-script-continuation.js';
import {branchContinuationIds,remapBranchFrontier} from './branch-continuation-remap.js';
import {insertBranchFrontier} from './branch-frontier-storage.js';
import {selectBranchUnit} from './branch-unit-selection.js';
type Row=Record<string,any>;
const fact=(o:BranchPortableRuntimeOwner,kind:string)=>JSON.parse(o.facts.find(f=>f.kind===kind)!.json);
const owners=(d:BranchPortableExecutionTree)=>Object.values(d.branches).flatMap(b=>b.owners);
/** Held native state is distinct from the original state retained in its private manifest. */
function selected(o:BranchPortableRuntimeOwner,depth=0):Selected {
 if(depth>32)throw Error('Runtime tree re-export generations exceed bound');
 const current=fact(o,'frontier') as Selected,origin=fact(o,'provenance');
 if(origin.source==='portable_runtime_data'&&origin.tree===true){
  const original=fact(o,'tree-import') as BranchRuntimeTreeReadback,prior=owners(original.data).find(v=>v.sourceExecutionId===origin.sourceExecutionId);
  if(!prior)throw Error('Original private tree owner unavailable');
  const priorState=selected(prior,depth+1).execution![0]!;
  return {...current,execution:[{...current.execution![0],state:priorState.state,wait_reason:priorState.wait_reason}]};
 }
 return current;
}
export function validateBranchExecutionTree(value:unknown,depth=0,proof={remaining:128,active:new Set<string>(),cache:new Map<string,BranchPortableExecutionTree>()}):BranchPortableExecutionTree {
 if(depth>16)throw Error('Runtime tree manifest nesting exceeds bound');
 const d=value as BranchPortableExecutionTree;
 if(!d||d.schema!=='ponderosa.branch-runtime-tree.v1'||Object.keys(d).sort().join('|')!==['schema','rootSourceBranchId','branches','sha256'].sort().join('|')||typeof d.rootSourceBranchId!=='string'||!d.branches||Array.isArray(d.branches)||Object.keys(d.branches).length>100||payloadHash({schema:d.schema,rootSourceBranchId:d.rootSourceBranchId,branches:d.branches})!==d.sha256||Buffer.byteLength(stableJson(d))>32*1024*1024)throw Error('Runtime tree manifest integrity failure');
 if(proof.active.has(d.sha256))throw Error('Runtime tree generation cycle');
 const cached=proof.cache.get(d.sha256);if(cached)return cached;
 if(--proof.remaining<0)throw Error('Runtime tree generation replay work exceeds bound');proof.active.add(d.sha256);
 for(const [id,b] of Object.entries(d.branches))if(validateBranchRuntimeData(b,true).sourceBranchId!==id)throw Error('Runtime tree Branch pin differs');
 if(!Object.hasOwn(d.branches,d.rootSourceBranchId))throw Error('Runtime tree root Branch omitted');
 const all=owners(d),byId=new Map(all.map(o=>[o.sourceExecutionId,o]));
 if(!all.length||all.length>1000||all.length!==byId.size)throw Error('Runtime tree owner inventory aliases or exceeds bound');
 const chats=new Set<string>(),agents=new Set<string>(),refs=new Set<string>();
 for(const b of Object.values(d.branches)){
  for(const [id,ref] of Object.entries(b.identities.chats)){if(chats.has(id)||refs.has(ref))throw Error('Runtime tree Chat aliases');chats.add(id);refs.add(ref);}
  for(const id of Object.keys(b.identities.agents)){if(agents.has(id))throw Error('Runtime tree Agent aliases');agents.add(id);}
 }
 const attempts=new Set<string>(),localIds=new Set<string>(all.map(o=>o.sourceExecutionId));
 for(const o of all)for(const id of branchContinuationIds(fact(o,'frontier'))){if(localIds.has(id))throw Error('Runtime tree local identity aliases');localIds.add(id);}
 for(const o of all){
  const e=fact(o,'frontier').execution[0],origin=fact(o,'provenance');
  const originalConfiguration=fact(o,'configuration').configuration;if(stableJson(validateBranchConfiguration(originalConfiguration,fact(o,'definition'),true))!==stableJson(originalConfiguration)||['call_depth','depth_ceiling','traversals','loop_iterations','recovery_traversals'].some(key=>!Number.isSafeInteger(e[key])||e[key]<0)||e.depth_ceiling<1||e.call_depth>e.depth_ceiling||!(e.output_text===null||typeof e.output_text==='string'))throw Error('Runtime tree native scalar/configuration facts are noncanonical');
  if(origin.source==='portable_runtime_data'&&origin.tree===true){
   const saved=fact(o,'tree-import') as BranchRuntimeTreeReadback,source=validateBranchExecutionTree(saved.data,depth+1,proof),prior=owners(source).find(p=>p.sourceExecutionId===origin.sourceExecutionId);
   if(!prior||saved.receipt.schema!=='ponderosa.branch-runtime-tree-import.v1'||saved.receipt.planId!==origin.planId||saved.receipt.manifestSha256!==origin.manifestSha256||source.sha256!==origin.manifestSha256||saved.receipt.executionMap[origin.sourceExecutionId]!==o.sourceExecutionId||saved.receipt.branchMap[prior.sourceBranchId]!==o.sourceBranchId||saved.receipt.held!==true||saved.receipt.currentAuthority!==false||saved.receipt.dispatched!==false||fact(prior,'frontier').execution[0].input_text!==e.input_text)throw Error('Runtime tree private re-export provenance differs');
   const previous=fact(prior,'frontier').execution[0],pins=saved.receipt.ownerPins[origin.sourceExecutionId];if(e.parent_execution_id!==(previous.parent_execution_id?saved.receipt.executionMap[previous.parent_execution_id]:null)||e.parent_attempt_id!==(previous.parent_attempt_id?saved.receipt.frontiers[previous.parent_execution_id]!.idMap[previous.parent_attempt_id]:null)||!previous.parent_execution_id&&e.input_hash!==previous.input_hash||e.version_id!==pins?.versionId||e.binding_revision_id!==pins?.bindingRevisionId)throw Error('Private tree original-to-native ancestry/pin mapping differs');
  }
  const generation=o.facts.find(f=>f.kind==='tree-continuation');
  if(generation){
   const retained=JSON.parse(generation.json),r=retained.receipt,held=retained.held,command=retained.command;
   const source=validateBranchExecutionTree(held.data,depth+1,proof),imported=byId.get(r.importedExecutionId),importFact=imported?.facts.find(f=>f.kind==='tree-import'),commandFact=imported?.facts.find(f=>f.kind==='command'&&f.key===`foreign-continuation:${payloadHash(r.commandKey)}`);
   if(Object.keys(retained).sort().join('|')!==['command','held','receipt'].sort().join('|')||origin.source!=='foreign_tree_continuation'||r.executionId!==e.id||r.commandKey!==origin.commandKey||r.importedExecutionId!==origin.importedExecutionId||r.review.reviewSha256!==origin.reviewSha256||r.review.manifestSha256!==source.sha256||stableJson(r.review.nativeMaps)!==stableJson(held.receipt)||!importFact||stableJson(JSON.parse(importFact.json))!==stableJson(held)||!commandFact||stableJson(JSON.parse(commandFact.json))!==stableJson(command)||command.input_hash!==payloadHash(r)||command.result_json!==stableJson(r))throw Error('Retained tree generation command/import ownership differs');
  }
  for(const call of fact(o,'definition').steps)if(call.kind==='branch_call'&&!Object.hasOwn(d.branches,fact(o,'bindings').branches?.[call.branchRef]))throw Error('Historical runtime Call dependency omitted');
  if(Boolean(e.parent_execution_id)!==Boolean(e.parent_attempt_id))throw Error('Incomplete runtime tree parent edge');
  if(e.parent_execution_id){
   const parent=byId.get(e.parent_execution_id),p=parent&&fact(parent,'frontier'),a=p?.attempts.find((r:Row)=>r.id===e.parent_attempt_id),step=p?.steps.find((r:Row)=>r.id===a?.step_execution_id),call=parent&&fact(parent,'definition').steps.find((r:Row)=>r.id===step?.step_id);
   if(!parent||!a||!step||call?.kind!=='branch_call'||fact(parent,'bindings').branches?.[call.branchRef]!==o.sourceBranchId||e.admission_source!=='call'||e.occurrence_key!==`call:${a.id}`||e.input_text!==step.input_text||e.input_hash!==payloadHash({parentAttempt:a.id,input:step.input_text})||e.call_depth!==p.execution[0].call_depth+1||attempts.has(a.id))throw Error('Runtime tree original Call ancestry/input/binding differs');
   if(origin.source!=='portable_runtime_data'&&(origin.parentExecutionId!==e.parent_execution_id||origin.parentAttemptId!==e.parent_attempt_id))throw Error('Original Call provenance differs');
   const ce=selected(o).execution![0]!,pe=selected(parent).execution![0]!,completed=['completed','failed'].includes(ce.state),configuration=fact(o,'configuration').configuration;
   if(e.depth_ceiling!==Math.min(pe.depth_ceiling,e.call_depth+configuration.limits.maxCallDepth)||step.state!==(completed?ce.state:'waiting')||completed&&(JSON.parse(step.result_json).failed!==(ce.state==='failed')||JSON.parse(step.result_json).output!==(ce.output_text??undefined)))throw Error('Original Call state/output/counter ceiling differs');
   attempts.add(a.id);
   const seen=new Set<string>();let cursor:BranchPortableRuntimeOwner|undefined=o;
   while(cursor){if(seen.has(cursor.sourceExecutionId))throw Error('Execution ancestry cycle');seen.add(cursor.sourceExecutionId);const id:string|null=fact(cursor,'frontier').execution[0].parent_execution_id;cursor=id?byId.get(id):undefined;if(id&&!cursor)throw Error('Owned execution parent omitted');}
  }else if(e.admission_source==='call')throw Error('Call owner lost its parent');
 }
 proof.active.delete(d.sha256);proof.cache.set(d.sha256,d);return d;
}
function supported(d:BranchPortableExecutionTree,o:BranchPortableRuntimeOwner):boolean {
 const all=owners(d),s=selected(o),e=s.execution![0]!,definition=fact(o,'definition'),configuration=fact(o,'configuration');
 const direct=all.filter(c=>fact(c,'frontier').execution[0].parent_execution_id===o.sourceExecutionId),children:ScriptOwnerContext['children']=Object.create(null);
 for(const c of direct){const ce=selected(c).execution![0]!;children[ce.parent_attempt_id]={executionId:c.sourceExecutionId,versionId:ce.version_id,output:ce.output_text,completed:['completed','failed'].includes(ce.state),failed:ce.state==='failed'};}
 const serialTreeRetries=all.every(owner=>manualSerialTreeDefinitionSupported(fact(owner,'definition'))&&!fact(owner,'frontier').resources.length&&!fact(owner,'frontier').actions.length&&!fact(owner,'frontier').bundles.length&&!fact(owner,'frontier').attempts.some((a:Row)=>a.request_id||a.recovery_of_request_id||a.runtime_outcome_json));
 const automaticRootTree=!e.parent_execution_id&&automaticScriptDefinitionSupported(definition,true);
 const terminal=['completed','failed'].includes(e.state),context:ScriptOwnerContext={serialTreeRetries,automaticRootTree,workflowGates:['sync','async','exit'].includes(configuration.configuration.checkpointMode??'async')&&(definition.trigger.kind==='manual'||automaticRootTree)&&definition.steps.some((s:Row)=>s.kind==='human_gate')&&definition.steps.every((s:Row)=>['script','branch_call','human_gate'].includes(s.kind))&&definition.controls.every((c:Row)=>['condition','route','fork','map','join'].includes(c.kind)),terminal,terminalState:terminal?e.state:undefined,waiting:e.state==='waiting',...(e.parent_execution_id?{parent:{executionId:e.parent_execution_id,attemptId:e.parent_attempt_id,input:e.input_text}}:{}),children,descendantTraversals:direct.reduce((n,c)=>n+selected(c).execution![0]!.traversals,0),descendantLoops:direct.reduce((n,c)=>n+selected(c).execution![0]!.loop_iterations,0)};
 const bundled=[e.input_text,e.output_text,...s.steps!.map(step=>step.input_text)].some(text=>typeof text==='string'&&text.startsWith('branch-result-bundle:'));
 return !bundled&&!s.bundles!.length&&!configuration.requiredSecretRefs.length&&!s.resources!.length&&!s.actions!.length&&!s.attempts!.some(a=>a.request_id||a.recovery_of_request_id||a.runtime_outcome_json||['leased','running','outcome_unknown'].includes(a.state))&&scriptFrontierSupported(s,definition,context);
}
/** All identities are allocated before any awaited composer work and retained in its private plan. */
export function planBranchExecutionTree(value:BranchPortableExecutionTree,definitions:BranchPortableDefinitionTree):BranchRuntimeTreePlan {
 const d=validateBranchExecutionTree(value),all=owners(d),executionMap=Object.fromEntries(all.map(o=>[o.sourceExecutionId,randomUUID()])),frontiers:BranchRuntimeTreePlan['frontiers']=Object.create(null),reservedFrontiers:BranchRuntimeTreePlan['reservedFrontiers']=Object.create(null);
 for(const o of all){
  const definition=definitions.nodes.find(n=>n.sourceBranchId===o.sourceBranchId);if(!definition)throw Error('Runtime owner Branch is absent from publication inventory');
  const recreate=payloadHash(definition.definition)===payloadHash(fact(o,'definition'))&&supported(d,o);
  if(!recreate&&all.some(c=>fact(c,'frontier').execution[0].parent_execution_id===o.sourceExecutionId))throw Error('Parent Call frontier cannot be recreated without inventing ancestry; runtime tree refuses before staging');
  const s=fact(o,'frontier') as Selected,ids:Record<string,string>=Object.fromEntries(branchContinuationIds(s).map(id=>[id,randomUUID()]));for(const item of s.items!)ids[item.id]=`${ids[item.map_invocation_id]}:${item.item_index}`;reservedFrontiers[o.sourceExecutionId]=ids;
  if(recreate){remapBranchFrontier(s,ids,o.sourceExecutionId,executionMap[o.sourceExecutionId]!);frontiers[o.sourceExecutionId]={disposition:'recreated_held',idMap:ids};}
  else frontiers[o.sourceExecutionId]={disposition:'evidence_only',idMap:{},reason:'Unsupported/unknown/secret/historical leaf retains complete private facts; no native frontier was recreated'};
 }
 return {executionMap,frontiers,reservedFrontiers};
}
/** Fixed native writer, always inside the existing all-Branch publication transaction. */
export function insertBranchExecutionTree(db:Database.Database,planId:string,value:BranchPortableExecutionTree,plan:BranchRuntimeTreePlan,branchMap:Record<string,string>,chatMap:Record<string,string>,agentMap:Record<string,string>,now:string):BranchRuntimeTreeReceipt {
 if(!db.inTransaction)throw Error('Runtime tree requires the publication transaction');
 const d=validateBranchExecutionTree(value),all=owners(d),ordered:BranchPortableRuntimeOwner[]=[],pending=[...all];
 const run=(sql:string,...args:any[])=>db.prepare(sql).run(...args),row=(sql:string,...args:any[])=>db.prepare(sql).get(...args) as Row|undefined;
 const allFresh=[...Object.values(plan.executionMap),...Object.values(plan.reservedFrontiers).flatMap(m=>Object.values(m))];if(new Set(allFresh).size!==allFresh.length||allFresh.some(id=>all.some(o=>o.sourceExecutionId===id||branchContinuationIds(fact(o,'frontier')).includes(id))))throw Error('Fresh runtime identity maps alias source or other owners');
 for(const o of all){const ids=plan.reservedFrontiers[o.sourceExecutionId];if(!ids||stableJson(Object.keys(ids).sort())!==stableJson(branchContinuationIds(fact(o,'frontier')).sort())||plan.frontiers[o.sourceExecutionId]?.disposition==='recreated_held'&&stableJson(ids)!==stableJson(plan.frontiers[o.sourceExecutionId]!.idMap))throw Error('Persistent frontier reservation differs');}
 if(stableJson(Object.keys(plan.reservedFrontiers).sort())!==stableJson(all.map(o=>o.sourceExecutionId).sort())||stableJson(Object.keys(plan.executionMap).sort())!==stableJson(all.map(o=>o.sourceExecutionId).sort())||stableJson(Object.keys(plan.frontiers).sort())!==stableJson(Object.keys(plan.executionMap).sort())||new Set(Object.values(plan.executionMap)).size!==all.length)throw Error('Runtime tree preallocation differs');
 while(pending.length){const index=pending.findIndex(o=>{const p=fact(o,'frontier').execution[0].parent_execution_id;return !p||ordered.some(v=>v.sourceExecutionId===p);});if(index<0)throw Error('Runtime tree parent ordering failed');ordered.push(pending.splice(index,1)[0]!);}
 const ownerPins:BranchRuntimeTreeReceipt['ownerPins']=Object.create(null);
 for(const o of ordered){
  const s=fact(o,'frontier') as Selected,e=s.execution![0]!,id=plan.executionMap[o.sourceExecutionId]!,branchId=branchMap[o.sourceBranchId]!,b=row('SELECT * FROM branches WHERE id=? AND enabled=0 AND deleting=0',branchId),configuration=fact(o,'configuration').configuration;
  if(!b||id===o.sourceExecutionId)throw Error('Fresh disabled runtime Branch unavailable');
  ownerPins[o.sourceExecutionId]={versionId:b.active_version_id,bindingRevisionId:b.binding_revision_id};
  const parent=e.parent_execution_id?plan.executionMap[e.parent_execution_id]:null,attempt=e.parent_attempt_id?plan.frontiers[e.parent_execution_id]!.idMap[e.parent_attempt_id]:null;
  if(e.parent_execution_id&&(!parent||!attempt||!row('SELECT 1 FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE a.id=? AND s.execution_id=?',attempt,parent)))throw Error('Fresh canonical parent Call attempt unavailable');
  const inputHash=attempt?payloadHash({parentAttempt:attempt,input:e.input_text}):e.input_hash;
  const provenance={source:'portable_runtime_data',tree:true,planId,sourceExecutionId:o.sourceExecutionId,manifestSha256:d.sha256,currentAuthority:false};
  run(`INSERT INTO branch_executions(id,branch_id,version_id,binding_revision_id,occurrence_key,input_text,input_hash,provenance_json,state,wait_reason,output_text,configuration_json,parent_execution_id,parent_attempt_id,call_depth,depth_ceiling,traversals,loop_iterations,recovery_traversals,admission_source,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,'waiting',?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,branchId,b.active_version_id,b.binding_revision_id,attempt?`call:${attempt}`:`runtime-data:${planId}:${o.sourceExecutionId}`,e.input_text,inputHash,stableJson(provenance),'Imported runtime tree is held; no execution authority',e.output_text??null,stableJson(configuration),parent,attempt,e.call_depth,e.depth_ceiling,e.traversals,e.loop_iterations,e.recovery_traversals,parent?'call':'manual',now,now);
  run('INSERT INTO branch_commands VALUES(?,?,?,?,?)',id,'portable-runtime-data',d.sha256,stableJson({planId,sourceExecutionId:o.sourceExecutionId,ownerSha256:o.sha256,currentAuthority:false}),now);
  const f=plan.frontiers[o.sourceExecutionId]!;
  if(f.disposition==='recreated_held'){
   if(!supported(d,o)||payloadHash(JSON.parse(row('SELECT definition_json FROM branch_versions WHERE id=?',b.active_version_id)!.definition_json))!==payloadHash(fact(o,'definition')))throw Error('Runtime tree supported frontier changed');
   validateBranchConfiguration(configuration,fact(o,'definition'),true);
   insertBranchFrontier(db,id,remapBranchFrontier(s,f.idMap,o.sourceExecutionId,id),now);
  }else if(f.disposition!=='evidence_only'||Object.keys(f.idMap).length||all.some(c=>fact(c,'frontier').execution[0].parent_execution_id===o.sourceExecutionId))throw Error('Unsupported parent cannot receive invented native ancestry');
  const identities=d.branches[o.sourceBranchId]!.identities;
  for(const ref of o.chatRefs){const source=Object.keys(identities.chats).find(k=>identities.chats[k]===ref)!;if(run('UPDATE conversations SET branch_execution_id=? WHERE id=? AND branch_id=? AND branch_execution_id IS NULL',id,chatMap[source],branchId).changes!==1)throw Error('Execution Chat final ownership differs');run('INSERT INTO branch_resource_references VALUES(?,?)',id,chatMap[source]);}
 }
 const receipt:BranchRuntimeTreeReceipt={schema:'ponderosa.branch-runtime-tree-import.v1',ownerPins,planId,rootBranchId:branchMap[d.rootSourceBranchId]!,manifestSha256:d.sha256,branchMap,chatMap,agentMap,...plan,held:true,currentAuthority:false,dispatched:false},saved={receipt,data:d};
 run('INSERT INTO branch_commands VALUES(?,?,?,?,?)',plan.executionMap[ordered[0]!.sourceExecutionId],`portable-runtime-tree-manifest:${payloadHash(planId)}`,payloadHash(saved),stableJson(saved),now);
 readBranchExecutionTree(db,planId,receipt.rootBranchId);return receipt;
}
export function readBranchExecutionTree(db:Database.Database,planId:string,rootBranchId:string):BranchRuntimeTreeReadback|undefined {
 return readTree(db,planId,rootBranchId,false);
}
/** Continuation checks immutable held owners; current choices are reviewed separately. */
export function readHeldTreeForContinuation(db:Database.Database,planId:string,rootBranchId:string):BranchRuntimeTreeReadback|undefined {
 return readTree(db,planId,rootBranchId,true);
}
function readTree(db:Database.Database,planId:string,rootBranchId:string,continuation:boolean):BranchRuntimeTreeReadback|undefined {
 const row=(sql:string,...args:any[])=>db.prepare(sql).get(...args) as Row|undefined;
 const manifests=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE command_key=?').all(`portable-runtime-tree-manifest:${payloadHash(planId)}`) as Row[];if(!manifests.length)return;if(manifests.length!==1)throw Error('Runtime tree manifest aliases');const manifest=manifests[0]!;
 const saved=JSON.parse(manifest.result_json) as BranchRuntimeTreeReadback,r=saved.receipt,d=validateBranchExecutionTree(saved.data),all=owners(d);
 if(stableJson(Object.keys(r.branchMap).sort())!==stableJson(Object.keys(d.branches).sort())||new Set(Object.values(r.branchMap)).size!==Object.keys(r.branchMap).length||Object.values(r.branchMap).some(id=>Object.hasOwn(d.branches,id))||payloadHash(saved)!==manifest.input_hash||r.rootBranchId!==rootBranchId||r.planId!==planId||r.manifestSha256!==d.sha256||r.currentAuthority!==false||r.dispatched!==false||r.held!==true||new Set(Object.values(r.executionMap)).size!==all.length||stableJson(Object.keys(r.executionMap).sort())!==stableJson(all.map(o=>o.sourceExecutionId).sort())||stableJson(Object.keys(r.frontiers).sort())!==stableJson(Object.keys(r.executionMap).sort()))throw Error('Runtime tree receipt integrity failure');
 for(const [branch,id] of Object.entries(r.branchMap)){if(!row('SELECT 1 FROM branches b LEFT JOIN trigger_definitions t ON t.id=b.trigger_id WHERE b.id=? AND b.deleting=0 AND (?=1 OR b.enabled=0 AND COALESCE(t.enabled,0)=0)',id,continuation?1:0))throw Error('Runtime tree Branch no longer disabled');const actual=db.prepare('SELECT id FROM branch_executions WHERE branch_id=? ORDER BY id').all(id) as Row[],expected=all.filter(o=>o.sourceBranchId===branch).map(o=>r.executionMap[o.sourceExecutionId]).sort();if(!continuation&&stableJson(actual.map(e=>e.id))!==stableJson(expected))throw Error('Runtime tree owner closure differs');}
 if(!r.branchMap[d.rootSourceBranchId]||r.branchMap[d.rootSourceBranchId]!==rootBranchId)throw Error('Runtime tree Branch no longer disabled');
 if(continuation)for(const id of Object.values(r.executionMap))if((db.prepare('SELECT id FROM branch_executions WHERE parent_execution_id=?').all(id) as Row[]).some(child=>!Object.values(r.executionMap).includes(child.id)))throw Error('Held tree acquired an unowned child');
 const allChats=Object.assign(Object.create(null),...Object.values(d.branches).map(b=>b.identities.chats)),allAgents=Object.assign(Object.create(null),...Object.values(d.branches).map(b=>b.identities.agents));
 for(const [map,expected] of [[r.chatMap,allChats],[r.agentMap,allAgents]] as const)if(stableJson(Object.keys(map).sort())!==stableJson(Object.keys(expected).sort())||new Set(Object.values(map)).size!==Object.keys(map).length||Object.values(map).some(id=>Object.hasOwn(expected,id)))throw Error('Runtime tree participant map aliases');
 for(const [branch,b] of Object.entries(d.branches)){const actual=db.prepare('SELECT id FROM conversations WHERE branch_id=? ORDER BY id').all(r.branchMap[branch]) as Row[],expected=Object.keys(b.identities.chats).map(id=>r.chatMap[id]).sort();if(stableJson(actual.map(c=>c.id))!==stableJson(expected))throw Error('Runtime tree native Chat inventory differs');for(const [source,ref] of Object.entries(b.identities.chats)){const expectedAgents=Object.entries(b.identities.agents).filter(([,a])=>a.chatRef===ref).map(([id])=>r.agentMap[id]).sort(),actualAgents=db.prepare('SELECT id FROM agents WHERE conversation_id=? ORDER BY id').all(r.chatMap[source]) as Row[];if(stableJson(expectedAgents)!==stableJson(actualAgents.map(a=>a.id)))throw Error('Runtime tree native Agent inventory differs');}}
 for(const [branch,b] of Object.entries(d.branches))for(const [source,ref] of Object.entries(b.identities.chats)){const owner=b.owners.find(o=>o.chatRefs.includes(ref)),c=row('SELECT * FROM conversations WHERE id=?',r.chatMap[source]);if(!c||c.branch_id!==r.branchMap[branch]||c.branch_execution_id!==(owner?r.executionMap[owner.sourceExecutionId]:null))throw Error('Runtime tree Chat owner differs');}
 for(const b of Object.values(d.branches))for(const [source,ref] of Object.entries(b.identities.agents)){const chat=Object.keys(b.identities.chats).find(id=>b.identities.chats[id]===ref.chatRef)!;if(!row('SELECT 1 FROM agents WHERE id=? AND conversation_id=?',r.agentMap[source],r.chatMap[chat]))throw Error('Runtime tree Agent owner differs');}
 for(const o of all){const id=r.executionMap[o.sourceExecutionId]!,e=row('SELECT * FROM branch_executions WHERE id=?',id),source=fact(o,'frontier').execution[0],f=r.frontiers[o.sourceExecutionId]!,command=row("SELECT * FROM branch_commands WHERE execution_id=? AND command_key='portable-runtime-data'",id),parent=source.parent_execution_id?r.executionMap[source.parent_execution_id]:null,attempt=source.parent_attempt_id?r.frontiers[source.parent_execution_id]!.idMap[source.parent_attempt_id]:null;
  if(!e||!r.ownerPins[o.sourceExecutionId]||e.version_id!==r.ownerPins[o.sourceExecutionId]!.versionId||e.binding_revision_id!==r.ownerPins[o.sourceExecutionId]!.bindingRevisionId||!continuation&&row('SELECT active_version_id FROM branches WHERE id=?',e.branch_id)?.active_version_id!==e.version_id||!continuation&&row('SELECT binding_revision_id FROM branches WHERE id=?',e.branch_id)?.binding_revision_id!==e.binding_revision_id||e.branch_id!==r.branchMap[o.sourceBranchId]||e.parent_execution_id!==parent||e.parent_attempt_id!==attempt||e.input_text!==source.input_text||e.input_hash!==(attempt?payloadHash({parentAttempt:attempt,input:source.input_text}):source.input_hash)||e.occurrence_key!==(attempt?`call:${attempt}`:`runtime-data:${planId}:${o.sourceExecutionId}`)||e.state!=='waiting'||e.wait_reason!=='Imported runtime tree is held; no execution authority'||e.output_text!==(source.output_text??null)||e.cancel_requested||e.budget_exhausted||e.admission_source!==(parent?'call':'manual')||e.admitted_at||e.admission_json||e.provenance_json!==stableJson({source:'portable_runtime_data',tree:true,planId,sourceExecutionId:o.sourceExecutionId,manifestSha256:d.sha256,currentAuthority:false})||command?.input_hash!==d.sha256||command.result_json!==stableJson({planId,sourceExecutionId:o.sourceExecutionId,ownerSha256:o.sha256,currentAuthority:false})||['call_depth','depth_ceiling','traversals','loop_iterations','recovery_traversals'].some(key=>e[key]!==source[key])||e.configuration_json!==stableJson(fact(o,'configuration').configuration)||row('SELECT 1 FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=? AND (a.lease_owner IS NOT NULL OR a.lease_until IS NOT NULL OR a.process_identity_json IS NOT NULL OR a.request_id IS NOT NULL)',id))throw Error('Runtime tree native owner/ancestry/authority differs');
  if(parent){const parentOwner=all.find(p=>p.sourceExecutionId===source.parent_execution_id)!,p=fact(parentOwner,'frontier'),sourceStep=p.steps.find((s:Row)=>s.id===p.attempts.find((a:Row)=>a.id===source.parent_attempt_id)?.step_execution_id),call=fact(parentOwner,'definition').steps.find((s:Row)=>s.id===sourceStep?.step_id),binding=row('SELECT bindings_json FROM branch_bindings WHERE id=?',r.ownerPins[parentOwner.sourceExecutionId]!.bindingRevisionId);if(call?.kind!=='branch_call'||!binding||JSON.parse(binding.bindings_json).branches?.[call.branchRef]!==e.branch_id||!row('SELECT 1 FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE a.id=? AND s.execution_id=? AND s.step_id=? AND s.input_text=?',attempt,parent,sourceStep.step_id,source.input_text))throw Error('Fresh native Call definition/binding/input differs');}
  const actual=selectBranchUnit(db,id);
  if(f.disposition==='recreated_held'){if(payloadHash(JSON.parse(row('SELECT definition_json FROM branch_versions WHERE id=?',e.version_id)!.definition_json))!==payloadHash(fact(o,'definition')))throw Error('Runtime tree definition pin differs');const expected=remapBranchFrontier(fact(o,'frontier'),f.idMap,o.sourceExecutionId,id),normalize=(rows:Row[])=>rows.map(row=>stableJson(Object.fromEntries(Object.entries(row).filter(([key])=>!['created_at','updated_at'].includes(key))))).sort();for(const key of Object.keys(expected))if(stableJson(normalize(expected[key]!))!==stableJson(normalize(actual[key]!)))throw Error('Runtime tree native frontier differs');}
  else if(f.disposition!=='evidence_only'||Object.keys(f.idMap).length||Object.entries(actual).some(([key,rows])=>key!=='execution'&&rows!.length))throw Error('Runtime tree evidence-only leaf has native frontier data');
 }
 return saved;
}
