import type Database from 'better-sqlite3';
import type {BranchDefinition} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {selectBranchUnit} from './branch-unit-selection.js';
import {replayScriptCut,scriptDefinitionSupported,type Selected,type ScriptOwnerContext} from './branch-script-continuation.js';
type Row=Record<string,any>;
export const TREE_SCHEMA='ponderosa.branch.script-tree-continuation.v1';
export const TREE_COMPATIBILITY={format:'completed-child-script-tree.v1',nodeMajor:Number(process.versions.node.split('.')[0])};
export const treeIds=(owners:Row[])=>owners.flatMap(o=>[o.executionId,...['paths','steps','attempts','sealedResults'].flatMap(key=>o.selected[key].map((r:Row)=>r.id))]) as string[];
export function treeIdMapSupported(owners:Row[],map:Row,sourceRoot:string,targetRoot:string):boolean {
  const ids=treeIds(owners);
  return !!map&&typeof map==='object'&&!Array.isArray(map)&&new Set(ids).size===ids.length
    &&stableJson(Object.keys(map).sort())===stableJson([...ids].sort())
    &&Object.values(map).every(id=>typeof id==='string'&&!!id&&!ids.includes(id))
    &&new Set(Object.values(map)).size===ids.length&&map[sourceRoot]===targetRoot;
}
export const childTreeLineage=(line:Row,lineageId:number,sourceId:string,targetId:string)=>({schema:'ponderosa.branch.child-tree-lineage.v1',rootLineageId:lineageId,sourceRootId:line.sourceExecutionId,sourceExecutionId:sourceId,executionId:targetId,checkpointId:line.checkpointId,checkpointHash:line.checkpointHash,idMap:line.idMap});
const audit=(db:Database.Database,id:string)=>db.prepare('SELECT id,transition_key,kind,evidence_json,created_at FROM branch_checkpoints WHERE execution_id=? ORDER BY id').all(id);
function read(db:Database.Database,id:number,owner:string):{value:Row;hash:string}|undefined {
  if(!Number.isSafeInteger(id)||id<1||typeof owner!=='string')return;
  const row=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=? AND execution_id=?').get(id,owner) as Row|undefined;
  if(!row)return;
  const value=JSON.parse(row.snapshot_json);if(stableJson(value)!==row.snapshot_json||payloadHash(value)!==row.content_hash)return;
  return {value,hash:row.content_hash};
}
function owner(db:Database.Database,id:string,selected:Selected):Row|undefined {
  const row=db.prepare(`SELECT e.configuration_json,e.checkpoint_invocation_json,v.definition_json,v.content_hash version_hash,b.bindings_json,b.content_hash binding_hash
    FROM branch_executions e JOIN branch_versions v ON v.id=e.version_id JOIN branch_bindings b ON b.id=e.binding_revision_id WHERE e.id=?`).get(id) as Row|undefined;
  if(!row||JSON.parse(row.checkpoint_invocation_json).durability==='failed')return;
  const config=JSON.parse(row.configuration_json);if(Object.keys(config.secretBindings??{}).length)return;
  const {secretBindings,...configuration}=config,inv=JSON.parse(row.checkpoint_invocation_json),e=selected.execution![0]!;
  return {executionId:id,versionId:e.version_id,versionHash:row.version_hash,bindingRevisionId:e.binding_revision_id,bindingHash:row.binding_hash,configuration,selected,audit:audit(db,id),
    invocation:{id:inv.id,ordinal:inv.ordinal,mode:inv.mode,state:inv.state,primaryOutcome:inv.primary_outcome??null,interruptionId:inv.interruptionId??null}};
}
function checkpoint(o:Row):Row|undefined {
  if(o.invocation.mode!=='exit'||o.selected.execution[0].parent_execution_id)return;
  const v=o.invocation;return {invocationId:v.id,mode:v.mode,closing:true,invocation:{id:v.id,ordinal:v.ordinal,mode:v.mode,state:v.state,primaryOutcome:v.primaryOutcome,interruptionId:v.interruptionId}};
}
/** Quiescent Script/control owners only; unfinished calls retain their waiting frontier. */
export function encodeScriptTreeContinuation(db:Database.Database,id:string,selected:Selected):Row|undefined {
    if(selected.execution![0]?.parent_execution_id)return;
    const ids=db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT e.id FROM branch_executions e JOIN tree p ON e.parent_execution_id=p.id) SELECT id FROM tree ORDER BY id`).all(id) as Row[];
    if(ids.length<2)return;
    const owners=ids.map(row=>owner(db,row.id,row.id===id?selected:selectBranchUnit(db,row.id)));
    if(owners.some(row=>!row))return;
    const c={schema:TREE_SCHEMA,compatibility:TREE_COMPATIBILITY,rootExecutionId:id,owners,provenance:[]};
    const provenance=compose(db,c,true);return provenance?{...c,provenance}:undefined;
}
function validateOwners(db:Database.Database,c:Row,seeds?:Map<string,{selected:Selected;idMap:Record<string,string>}>):boolean {
  const owners=c.owners as Row[];
  if(!Array.isArray(owners)||owners.length<2||new Set(owners.map(o=>o.executionId)).size!==owners.length||stableJson(c.compatibility)!==stableJson(TREE_COMPATIBILITY))return false;
  const root=owners.find(o=>o.executionId===c.rootExecutionId);if(!root)return false;
  const allIds=treeIds(owners);if(new Set(allIds).size!==allIds.length)return false;
  const boundary=owners.reduce((last,o)=>Math.max(last,o.audit.at(-1)?.id??NaN),0);if(!Number.isSafeInteger(boundary))return false;
  for(const o of owners){
    const e=o.selected.execution[0],inv=o.invocation;
    const prefix=db.prepare('SELECT id,transition_key,kind,evidence_json,created_at FROM branch_checkpoints WHERE execution_id=? AND id<=? ORDER BY id').all(o.executionId,boundary);
    if(stableJson(prefix)!==stableJson(o.audit))return false;
    const actual=db.prepare('SELECT * FROM branch_executions WHERE id=?').get(o.executionId) as Row|undefined;
    const v=db.prepare('SELECT definition_json,content_hash FROM branch_versions WHERE id=? AND branch_id=?').get(o.versionId,e.branch_id) as Row|undefined;
    const b=db.prepare('SELECT bindings_json,content_hash FROM branch_bindings WHERE id=? AND branch_id=?').get(o.bindingRevisionId,e.branch_id) as Row|undefined;
    if(!actual||JSON.parse(actual.checkpoint_invocation_json).durability==='failed'||!v||!b||e.id!==o.executionId||e.version_id!==o.versionId||e.binding_revision_id!==o.bindingRevisionId
      ||['branch_id','version_id','binding_revision_id','parent_execution_id','parent_attempt_id','call_depth','depth_ceiling','input_hash'].some(k=>actual[k]!==e[k])
      ||v.content_hash!==o.versionHash||payloadHash(JSON.parse(v.definition_json))!==o.versionHash||b.content_hash!==o.bindingHash||payloadHash(JSON.parse(b.bindings_json))!==o.bindingHash
      ||Object.hasOwn(o.configuration,'secretBindings')||Object.keys(JSON.parse(actual.configuration_json).secretBindings??{}).length)return false;
    const {secretBindings,...safe}=JSON.parse(actual.configuration_json);if(stableJson(safe)!==stableJson(o.configuration))return false;
    const definition=JSON.parse(v.definition_json) as BranchDefinition;
    if(!scriptDefinitionSupported(definition,true)||inv.mode!==(o.configuration.checkpointMode??'async')||typeof inv.id!=='string'||!Number.isSafeInteger(inv.ordinal)||inv.ordinal<1)return false;
    const descendant=o.executionId!==c.rootExecutionId,terminal=e.state==='completed';
    if(terminal?(!descendant||inv.state!=='terminal'||inv.primaryOutcome!=='completed'):!['running','waiting'].includes(e.state))return false;
    if(!descendant&&(e.parent_execution_id||e.parent_attempt_id||e.call_depth||e.admission_source!=='manual'))return false;
    if(!terminal&&(inv.mode==='exit'?descendant||inv.state!=='interrupted'||!inv.interruptionId:inv.state!=='active'))return false;
    const direct=owners.filter(child=>child.selected.execution[0].parent_execution_id===o.executionId);
    const actualChildren=db.prepare(`SELECT e.id FROM branch_executions e WHERE e.parent_execution_id=? AND EXISTS(SELECT 1 FROM branch_checkpoints a WHERE a.execution_id=e.id AND a.kind='trigger_accepted' AND a.id<=?) ORDER BY e.id`).all(o.executionId,boundary) as Row[];
    if(stableJson(actualChildren.map(r=>r.id))!==stableJson(direct.map(r=>r.executionId).sort()))return false;
    const children:ScriptOwnerContext['children']={};
    for(const child of direct){
      const ce=child.selected.execution[0],step=o.selected.steps.find((s:Row)=>s.id===o.selected.attempts.find((a:Row)=>a.id===ce.parent_attempt_id)?.step_execution_id),call=definition.steps.find(s=>s.id===step?.step_id);
      const completed=ce.state==='completed';
      if(!step||step.state!==(completed?'completed':'waiting')||call?.kind!=='branch_call'||JSON.parse(b.bindings_json).branches?.[call.branchRef]!==ce.branch_id
        ||ce.call_depth!==e.call_depth+1||ce.depth_ceiling!==Math.min(e.depth_ceiling,ce.call_depth+child.configuration.limits.maxCallDepth)||ce.input_text!==step.input_text
        ||ce.occurrence_key!==`call:${ce.parent_attempt_id}`||children[ce.parent_attempt_id]
        ||(completed?(JSON.parse(step.result_json).failed!==false||JSON.parse(step.result_json).output!==(ce.output_text??undefined)):(step.result_json!==null||ce.output_text!==null)))return false;
      children[ce.parent_attempt_id]={executionId:child.executionId,versionId:child.versionId,output:ce.output_text,completed};
    }
    if(o.selected.steps.some((s:Row)=>definition.steps.find(step=>step.id===s.step_id)?.kind==='branch_call'&&!children[o.selected.attempts.find((a:Row)=>a.step_execution_id===s.id)?.id]))return false;
    let parent:ScriptOwnerContext['parent'];
    if(descendant){
      const p=owners.find(row=>row.executionId===e.parent_execution_id),a=p?.selected.attempts.find((a:Row)=>a.id===e.parent_attempt_id),s=p?.selected.steps.find((s:Row)=>s.id===a?.step_execution_id);
      if(!p||!a||!s||e.admission_source!=='call')return false;parent={executionId:p.executionId,attemptId:a.id,input:s.input_text};
      const visited=new Set<string>();let current:Row|undefined=o;
      while(current?.executionId!==c.rootExecutionId){if(!current||visited.has(current.executionId))return false;visited.add(current.executionId);current=owners.find(row=>row.executionId===current!.selected.execution[0].parent_execution_id);}
    }else if(e.depth_ceiling!==o.configuration.limits.maxCallDepth)return false;
    const waiting=Object.values(children).some(child=>!child.completed);
    if(!terminal&&(e.state!==(waiting?'waiting':'running')||descendant&&inv.mode==='exit'))return false;
    const context:ScriptOwnerContext={terminal,waiting,parent,descendantTraversals:direct.reduce((n,ch)=>n+ch.selected.execution[0].traversals,0),descendantLoops:direct.reduce((n,ch)=>n+ch.selected.execution[0].loop_iterations,0),children,restoredTerminal:terminal&&seeds?.get(o.executionId)?.selected.execution?.[0]?.state==='completed'};
    if(!replayScriptCut(db,o.executionId,o.selected,definition,o.configuration,o.audit,checkpoint(o),seeds?.get(o.executionId),context))return false;
  }
  return true;
}
function compose(db:Database.Database,c:Row,encoding=false):Row[]|undefined {
  try {
    const frames:{c:Row;seeds?:Map<string,{selected:Selected;idMap:Record<string,string>}>;ref?:Row}[]=[],seen=new Set<string>();
    let current=c;
    for(;;){
      if(current.schema!==TREE_SCHEMA||seen.has(current.rootExecutionId))return;seen.add(current.rootExecutionId);
      const frame:typeof frames[number]={c:current};frames.push(frame);
      const root=current.owners.find((o:Row)=>o.executionId===current.rootExecutionId);if(!root)return;
      const origins=root.audit.filter((a:Row)=>a.kind==='tree_historical_rewind');
      if(!origins.length){if(current.owners.some((o:Row)=>o.audit.some((a:Row)=>['tree_historical_rewind','tree_restored_prefix'].includes(a.kind))))return;break;}
      if(origins.length!==1)return;
      const evidence=JSON.parse(origins[0].evidence_json),stored=read(db,evidence.lineageId,current.rootExecutionId);if(!stored)return;
      const line=stored.value,source=read(db,line.checkpointId,line.sourceExecutionId);
      if(!source||line.schema!=='ponderosa.branch.tree-rewind-lineage.v1'||line.executionId!==current.rootExecutionId||source.hash!==line.checkpointHash
        ||line.commandHash!==payloadHash({executionId:line.sourceExecutionId,checkpointId:line.checkpointId,expectedHash:line.checkpointHash})||typeof line.commandKey!=='string')return;
      const snapshot=source.value,old=snapshot.continuation;
      if(snapshot.schema!=='branch-unit-selected.v2'||snapshot.restore_supported!==true||old?.schema!==TREE_SCHEMA||!treeSnapshotMetadata(snapshot,old)||old.rootExecutionId!==line.sourceExecutionId)return;
      const receipt=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(line.sourceExecutionId,`tree-historical-rewind:${payloadHash(line.commandKey)}`) as Row|undefined;
      if(!receipt||receipt.input_hash!==line.commandHash||receipt.result_json!==stableJson({executionId:current.rootExecutionId,lineageId:evidence.lineageId}))return;
      const map=line.idMap;
      if(!treeIdMapSupported(old.owners,map,old.rootExecutionId,current.rootExecutionId))return;
      const seeds=new Map<string,{selected:Selected;idMap:Record<string,string>}>();
      for(const previous of old.owners){
        const target=current.owners.find((o:Row)=>o.executionId===map[previous.executionId]);if(!target)return;
        if(['versionId','versionHash','bindingRevisionId','bindingHash'].some(key=>target[key]!==previous[key])||stableJson(target.configuration)!==stableJson(previous.configuration))return;
        const ce=target.selected.execution[0],pe=previous.selected.execution[0];
        if(ce.parent_execution_id!==(pe.parent_execution_id?map[pe.parent_execution_id]:null)||ce.parent_attempt_id!==(pe.parent_attempt_id?map[pe.parent_attempt_id]:null)||ce.input_text!==pe.input_text)return;
        const origin=target.audit.filter((a:Row)=>a.kind==='tree_historical_rewind'),prefix=target.audit.filter((a:Row)=>a.kind==='tree_restored_prefix');
        if(origin.length!==1||prefix.length!==1||target.audit[0]?.kind!=='trigger_accepted'||target.audit[1]!==prefix[0]||target.audit[2]!==origin[0]||prefix[0].transition_key!=='tree-restored-prefix'||origin[0].transition_key!=='tree-rewind-origin')return;
        const value=JSON.parse(origin[0].evidence_json),expected={sourceRootId:line.sourceExecutionId,sourceExecutionId:previous.executionId,checkpointId:line.checkpointId,checkpointHash:line.checkpointHash,commandKey:line.commandKey,lineageId:evidence.lineageId,...(previous.executionId!==old.rootExecutionId?{childLineageId:value.childLineageId}:{})};
        if(stableJson(value)!==stableJson(expected)||prefix[0].evidence_json!==stableJson(expected))return;
        if(previous.executionId!==old.rootExecutionId){const child=read(db,value.childLineageId,target.executionId);if(!child||stableJson(child.value)!==stableJson(childTreeLineage(line,evidence.lineageId,previous.executionId,target.executionId)))return;}
        seeds.set(target.executionId,{selected:previous.selected,idMap:map});
      }
      for(const o of current.owners)if(!seeds.has(o.executionId)&&o.audit.some((a:Row)=>['tree_historical_rewind','tree_restored_prefix'].includes(a.kind)))return;
      frame.seeds=seeds;frame.ref={executionId:current.rootExecutionId,sourceExecutionId:line.sourceExecutionId,lineageId:evidence.lineageId,lineageHash:stored.hash,checkpointId:line.checkpointId,checkpointHash:line.checkpointHash};current=old;
    }
    const flat:Row[]=[];
    for(const frame of frames.reverse()){
      if(frame.ref)flat.push(frame.ref);
      if(!(encoding&&frame.c===c)&&stableJson(frame.c.provenance??[])!==stableJson(flat))return;
      if(!validateOwners(db,frame.c,frame.seeds))return;
    }
    return flat;
  }catch{return;}
}
function treeSnapshotMetadata(snapshot:Row,c:Row):boolean {
  const root=c.owners?.find((o:Row)=>o.executionId===c.rootExecutionId);if(!root)return false;
  return stableJson(snapshot.selected)===stableJson(root.selected)&&snapshot.invocationId===root.invocation.id&&snapshot.mode===root.invocation.mode&&snapshot.closing===(root.invocation.state==='interrupted'||root.invocation.state==='terminal');
}
export function scriptTreeSnapshotSupported(db:Database.Database,id:string,snapshot:Row):boolean {
  try {const c=snapshot.continuation;return snapshot.schema==='branch-unit-selected.v2'&&snapshot.restore_supported===true&&c?.schema===TREE_SCHEMA&&c.rootExecutionId===id&&treeSnapshotMetadata(snapshot,c)&&compose(db,c)!==undefined;}catch{return false;}
}
