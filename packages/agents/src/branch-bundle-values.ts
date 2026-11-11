import {createHash} from 'node:crypto';
import {branchText} from './branch-definition.js';
import {stableJson} from './coordination-v3-canonical-json.js';
import type {Selected} from './branch-script-continuation.js';
type Row=Record<string,any>;
export type BundleValueSeed={selected:Selected;idMap:Record<string,string>;bundleMap?:BundleValueMap};
export type BundleValueOwner={selected:Selected;audit:Row[];seed?:BundleValueSeed};
export type BundleValueMap={owners:BundleValueOwner[];ids:Record<string,string>};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export const bundleReference=(s:unknown)=>typeof s==='string'?/^branch-result-bundle:([0-9a-f-]{36}):([0-9a-f-]{36})$/u.exec(s):null;
const execution=(o:BundleValueOwner)=>o.selected.execution![0]!;
export function bundleAncestor(owners:BundleValueOwner[],ancestor:string,child:string):boolean {
 const seen=new Set<string>();
 while(child!==ancestor){if(seen.has(child))return false;seen.add(child);const owner=owners.find(o=>execution(o).id===child);if(!owner||!execution(owner).parent_execution_id)return false;child=execution(owner).parent_execution_id;}
 return true;
}
/** Runnable callers supply composer-validated seeds; transport uses these checks for structural membership only. */
export function inheritedBundleCallInput(parent:BundleValueOwner,child:BundleValueOwner):string|undefined {
 const p=parent.seed,c=child.seed,e=execution(child),pe=execution(parent);
 if(!p?.bundleMap||!c?.bundleMap||stableJson(p.idMap)!==stableJson(c.idMap)||stableJson(p.bundleMap)!==stableJson(c.bundleMap))return;
 const old=c.selected.execution![0]!,oldParent=p.selected.execution![0]!,map=c.bundleMap;
 if(stableJson(c.idMap)!==stableJson(map.ids))return;
 if(map.ids[old.id]!==e.id||map.ids[oldParent.id]!==pe.id||old.parent_execution_id!==oldParent.id||map.ids[old.parent_attempt_id]!==e.parent_attempt_id||e.parent_execution_id!==pe.id
  ||stableJson(map.owners.find(o=>execution(o).id===old.id)?.selected)!==stableJson(c.selected)||stableJson(map.owners.find(o=>execution(o).id===oldParent.id)?.selected)!==stableJson(p.selected))return;
 const step=p.selected.steps!.find(s=>s.id===p.selected.attempts!.find(a=>a.id===old.parent_attempt_id)?.step_execution_id),current=parent.selected.steps!.find(s=>s.id===parent.selected.attempts!.find(a=>a.id===e.parent_attempt_id)?.step_execution_id);
 if(!step||!current||map.ids[step.id]!==current.id||!bundleReference(step.input_text)||current.input_text!==remapBundleValue(step.input_text,oldParent.id,pe.id,map))return;
 const input=remapBundleValue(old.input_text,old.id,e.id,map);
 if(e.input_text!==input||e.input_hash!==hash(stableJson({parentAttempt:e.parent_attempt_id,input:current.input_text})))return;
 return input;
}
/** Only an exact native forwarding event or the exact child's validated seed changes input. */
export function bundleCallInput(owner:BundleValueOwner,attemptId:string,child?:BundleValueOwner):string {
 const s=owner.selected,step=s.steps!.find(row=>row.id===s.attempts!.find(a=>a.id===attemptId)?.step_execution_id);
 if(!step)throw Error('Missing bundle Call Step');
 const events=owner.audit.filter(a=>a.kind==='result_bundle_forwarded'&&JSON.parse(a.evidence_json).attemptId===attemptId);
 if(events.length>1)throw Error('Duplicate bundle forwarding');
 if(events.length)return `branch-result-bundle:${execution(owner).id}:${JSON.parse(events[0]!.evidence_json).forwardedBundleId}`;
 return child&&execution(child).parent_attempt_id===attemptId?inheritedBundleCallInput(owner,child)??step.input_text:step.input_text;
}
/** A producer is either this owner's closed Join or a causally earlier native adoption. */
export function treeBundle(owners:BundleValueOwner[],ownerId:string,bundleId:string,before=Infinity,seen=new Set<string>()):Row|undefined {
 const owner=owners.find(o=>execution(o).id===ownerId),bundle=owner?.selected.bundles!.find(b=>b.id===bundleId);
 if(!owner||!bundle||seen.has(bundleId))return;seen.add(bundleId);
 if(stableJson(Object.keys(bundle).sort())!==stableJson(['id','execution_id','fork_invocation_id','content_text','content_hash'].sort())||bundle.execution_id!==ownerId||typeof bundle.content_text!=='string'||Buffer.byteLength(bundle.content_text)>8_000_000||Buffer.from(bundle.content_text,'utf8').toString('utf8')!==bundle.content_text||hash(bundle.content_text)!==bundle.content_hash)return;
 try{branchText(bundle.content_text);return;}catch{/* Native bundles exceed the inline contract. */}
 const fork=owner.selected.forks!.find(f=>f.id===bundle.fork_invocation_id);
 if(fork){
  const produced=owner.audit.filter(a=>a.kind==='join_resolved'&&a.transition_key===`joined:${fork.id}`);
  if(fork.execution_id!==ownerId||fork.state!=='closed'||JSON.parse(fork.result_json).failed!==false||JSON.parse(fork.result_json).output!==`branch-result-bundle:${ownerId}:${bundleId}`||produced.length>1||produced.length===1&&(produced[0]!.id>=before||stableJson(JSON.parse(produced[0]!.evidence_json).result)!==fork.result_json)||!produced.length&&!owner.audit.some(a=>['foreign_tree_selected_prefix','tree_restored_prefix'].includes(a.kind)&&a.id<before)||owner.selected.bundles!.filter(b=>b.fork_invocation_id===fork.id).length!==1)return;
  return bundle;
 }
 const forwards=owner.audit.filter(a=>a.kind==='result_bundle_forwarded'&&JSON.parse(a.evidence_json).forwardedBundleId===bundleId);
 if(!forwards.length){
  // Eligibility only: the lineage composer and exact seeded replay must prove inherited rows.
  if(!owner.audit.some(a=>['foreign_tree_selected_prefix','tree_restored_prefix'].includes(a.kind)&&a.id<before))return;
  const producer=owners.find(o=>o.selected.forks!.some(f=>f.id===bundle.fork_invocation_id));
  const original=producer?.selected.bundles!.find(b=>b.fork_invocation_id===bundle.fork_invocation_id);
  if(!producer||!original||execution(producer).id===ownerId||!bundleAncestor(owners,ownerId,execution(producer).id))return;
  const produced=treeBundle(owners,execution(producer).id,original.id,before,seen);
  return produced&&produced.content_text===bundle.content_text&&produced.content_hash===bundle.content_hash?bundle:undefined;
 }
 if(forwards.length!==1)return;
 const event=forwards[0]!,v=JSON.parse(event.evidence_json),step=owner.selected.steps!.find(s=>s.id===owner.selected.attempts!.find(a=>a.id===v.attemptId)?.step_execution_id),child=owners.find(o=>execution(o).id===v.childExecutionId),admission=owner.audit.find(a=>a.kind==='child_admitted'&&a.transition_key===`call:${v.attemptId}`);
 if(stableJson(Object.keys(v).sort())!==stableJson(['attemptId','childExecutionId','sourceBundleId','sourceExecutionId','forwardedBundleId','contentHash'].sort())||event.transition_key!==`bundle-forwarded:${v.attemptId}`||event.id>=before||!admission||admission.id>=event.id||JSON.parse(admission.evidence_json).childExecutionId!==v.childExecutionId||!step||step.input_text!==`branch-result-bundle:${v.sourceExecutionId}:${v.sourceBundleId}`||!child||execution(child).parent_execution_id!==ownerId||execution(child).parent_attempt_id!==v.attemptId||execution(child).input_text!==`branch-result-bundle:${ownerId}:${bundleId}`||v.sourceExecutionId===ownerId||!bundleAncestor(owners,ownerId,v.sourceExecutionId)||v.contentHash!==bundle.content_hash)return;
 const source=treeBundle(owners,v.sourceExecutionId,v.sourceBundleId,event.id,seen);
 if(!source||source.fork_invocation_id!==bundle.fork_invocation_id||source.content_text!==bundle.content_text||source.content_hash!==bundle.content_hash)return;
 return bundle;
}
/** Caller still replays every producer and every owner's exact selected audit. */
export function bundleValue(owners:BundleValueOwner[],current:string,value:unknown,before=Infinity):Row|undefined {
 const ref=bundleReference(value);if(!ref||!bundleAncestor(owners,current,ref[1]!)&&!bundleAncestor(owners,ref[1]!,current))return;
 return treeBundle(owners,ref[1]!,ref[2]!,before);
}
export function remapBundleValue(value:string,source:string,target:string,map?:BundleValueMap):string {
 const ref=bundleReference(value);if(!ref)return value;
 const bundle=map?.owners.find(o=>execution(o).id===ref[1])?.selected.bundles!.find(b=>b.id===ref[2]&&b.execution_id===ref[1]);
 if(!map||!bundle||hash(bundle.content_text)!==bundle.content_hash||!bundleAncestor(map.owners,source,ref[1]!)&&!bundleAncestor(map.owners,ref[1]!,source)||!map.ids[ref[1]!]||!map.ids[ref[2]!]||map.ids[source]!==target)throw Error('Bundle value lacks exact tree ownership map');
 return `branch-result-bundle:${map.ids[ref[1]!]!}:${map.ids[ref[2]!]!}`;
}

export function bundleParentInput(owners:BundleValueOwner[],child:Row):string {
 if(!child.parent_execution_id)return child.input_text;
 const parent=owners.find(o=>execution(o).id===child.parent_execution_id),attempt=parent?.selected.attempts!.find(a=>a.id===child.parent_attempt_id),step=parent?.selected.steps!.find(s=>s.id===attempt?.step_execution_id);
 if(!step)throw Error('Missing original parent input');return step.input_text;
}

/** Native forwarding is mandatory for descendant values; siblings never become readable. */
export function bundleCallSupported(owners:BundleValueOwner[],parent:BundleValueOwner,child:Row):boolean {
 const input=bundleParentInput(owners,child),ref=bundleReference(input),parentId=execution(parent).id,owner=owners.find(o=>execution(o).id===child.id);
 if(owner&&inheritedBundleCallInput(parent,owner)!==undefined)return !!bundleValue(owners,parentId,input)&&!!bundleValue(owners,parentId,child.input_text);
 if(!ref)return child.input_text===input;
 if(ref[1]!==parentId&&bundleAncestor(owners,parentId,ref[1]!))return parent.audit.some(a=>a.kind==='result_bundle_forwarded'&&JSON.parse(a.evidence_json).attemptId===child.parent_attempt_id)&&child.input_text===bundleCallInput(parent,child.parent_attempt_id,owner)&&!!bundleValue(owners,parentId,child.input_text);
 const admitted=owners.find(o=>execution(o).id===child.id)?.audit.find(a=>a.kind==='trigger_accepted');
 return child.input_text===input&&!!admitted&&!!bundleValue(owners,parentId,input,admitted.id);
}
