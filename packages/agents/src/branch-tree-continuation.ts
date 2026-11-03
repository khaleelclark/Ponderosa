import {captureForeignTreeGeneration,heldTreeSource,treeFact,portableTreeOwners} from './branch-tree-generation.js';
import {validateBranchExecutionTree,readHeldTreeForContinuation} from './branch-runtime-tree-package.js';
import {validateBranchDefinition} from './branch-definition.js';
import {issuedResourceFrontierSupported} from './branch-issued-continuation.js';
import {retainedResourceCapture} from './branch-resource-capture.js';
import {coordinationLineageSupported} from './branch-host-provenance.js';
import {captureBranchHostCut,verifyBranchHostCut} from './branch-host-cut.js';
import {retainedBranchHostGraph} from './branch-tree-host-cut.js';
import {hasParallelControls} from './branch-parallel-continuation.js';
import {branchContinuationIds} from './branch-continuation-remap.js';
import type Database from 'better-sqlite3';
import type {BranchPortableExecutionTree,BranchPortableRuntimeOwner,BranchDefinition} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {selectBranchUnit} from './branch-unit-selection.js';
import {replayScriptCut,scriptDefinitionSupported,resourceReservationSupported,type Selected,type ScriptOwnerContext} from './branch-script-continuation.js';
type Row=Record<string,any>;
export const TREE_SCHEMA='ponderosa.branch.script-tree-continuation.v1';
export const TREE_COMPATIBILITY={format:'completed-child-script-tree.v1',nodeMajor:Number(process.versions.node.split('.')[0])};
export const treeIds=(owners:Row[])=>owners.flatMap(o=>[o.executionId,...branchContinuationIds(o.selected)]) as string[];
export function treeIdMapSupported(owners:Row[],map:Row,sourceRoot:string,targetRoot:string):boolean {
  const ids=treeIds(owners);
  return !!map&&typeof map==='object'&&!Array.isArray(map)&&new Set(ids).size===ids.length
    &&stableJson(Object.keys(map).sort())===stableJson([...ids].sort())
    &&Object.values(map).every(id=>typeof id==='string'&&!!id&&!ids.includes(id))
    &&new Set(Object.values(map)).size===ids.length&&map[sourceRoot]===targetRoot;
}
export const childTreeLineage=(line:Row,lineageId:number,sourceId:string,targetId:string)=>({schema:'ponderosa.branch.child-tree-lineage.v1',rootLineageId:lineageId,sourceRootId:line.sourceExecutionId,sourceExecutionId:sourceId,executionId:targetId,checkpointId:line.checkpointId,checkpointHash:line.checkpointHash,...(line.coordination?{restorationId:line.coordination.restorationId}:{}),idMap:line.idMap});
/** Bind tree replay to the one immutable canonical receipt, never to caller-supplied maps. */
export const treeCoordinationLineageSupported=coordinationLineageSupported;
const audit=(db:Database.Database,id:string)=>db.prepare('SELECT id,transition_key,kind,evidence_json,created_at FROM branch_checkpoints WHERE execution_id=? ORDER BY id').all(id);
function read(db:Database.Database,id:number,owner:string,evidence?:Map<string,BranchPortableRuntimeOwner>):{value:Row;hash:string}|undefined {
  if(!Number.isSafeInteger(id)||id<1||typeof owner!=='string')return;
  const fact=evidence?.get(owner)?.facts.find(f=>f.kind==='checkpoint'&&f.key===String(id));
  const row=evidence?fact?{snapshot_json:fact.json,content_hash:fact.sha256}:undefined:db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=? AND execution_id=?').get(id,owner) as Row|undefined;
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
  const hostDependencies=captureBranchHostCut(db,id,selected);
  return {...(hostDependencies?{hostDependencies,hostDependenciesHash:payloadHash(hostDependencies)}:{}),executionId:id,versionId:e.version_id,versionHash:row.version_hash,bindingRevisionId:e.binding_revision_id,bindingHash:row.binding_hash,configuration,selected,audit:audit(db,id),
    invocation:{id:inv.id,ordinal:inv.ordinal,mode:inv.mode,state:inv.state,primaryOutcome:inv.primary_outcome??null,interruptionId:inv.interruptionId??null}};
}
/** Async children and every EXIT owner need their own committed saver bytes. */
function ownerSaved(db:Database.Database,o:Row,evidence?:Map<string,BranchPortableRuntimeOwner>,savedId?:number):boolean {
 try {
  const rows:Row[]=evidence?evidence.get(o.executionId)?.facts.filter(f=>f.kind==='checkpoint').map(f=>({snapshot_json:f.json,content_hash:f.sha256}))??[]:db.prepare('SELECT id,snapshot_json,content_hash FROM branch_unit_snapshots WHERE execution_id=?').all(o.executionId) as Row[];
  return rows.some(row=>{
   const saved=JSON.parse(row.snapshot_json),inv=o.invocation;
   return (savedId===undefined||row.id===savedId)&&stableJson(saved)===row.snapshot_json&&payloadHash(saved)===row.content_hash&&saved.schema==='branch-unit-selected.v2'&&saved.mode===inv.mode&&saved.invocationId===inv.id&&saved.closing===(inv.state==='interrupted'||inv.state==='terminal')&&stableJson(saved.selected)===stableJson(o.selected);
  });
 }catch{return false;}
}
function checkpoint(o:Row):Row|undefined {
  if(o.invocation?.mode!=='exit')return;
  const v=o.invocation;return {invocationId:v.id,mode:v.mode,closing:true,invocation:{id:v.id,ordinal:v.ordinal,mode:v.mode,state:v.state,primaryOutcome:v.primaryOutcome,...(v.interruptionId?{interruptionId:v.interruptionId}:{})}};
}
/** Quiescent Script/control owners only; unfinished calls retain their waiting frontier. */
function captureScriptTreeContinuation(db:Database.Database,id:string,selected:Selected,issuedResources=false,latest=false):Row|undefined {
    if(selected.execution![0]?.parent_execution_id)return;
    const ids=db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT e.id FROM branch_executions e JOIN tree p ON e.parent_execution_id=p.id) SELECT id FROM tree ORDER BY id`).all(id) as Row[];
    // An unstarted reservation owns no released Chat/import effect or external identity.
    if(!issuedResources&&selected.resources?.length&&!retainedResourceCapture(selected)&&db.prepare('SELECT 1 FROM branch_resource_members WHERE step_execution_id IN (SELECT id FROM branch_step_executions WHERE execution_id=?) UNION ALL SELECT 1 FROM branch_ephemeral_contexts WHERE step_execution_id IN (SELECT id FROM branch_step_executions WHERE execution_id=?) LIMIT 1').get(id,id))return;
    const owners=ids.map(row=>owner(db,row.id,row.id===id?selected:selectBranchUnit(db,row.id)));
    if(owners.some(row=>!row))return;
    const c={schema:TREE_SCHEMA,compatibility:TREE_COMPATIBILITY,rootExecutionId:id,owners,provenance:[],...(issuedResources?{issuedResources:true}:{})};
    const provenance=compose(db,c,true,undefined,undefined,0,latest);return provenance?{...c,provenance}:undefined;
}
export function encodeScriptTreeContinuation(db:Database.Database,id:string,selected:Selected,issuedResources=false):Row|undefined {
  return captureScriptTreeContinuation(db,id,selected,issuedResources);
}
/** Receipt recovery proves destination cancellation through the same complete tree replay. */
export function scriptTreeLatestSupported(db:Database.Database,id:string):boolean {
  try {return captureScriptTreeContinuation(db,id,selectBranchUnit(db,id),false,true)!==undefined;}catch{return false;}
}
function validateOwners(db:Database.Database,c:Row,seeds?:Map<string,{selected:Selected;idMap:Record<string,string>;requestMap?:Record<string,string>}>,encoding=false,evidence?:Map<string,BranchPortableRuntimeOwner>,latest=false):boolean {
  const owners=c.owners as Row[];
  if(!Array.isArray(owners)||owners.length<1||new Set(owners.map(o=>o.executionId)).size!==owners.length||stableJson(c.compatibility)!==stableJson(TREE_COMPATIBILITY))return false;
  const root=owners.find(o=>o.executionId===c.rootExecutionId);if(!root)return false;
  const allIds=treeIds(owners);if(new Set(allIds).size!==allIds.length)return false;
  const boundary=owners.reduce((last,o)=>Math.max(last,o.audit.at(-1)?.id??NaN),0);if(!Number.isSafeInteger(boundary))return false;
  if(owners.some(o=>o.selected.attempts.some((a:Row)=>a.request_id)))retainedBranchHostGraph({selected:root.selected,hostDependencies:root.hostDependencies,continuation:c},c.rootExecutionId,true,c.issuedResources===true);
  for(const o of owners){
    const e=o.selected.execution[0],inv=o.invocation??{};
    const source=evidence?.get(o.executionId),fact=(kind:string)=>source?.facts.find(f=>f.kind===kind);
    const fullAudit=source?.facts.filter(f=>f.kind==='transition').map(f=>JSON.parse(f.json));
    const prefix=evidence?fullAudit?.filter(a=>a.id<=boundary):db.prepare('SELECT id,transition_key,kind,evidence_json,created_at FROM branch_checkpoints WHERE execution_id=? AND id<=? ORDER BY id').all(o.executionId,boundary);
    if(stableJson(prefix)!==stableJson(o.audit))return false;
    const actual=evidence?source?{...JSON.parse(fact('frontier')!.json).execution[0],configuration_json:stableJson(JSON.parse(fact('configuration')!.json).configuration),checkpoint_invocation_json:'{}'}:undefined:db.prepare('SELECT * FROM branch_executions WHERE id=?').get(o.executionId) as Row|undefined;
    const v=evidence?fact('definition')?{definition_json:fact('definition')!.json,content_hash:fact('definition')!.sha256}:undefined:db.prepare('SELECT definition_json,content_hash FROM branch_versions WHERE id=? AND branch_id=?').get(o.versionId,e.branch_id) as Row|undefined;
    const b=evidence?fact('bindings')?{bindings_json:fact('bindings')!.json,content_hash:fact('bindings')!.sha256}:undefined:db.prepare('SELECT bindings_json,content_hash FROM branch_bindings WHERE id=? AND branch_id=?').get(o.bindingRevisionId,e.branch_id) as Row|undefined;
    if(!actual||JSON.parse(actual.checkpoint_invocation_json).durability==='failed'||!v||!b||e.id!==o.executionId||e.version_id!==o.versionId||e.binding_revision_id!==o.bindingRevisionId
      ||['branch_id','version_id','binding_revision_id','parent_execution_id','parent_attempt_id','call_depth','depth_ceiling','input_hash'].some(k=>actual[k]!==e[k])
      ||v.content_hash!==o.versionHash||payloadHash(JSON.parse(v.definition_json))!==o.versionHash||b.content_hash!==o.bindingHash||payloadHash(JSON.parse(b.bindings_json))!==o.bindingHash
      ||evidence&&(fact('definition')?.key!==o.versionId||fact('bindings')?.key!==o.bindingRevisionId)||Object.hasOwn(o.configuration,'secretBindings')||Object.keys(JSON.parse(actual.configuration_json).secretBindings??{}).length)return false;
    const {secretBindings,...safe}=JSON.parse(actual.configuration_json);if(stableJson(safe)!==stableJson(o.configuration))return false;
    const acceptance=source?.facts.find(f=>f.kind==='acceptance');
    if(acceptance){
      const accepted=JSON.parse(acceptance.json),started=o.audit.filter((a:Row)=>a.kind==='workflow_started');
      if(started.length?(started.length!==1||typeof accepted.admittedAt!=='string'||!accepted.admittedAt||typeof accepted.admissionJson!=='string'||started[0].evidence_json!==stableJson({admission:JSON.parse(accepted.admissionJson)})):(accepted.admittedAt!==null||accepted.admissionJson!==null))return false;
    }
    if(source&&treeFact(source,'provenance').source==='historical_child'&&(!seeds?.has(o.executionId)||!o.audit.some((a:Row)=>a.kind==='tree_historical_rewind')))return false;
    const definition=JSON.parse(v.definition_json) as BranchDefinition;
    const issuedResource=c.issuedResources===true;
    const workflowGates=definition.steps.some(s=>s.kind==='human_gate');
    if(workflowGates&&(o.audit.some((a:Row)=>['tree_historical_rewind','tree_restored_prefix'].includes(a.kind))&&!seeds?.has(o.executionId)||issuedResource||!['sync','async','exit'].includes(o.configuration.checkpointMode??'async')||definition.trigger.kind!=='manual'||definition.steps.some(s=>!['script','branch_call','human_gate'].includes(s.kind))||o.hostDependencies||o.selected.resources.length||o.selected.actions.length||o.selected.bundles.length||o.selected.attempts.some((a:Row)=>a.request_id||a.recovery_of_request_id||a.runtime_outcome_json)))return false;
    if(issuedResource&&(hasParallelControls(definition)||o.selected.resources.length!==1||o.configuration.checkpointMode==='exit'))return false;
    const resourceFrontier=issuedResource?issuedResourceFrontierSupported(o.selected,definition,o.hostDependencies,false,true):resourceReservationSupported(o.selected,definition);
    if(issuedResource&&!resourceFrontier)return false;
    const capture=retainedResourceCapture(o.selected);
    if(capture&&(capture.source.intent.bindingSha256!==o.bindingHash||capture.source.intent.configurationSha256!==payloadHash(o.configuration)))return false;
    if(capture){
      const cut=o.hostDependencies,r=o.selected.resources[0],operation=JSON.parse(r.import_operation_json),chatOperation=JSON.parse(r.chat_operation_json);
      if(!cut||o.hostDependenciesHash!==payloadHash(cut)||!verifyBranchHostCut(cut,o.executionId)||!cut.coverage.complete
       ||stableJson(cut.resources.map((x:Row)=>x.row))!==stableJson(o.selected.resources)
       ||stableJson(cut.resourceMembers.map((x:Row)=>x.row.agent_id).sort())!==stableJson([...capture.source.agentIds].sort())
       ||cut.resourceMembers.some((x:Row)=>x.row.step_execution_id!==r.step_execution_id||x.row.origin!=='template')
       ||cut.resourceContexts.length!==1||cut.resourceContexts[0].row.step_execution_id!==r.step_execution_id||cut.resourceContexts[0].row.generation!==r.generation||cut.resourceContexts[0].row.chat_id!==r.chat_id
       ||stableJson(JSON.parse(cut.resourceContexts[0].row.agent_ids_json))!==stableJson(capture.source.agentIds))return false;
      const release=cut.resourceReceipts.find((x:Row)=>x.row.execution_id===o.executionId&&x.row.command_key===`resource-release:${r.creation_key}:${chatOperation.token}`)?.row;
      if(!release||release.input_hash!==payloadHash({creationKey:r.creation_key,token:chatOperation.token})||release.result_json!==stableJson({phase:'chat',token:chatOperation.token,generation:r.generation}))return false;
      const creation=cut.resourceReceipts.find((x:Row)=>x.row.id===operation.creationOperationId)?.row;
      const members=cut.resourceReceipts.filter((x:Row)=>x.row.operation_id===operation.creationOperationId).map((x:Row)=>x.row).sort((a:Row,b:Row)=>a.position-b.position);
      if(!creation||creation.kind!=='import'||creation.status!=='completed'||members.some((x:Row,i:number)=>x.position!==i)
       ||stableJson(members.map((x:Row)=>x.agent_id))!==stableJson(capture.source.agentIds))return false;
    }

    if(owners.length===1&&!resourceFrontier&&!definition.steps.some(s=>s.kind==='branch_call'))return false;
    if(!scriptDefinitionSupported(definition,true,resourceFrontier)||!latest&&(inv.mode!==(o.configuration.checkpointMode??'async')||typeof inv.id!=='string'||!inv.id||!Number.isSafeInteger(inv.ordinal)||inv.ordinal<1))return false;
    const descendant=o.executionId!==c.rootExecutionId,terminal=['completed','failed'].includes(e.state);
    const exit=o.configuration.checkpointMode==='exit';
    if(exit&&(inv.mode!=='exit'||typeof inv.id!=='string'||!inv.id||!Number.isSafeInteger(inv.ordinal)||inv.ordinal<1||!['interrupted','terminal'].includes(inv.state)||inv.primaryOutcome!==(terminal?e.state:'interrupted')))return false;
    const currentExit=exit&&latest&&!evidence?JSON.parse(actual.checkpoint_invocation_json):undefined;
    if(currentExit&&(currentExit.id!==inv.id||currentExit.mode!=='exit'||currentExit.state!==inv.state||currentExit.durability!=='saved'||!Number.isSafeInteger(currentExit.saved_snapshot_id)))return false;
    if(!issuedResource&&!resourceFrontier&&(!encoding||latest)&&(exit||!latest&&descendant&&(o.configuration.checkpointMode??'async')==='async')&&!ownerSaved(db,o,evidence,currentExit?.saved_snapshot_id))return false;
    if(terminal?(!descendant&&!latest||!latest&&(inv.state!=='terminal'||inv.primaryOutcome!==e.state)):!['running','waiting'].includes(e.state))return false;
    if(!descendant&&(e.parent_execution_id||e.parent_attempt_id||e.call_depth||e.admission_source!=='manual'))return false;
    const pendingGate=o.selected.gates.find((g:Row)=>g.state==='waiting');
    const gateClosed=workflowGates&&inv.state==='interrupted'&&inv.primaryOutcome==='interrupted'&&!inv.interruptionId&&o.selected.gates.some((g:Row)=>o.audit.some((a:Row)=>a.kind==='gate_checkpoint_closed'&&a.transition_key===`gate-invocation:${inv.id}`&&a.evidence_json===stableJson({gateId:g.id,invocationId:inv.id,ordinal:inv.ordinal,mode:inv.mode})));
    if(!latest&&!terminal&&(inv.mode==='exit'?inv.state!=='interrupted'||!inv.interruptionId&&!pendingGate:inv.state!=='active'&&!gateClosed))return false;
    const direct=owners.filter(child=>child.selected.execution[0].parent_execution_id===o.executionId);
    const actualChildren=evidence?[...evidence.values()].filter(child=>JSON.parse(child.facts.find(f=>f.kind==='frontier')!.json).execution[0].parent_execution_id===o.executionId&&child.facts.some(f=>f.kind==='transition'&&JSON.parse(f.json).kind==='trigger_accepted'&&JSON.parse(f.json).id<=boundary)).map(child=>({id:child.sourceExecutionId})).sort((a,b)=>a.id.localeCompare(b.id)):db.prepare(`SELECT e.id FROM branch_executions e WHERE e.parent_execution_id=? AND EXISTS(SELECT 1 FROM branch_checkpoints a WHERE a.execution_id=e.id AND a.kind='trigger_accepted' AND a.id<=?) ORDER BY e.id`).all(o.executionId,boundary) as Row[];
    if(stableJson(actualChildren.map(r=>r.id))!==stableJson(direct.map(r=>r.executionId).sort()))return false;
    const children:ScriptOwnerContext['children']={};
    for(const child of direct){
      const ce=child.selected.execution[0],step=o.selected.steps.find((s:Row)=>s.id===o.selected.attempts.find((a:Row)=>a.id===ce.parent_attempt_id)?.step_execution_id),call=definition.steps.find(s=>s.id===step?.step_id);
      const completed=['completed','failed'].includes(ce.state),failed=ce.state==='failed';
      if(!step||step.state!==(completed?ce.state:'waiting')||call?.kind!=='branch_call'||JSON.parse(b.bindings_json).branches?.[call.branchRef]!==ce.branch_id
        ||ce.call_depth!==e.call_depth+1||ce.depth_ceiling!==Math.min(e.depth_ceiling,ce.call_depth+child.configuration.limits.maxCallDepth)||ce.input_text!==step.input_text
        ||ce.occurrence_key!==`call:${ce.parent_attempt_id}`||children[ce.parent_attempt_id]
        ||(completed?(JSON.parse(step.result_json).failed!==failed||JSON.parse(step.result_json).output!==(ce.output_text??undefined)):(step.result_json!==null||ce.output_text!==null)))return false;
      children[ce.parent_attempt_id]={executionId:child.executionId,versionId:child.versionId,output:ce.output_text,completed,failed};
    }
    if(o.selected.steps.some((s:Row)=>definition.steps.find(step=>step.id===s.step_id)?.kind==='branch_call'&&!children[o.selected.attempts.find((a:Row)=>a.step_execution_id===s.id)?.id]))return false;
    let parent:ScriptOwnerContext['parent'];
    if(descendant){
      const p=owners.find(row=>row.executionId===e.parent_execution_id),a=p?.selected.attempts.find((a:Row)=>a.id===e.parent_attempt_id),s=p?.selected.steps.find((s:Row)=>s.id===a?.step_execution_id);
      if(!p||!a||!s||e.admission_source!=='call')return false;parent={executionId:p.executionId,attemptId:a.id,input:s.input_text};
      const visited=new Set<string>();let current:Row|undefined=o;
      while(current?.executionId!==c.rootExecutionId){if(!current||visited.has(current.executionId))return false;visited.add(current.executionId);current=owners.find(row=>row.executionId===current!.selected.execution[0].parent_execution_id);}
    }else if(e.depth_ceiling!==o.configuration.limits.maxCallDepth)return false;
    const waiting=resourceFrontier&&!issuedResource||Object.values(children).some(child=>!child.completed)||workflowGates&&o.selected.gates.some((g:Row)=>g.state==='waiting');
    if(!terminal&&!hasParallelControls(definition)&&(e.state!==(waiting?'waiting':'running')))return false;
    const context:ScriptOwnerContext={workflowGates,foreignTreePrefix:!!seeds?.get(o.executionId)&&o.audit.some((a:Row)=>a.kind==='foreign_tree_selected_prefix'),resourceFrontier,...(issuedResource?{issuedResource:true,issuedOwnerTree:true}:{}),terminal,terminalState:terminal?e.state:undefined,waiting,parent,descendantTraversals:direct.reduce((n,ch)=>n+ch.selected.execution[0].traversals,0),descendantLoops:direct.reduce((n,ch)=>n+ch.selected.execution[0].loop_iterations,0),children,restoredTerminal:terminal&&seeds?.get(o.executionId)?.selected.execution?.[0]?.state===e.state};
    if(!replayScriptCut(db,o.executionId,o.selected,definition,o.configuration,o.audit,checkpoint(o),seeds?.get(o.executionId),context,o.hostDependencies,evidence?{owner:actual,audit:fullAudit!,tree:true,validatedSeed:!!seeds?.get(o.executionId)}:undefined))return false;
  }
  return true;
}
function compose(db:Database.Database,c:Row,encoding=false,data?:BranchPortableExecutionTree,work={remaining:128,active:new Set<string>(),cache:new Map<string,Row>()},depth=0,latest=false):Row[]|undefined {
  try {
    const frames:{c:Row;seeds?:Map<string,{selected:Selected;idMap:Record<string,string>;requestMap?:Record<string,string>}>;ref?:Row}[]=[],seen=new Set<string>();
    const base:Row[]=[],evidence=data?new Map(portableTreeOwners(data).map(o=>[o.sourceExecutionId,o])):undefined;
    let current=c;
    for(;;){
      if(depth+frames.length>16||current.schema!==TREE_SCHEMA||seen.has(current.rootExecutionId))return;seen.add(current.rootExecutionId);
      const frame:typeof frames[number]={c:current};frames.push(frame);
      const root=current.owners.find((o:Row)=>o.executionId===current.rootExecutionId);if(!root)return;
      if(root.audit.some((a:Row)=>a.kind==='foreign_tree_selected_prefix')){
        const proof=foreignTreeSeeds(db,current,data,work,depth+frames.length-1);if(!proof)return;
        frame.seeds=proof.seeds;frame.ref=proof.reference;
        for(const previous of proof.provenance)base.push(previous);
        break;
      }
      const origins=root.audit.filter((a:Row)=>a.kind==='tree_historical_rewind');
      if(!origins.length){if(current.owners.some((o:Row)=>o.audit.some((a:Row)=>['tree_historical_rewind','tree_restored_prefix'].includes(a.kind))))return;break;}
      if(origins.length!==1)return;
      const originEvidence=JSON.parse(origins[0].evidence_json),stored=read(db,originEvidence.lineageId,current.rootExecutionId,evidence);if(!stored)return;
      const line=stored.value,source=read(db,line.checkpointId,line.sourceExecutionId,evidence);
      if(!source||line.schema!=='ponderosa.branch.tree-rewind-lineage.v1'||line.executionId!==current.rootExecutionId||source.hash!==line.checkpointHash
        ||line.commandHash!==payloadHash({executionId:line.sourceExecutionId,checkpointId:line.checkpointId,expectedHash:line.checkpointHash})||typeof line.commandKey!=='string')return;
      const snapshot=source.value,old=snapshot.continuation;
      if(snapshot.schema!=='branch-unit-selected.v2'||snapshot.restore_supported!==true||old?.schema!==TREE_SCHEMA||!treeSnapshotMetadata(snapshot,old)||old.rootExecutionId!==line.sourceExecutionId)return;
      if(data&&(line.coordination||line.graphReviewHash||old.owners.some((o:Row)=>o.selected.gates.some((g:Row)=>g.purpose!=='approval')||!evidence!.get(o.executionId)?.facts.some(f=>f.kind==='acceptance'))))return;
      if(!treeCoordinationLineageSupported(db,line,snapshot))return;
      if(data&&(!portableScriptTreeSupported(db,data,line.sourceExecutionId,snapshot,work,depth+1)||!portableScriptTreeSupported(db,data,line.sourceExecutionId,undefined,work,depth+1)))return;
      const commandKey=`tree-historical-rewind:${payloadHash(line.commandKey)}`,commandFact=evidence?.get(line.sourceExecutionId)?.facts.find(f=>f.kind==='command'&&f.key===commandKey);
      const receipt=evidence?commandFact?JSON.parse(commandFact.json):undefined:db.prepare('SELECT command_key,input_hash,result_json,created_at FROM branch_commands WHERE execution_id=? AND command_key=?').get(line.sourceExecutionId,commandKey) as Row|undefined;
      if(!receipt||receipt.command_key!==commandKey||typeof receipt.created_at!=='string'||!receipt.created_at||receipt.input_hash!==line.commandHash||receipt.result_json!==stableJson({executionId:current.rootExecutionId,lineageId:originEvidence.lineageId}))return;
      const map=line.idMap;
      if(!treeIdMapSupported(old.owners,map,old.rootExecutionId,current.rootExecutionId))return;
      const seeds=new Map<string,{selected:Selected;idMap:Record<string,string>;requestMap?:Record<string,string>}>();
      for(const previous of old.owners){
        const target=current.owners.find((o:Row)=>o.executionId===map[previous.executionId]);if(!target)return;
        if(['versionId','versionHash','bindingRevisionId','bindingHash'].some(key=>target[key]!==previous[key])||stableJson(target.configuration)!==stableJson(previous.configuration))return;
        const ce=target.selected.execution[0],pe=previous.selected.execution[0];
        if(ce.parent_execution_id!==(pe.parent_execution_id?map[pe.parent_execution_id]:null)||ce.parent_attempt_id!==(pe.parent_attempt_id?map[pe.parent_attempt_id]:null)||ce.input_text!==pe.input_text)return;
        const origin=target.audit.filter((a:Row)=>a.kind==='tree_historical_rewind'),prefix=target.audit.filter((a:Row)=>a.kind==='tree_restored_prefix');
        if(origin.length!==1||prefix.length!==1||target.audit[0]?.kind!=='trigger_accepted'||target.audit[1]!==prefix[0]||target.audit[2]!==origin[0]||prefix[0].transition_key!=='tree-restored-prefix'||origin[0].transition_key!=='tree-rewind-origin')return;
        const value=JSON.parse(origin[0].evidence_json),expected={sourceRootId:line.sourceExecutionId,sourceExecutionId:previous.executionId,checkpointId:line.checkpointId,checkpointHash:line.checkpointHash,commandKey:line.commandKey,lineageId:originEvidence.lineageId,...(previous.executionId!==old.rootExecutionId?{childLineageId:value.childLineageId}:{})};
        if(stableJson(value)!==stableJson(expected)||prefix[0].evidence_json!==stableJson(expected))return;
        if(previous.executionId!==old.rootExecutionId){const child=read(db,value.childLineageId,target.executionId,evidence);if(!child||stableJson(child.value)!==stableJson(childTreeLineage(line,originEvidence.lineageId,previous.executionId,target.executionId)))return;}
        seeds.set(target.executionId,{selected:previous.selected,idMap:map,requestMap:line.coordination?.requestMap});
      }
      for(const o of current.owners)if(!seeds.has(o.executionId)&&o.audit.some((a:Row)=>['tree_historical_rewind','tree_restored_prefix'].includes(a.kind)))return;
      frame.seeds=seeds;frame.ref={executionId:current.rootExecutionId,sourceExecutionId:line.sourceExecutionId,lineageId:originEvidence.lineageId,lineageHash:stored.hash,checkpointId:line.checkpointId,checkpointHash:line.checkpointHash};
      if(data){
        for(const o of current.owners){
          const retained=evidence!.get(o.executionId);if(!retained)return;
          const origin=treeFact(retained,'provenance'),e=o.selected.execution[0],acceptance=retained.facts.find(f=>f.kind==='acceptance'),accepted=acceptance&&JSON.parse(acceptance.json),started=o.audit.filter((a:Row)=>a.kind==='workflow_started');
          if(!accepted||e.parent_execution_id&&stableJson(origin)!==stableJson({source:seeds.has(o.executionId)?'historical_child':'branch_call',parentExecutionId:e.parent_execution_id,parentAttemptId:e.parent_attempt_id})||!e.parent_execution_id&&origin.source!=='manual')return;
          // Terminal prefix children were accepted as data by the original local rewind, never admitted.
          const terminalPrefix=seeds.has(o.executionId)&&['completed','failed'].includes(seeds.get(o.executionId)!.selected.execution![0]!.state);
          if(terminalPrefix){if(started.length||accepted.admittedAt!==null||accepted.admissionJson!==null)return;}
          else if(typeof accepted.admittedAt!=='string'||!accepted.admittedAt||typeof accepted.admissionJson!=='string'||started.length!==1||started[0].evidence_json!==stableJson({admission:JSON.parse(accepted.admissionJson)}))return;
        }
        for(const previous of old.provenance)base.push(previous);break;
      }
      current=old;
    }
    const flat:Row[]=[...base];
    for(const frame of frames.reverse()){
      if(frame.ref)flat.push(frame.ref);
      if(!(encoding&&frame.c===c)&&stableJson(frame.c.provenance??[])!==stableJson(flat))return;
      if(!validateOwners(db,frame.c,frame.seeds,encoding&&frame.c===c,evidence,latest&&frame.c===c))return;
    }
    return flat;
  }catch{return;}
}
function treeSnapshotMetadata(snapshot:Row,c:Row):boolean {
  const root=c.owners?.find((o:Row)=>o.executionId===c.rootExecutionId);if(!root)return false;
  return stableJson(snapshot.selected)===stableJson(root.selected)&&snapshot.invocationId===root.invocation.id&&snapshot.mode===root.invocation.mode&&snapshot.closing===(root.invocation.state==='interrupted'||root.invocation.state==='terminal');
}
export function scriptTreeSnapshotSupported(db:Database.Database,id:string,snapshot:Row):boolean {
  try {const c=snapshot.continuation;return snapshot.schema==='branch-unit-selected.v2'&&snapshot.restore_supported===true&&c?.issuedResources!==true&&c?.schema===TREE_SCHEMA&&c.rootExecutionId===id&&treeSnapshotMetadata(snapshot,c)&&compose(db,c)!==undefined;}catch{return false;}
}

/** Evidence-only replay of issued owner cuts; ordinary tree restore never opts in. */
export function issuedScriptTreeSupported(db:Database.Database,c:Row):boolean {
  return c?.issuedResources===true&&compose(db,c)!==undefined;
}

/** Private fact readers feed the canonical owner-tree validator; no foreign rows are inserted. */
export function portableScriptTreeSupported(db:Database.Database,data:BranchPortableExecutionTree,rootId:string,snapshot?:Row,work:{remaining:number;active:Set<string>;cache:Map<string,Row>}={remaining:128,active:new Set(),cache:new Map()},depth=0):Row|undefined {
 try {
  if(depth>16)return;
  const key=data.sha256+':'+rootId+':'+(snapshot?payloadHash(snapshot):'latest');
  if(work.active.has(key))return;const cached=work.cache.get(key);if(cached)return cached;
  if(--work.remaining<0)return;work.active.add(key);
  const all=Object.values(data.branches).flatMap(b=>b.owners),byId=new Map(all.map(o=>[o.sourceExecutionId,o]));
  const fact=(o:BranchPortableRuntimeOwner,kind:string)=>JSON.parse(o.facts.find(f=>f.kind===kind)!.json);
  const root=byId.get(rootId);if(!root||fact(root,'frontier').execution[0].parent_execution_id)return;
  const related=all.filter(o=>{let e=fact(o,'frontier').execution[0];const seen=new Set<string>();for(;;){if(e.id===rootId)return true;if(!e.parent_execution_id||seen.has(e.id))return false;seen.add(e.id);const p=byId.get(e.parent_execution_id);if(!p)return false;e=fact(p,'frontier').execution[0];}});
  for(const o of related){
   const d=validateBranchDefinition(fact(o,'definition')),config=fact(o,'configuration'),s=fact(o,'frontier');
   const origin=fact(o,'provenance');if(o.sourceExecutionId===rootId?!['manual','foreign_tree_continuation'].includes(origin.source):!['branch_call','historical_child'].includes(origin.source))return;
   if(o.chatRefs.length||o.facts.some(f=>['custody','tree-import','import','continuation'].includes(f.kind))||config.requiredSecretRefs.length||!['sync','async','exit'].includes(config.configuration.checkpointMode??'async')||d.trigger.kind!=='manual'||d.steps.some((s:Row)=>!['script','branch_call','human_gate'].includes(s.kind))||!scriptDefinitionSupported(d,true)||
    s.resources.length||s.actions.length||s.bundles.length||s.attempts.some((a:Row)=>a.request_id||a.recovery_of_request_id||a.runtime_outcome_json||['leased','running','outcome_unknown'].includes(a.state))||o.facts.filter(f=>f.kind==='transition').some(f=>['historical_rewind','restored_prefix','foreign_selected_prefix'].includes(JSON.parse(f.json).kind)))return;
  }
  const latestOwners:Row[]=related.map(o=>{const s=fact(o,'frontier'),e=s.execution[0],config=fact(o,'configuration').configuration;return {executionId:o.sourceExecutionId,versionId:e.version_id,versionHash:payloadHash(fact(o,'definition')),bindingRevisionId:e.binding_revision_id,bindingHash:payloadHash(fact(o,'bindings')),configuration:config,selected:s,audit:o.facts.filter(f=>f.kind==='transition').map(f=>JSON.parse(f.json))};});
  // Read EXIT invocation metadata from a committed complete tree, never synthesize it.
  if(!snapshot&&latestOwners.some(o=>o.configuration.checkpointMode==='exit')){
   const savedTrees=root.facts.filter(f=>f.kind==='checkpoint'&&f.sha256===payloadHash(JSON.parse(f.json))&&stableJson(JSON.parse(f.json))===f.json).map(f=>JSON.parse(f.json)).filter(saved=>saved.schema==='branch-unit-selected.v2'&&saved.restore_supported===true&&saved.continuation?.schema===TREE_SCHEMA&&saved.continuation.rootExecutionId===rootId&&treeSnapshotMetadata(saved,saved.continuation));
   for(const o of latestOwners.filter(o=>o.configuration.checkpointMode==='exit')){
    const retained=savedTrees.flatMap(saved=>saved.continuation.owners).find((p:Row)=>p.executionId===o.executionId&&['versionId','versionHash','bindingRevisionId','bindingHash'].every(key=>p[key]===o[key])&&stableJson(p.configuration)===stableJson(o.configuration)&&stableJson(p.selected)===stableJson(o.selected)&&stableJson(p.audit)===stableJson(o.audit));
    if(!retained)return;o.invocation=retained.invocation;
   }
  }
  const c=snapshot?.continuation??{schema:TREE_SCHEMA,compatibility:TREE_COMPATIBILITY,rootExecutionId:rootId,owners:latestOwners,provenance:[]};
  if(c.schema!==TREE_SCHEMA||c.rootExecutionId!==rootId||c.issuedResources||snapshot&&(snapshot.schema!=='branch-unit-selected.v2'||snapshot.restore_supported!==true||!['sync','async','exit'].includes(snapshot.mode)||!treeSnapshotMetadata(snapshot,c)||!root.facts.some(f=>f.kind==='checkpoint'&&f.json===stableJson(snapshot)&&f.sha256===payloadHash(snapshot))))return;
  if(c.owners.some((o:Row)=>!related.some(p=>p.sourceExecutionId===o.executionId)||o.hostDependencies||o.selected.resources.length||o.selected.actions.length||o.selected.bundles.length||o.selected.attempts.some((a:Row)=>a.request_id||a.recovery_of_request_id||a.runtime_outcome_json||['leased','running','outcome_unknown'].includes(a.state))))return;
  const provenance=compose(db,c,!snapshot,data,work,depth,!snapshot);if(!provenance)return;
  if(!snapshot)c.provenance=provenance;
  work.active.delete(key);work.cache.set(key,c);return c;
 }catch{return;}
}

/** One root receipt accounts for every restored owner; later children prove ordinary Call admission. */
function foreignTreeSeeds(db:Database.Database,c:Row,data?:BranchPortableExecutionTree,work={remaining:128,active:new Set<string>(),cache:new Map<string,Row>()},depth=0):Row|undefined {
 try {
  const root=c.owners.find((o:Row)=>o.executionId===c.rootExecutionId),prefixes=root?.audit.filter((a:Row)=>a.kind==='foreign_tree_selected_prefix');
  if(!prefixes?.length){if(c.owners.some((o:Row)=>o.audit.some((a:Row)=>a.kind==='foreign_tree_selected_prefix')))return;return {provenance:[]};}
  if(depth>=16||prefixes.length!==1)return;
  const byId=new Map((data?portableTreeOwners(data):[]).map(o=>[o.sourceExecutionId,o]));
  const get=(id:string,kind:string)=>{const o=byId.get(id);return o?treeFact(o,kind):undefined;};
  const execution=(id:string)=>data?{...get(id,'frontier')?.execution[0],admitted_at:get(id,'acceptance')?.admittedAt,admission_json:get(id,'acceptance')?.admissionJson}:db.prepare('SELECT * FROM branch_executions WHERE id=?').get(id) as Row|undefined;
  const origin=data?get(c.rootExecutionId,'provenance'):JSON.parse(execution(c.rootExecutionId)!.provenance_json);
  if(origin.source!=='foreign_tree_continuation')return;
  const retained=data?get(c.rootExecutionId,'tree-continuation'):captureForeignTreeGeneration(db,c.rootExecutionId,origin);
  if(!retained||stableJson(Object.keys(retained).sort())!==stableJson(['command','held','receipt']))return;
  const {receipt:r,held,command}=retained,review=r.review,{reviewSha256,...value}=review;
  const source=validateBranchExecutionTree(held.data,depth+1),resolved=heldTreeSource(source,review.selection.sourceExecutionId);
  const owner=portableTreeOwners(source).find(o=>o.sourceExecutionId===review.selection.sourceExecutionId),sourceRoot=portableTreeOwners(resolved.data).find(o=>o.sourceExecutionId===resolved.rootId);
  const cp=sourceRoot?.facts.find(f=>f.kind==='checkpoint'&&f.key===review.selection.checkpointKey&&f.sha256===review.selection.checkpointSha256);
  const budget=(b:Row)=>Object.fromEntries(Object.entries(b).filter(([k])=>k!=='observedAt'));
  if(!owner||!cp||r.schema!=='ponderosa.branch-foreign-continuation.v1'||r.executionId!==c.rootExecutionId||r.importedExecutionId!==origin.importedExecutionId||r.commandKey!==origin.commandKey||reviewSha256!==origin.reviewSha256||
   payloadHash({...value,budget:budget(value.budget),tree:{...value.tree,branches:value.tree.branches.map((b:Row)=>({...b,budget:budget(b.budget)}))}})!==reviewSha256||
   r.inputSha256!==payloadHash({...review.selection,commandKey:r.commandKey,reviewSha256,acceptCurrentAuthority:true})||stableJson(review.checkpoint)!==cp.json||review.manifestSha256!==source.sha256||review.ownerSha256!==owner.sha256||stableJson(review.generationChain??resolved.chain)!==stableJson(resolved.chain)||stableJson(review.nativeMaps)!==stableJson(held.receipt)||held.receipt.executionMap[review.selection.sourceExecutionId]!==r.importedExecutionId||
   command.command_key!==`foreign-continuation:${payloadHash(r.commandKey)}`||command.input_hash!==payloadHash(r)||command.result_json!==stableJson(r))return;
  if(data){
   const imported=byId.get(r.importedExecutionId),savedCommand=imported?.facts.find(f=>f.kind==='command'&&f.key===command.command_key);
   if(!imported||stableJson(treeFact(imported,'tree-import'))!==stableJson(held)||!savedCommand||stableJson(JSON.parse(savedCommand.json))!==stableJson(command))return;
   // Validate the held generation independently from its admitted successor.
   heldTreeSource(data,r.importedExecutionId);
  }else if(stableJson(readHeldTreeForContinuation(db,held.receipt.planId,held.receipt.rootBranchId))!==stableJson(held))return;
  const old=portableScriptTreeSupported(db,resolved.data,resolved.rootId,JSON.parse(cp.json),work,depth+1);
  if(!old||!portableScriptTreeSupported(db,resolved.data,resolved.rootId,undefined,work,depth+1)||!treeIdMapSupported(old.owners,r.idMap,old.rootExecutionId,c.rootExecutionId)||!r.treeOwners||stableJson(Object.keys(r.treeOwners).sort())!==stableJson(old.owners.map((o:Row)=>o.executionId).sort())||stableJson(r.admission)!==stableJson(r.treeOwners[old.rootExecutionId]?.admission))return;
  const seeds=new Map<string,{selected:Selected;idMap:Record<string,string>}>();
  for(const previous of old.owners){
   const target=c.owners.find((o:Row)=>o.executionId===r.idMap[previous.executionId]),e=target&&execution(target.executionId),pe=previous.selected.execution[0],mapped=r.treeOwners[previous.executionId],choice=review.tree.owners.find((o:Row)=>o.sourceExecutionId===previous.executionId),pins=review.tree.branches.find((b:Row)=>b.branchId===choice?.branchId);
   const sourceOwner=portableTreeOwners(resolved.data).find(o=>o.sourceExecutionId===previous.executionId)!;
   if(!target||!e||!pins||mapped.executionId!==target.executionId||held.receipt.frontiers[resolved.aliases[previous.executionId]!]?.disposition!=='recreated_held'||pins.branchId!==held.receipt.branchMap[resolved.branches[sourceOwner.sourceBranchId]!]||!e.admitted_at||e.admission_json!==stableJson(mapped.admission)||e.branch_id!==pins.branchId||e.version_id!==pins.versionId||e.binding_revision_id!==pins.bindingRevisionId||target.versionHash!==payloadHash(pins.definition)||target.bindingHash!==payloadHash(pins.bindings)||stableJson(target.configuration)!==stableJson(pins.configuration)||payloadHash(pins.definition)!==previous.versionHash||stableJson(target.configuration)!==stableJson(previous.configuration)||e.input_text!==pe.input_text||e.parent_execution_id!==(pe.parent_execution_id?r.idMap[pe.parent_execution_id]:null)||e.parent_attempt_id!==(pe.parent_attempt_id?r.idMap[pe.parent_attempt_id]:null)||e.call_depth!==pe.call_depth||e.depth_ceiling!==pe.depth_ceiling||e.recovery_traversals!==pe.recovery_traversals||['completed','failed'].includes(pe.state)&&(target.selected.execution[0].state!==pe.state||target.selected.execution[0].output_text!==pe.output_text))return;
   const targetOrigin=data?get(e.id,'provenance'):JSON.parse(e.provenance_json),parent=e.parent_execution_id,attempt=e.parent_attempt_id;
   if(stableJson(targetOrigin)!==stableJson(parent?{source:'branch_call',parentExecutionId:parent,parentAttemptId:attempt}:origin)||e.admission_source!==(parent?'call':'manual')||e.input_hash!==(attempt?payloadHash({parentAttempt:attempt,input:e.input_text}):payloadHash({input:e.input_text,source:'manual'}))||e.occurrence_key!==(attempt?`call:${attempt}`:`foreign-continuation:${r.importedExecutionId}:${payloadHash(r.commandKey)}`))return;
   const prefix=target.audit.filter((a:Row)=>a.kind==='foreign_tree_selected_prefix');
   if(prefix.length!==1||target.audit[0]?.kind!=='trigger_accepted'||target.audit[1]!==prefix[0]||target.audit[2]?.kind!=='workflow_started'||prefix[0].transition_key!=='foreign-tree-prefix'||prefix[0].evidence_json!==stableJson({importedExecutionId:r.importedExecutionId,sourceExecutionId:previous.executionId,reviewSha256})||target.audit[2].evidence_json!==stableJson({admission:mapped.admission}))return;
   if(parent){const p=c.owners.find((o:Row)=>o.executionId===parent),event=p?.audit.find((a:Row)=>a.transition_key===`call:${attempt}`);if(event?.kind!=='child_admitted'||event.evidence_json!==stableJson({attemptId:attempt,childExecutionId:e.id,definitionId:e.version_id}))return;}
   const originalBindings=treeFact(sourceOwner,'bindings').branches??{};
   if(stableJson(pins.bindings.branches??{})!==stableJson(Object.fromEntries(Object.entries(originalBindings).map(([ref,b])=>[ref,held.receipt.branchMap[resolved.branches[b as string]!]]))))return;
   seeds.set(e.id,{selected:previous.selected,idMap:r.idMap});
  }
  for(const o of c.owners){
   const e=execution(o.executionId),pins=review.tree.branches.find((b:Row)=>b.branchId===e?.branch_id);
   if(!e||!pins||!['sync','async','exit'].includes(o.configuration.checkpointMode??'async')||o.hostDependencies||o.selected.resources.length||o.selected.actions.length||o.selected.bundles.length||o.selected.attempts.some((a:Row)=>a.request_id||a.runtime_outcome_json||a.recovery_of_request_id)||o.versionId!==pins.versionId||o.bindingRevisionId!==pins.bindingRevisionId||o.versionHash!==payloadHash(pins.definition)||o.bindingHash!==payloadHash(pins.bindings)||stableJson(o.configuration)!==stableJson(pins.configuration))return;
   if(!seeds.has(o.executionId)){
    const origin=data?get(o.executionId,'provenance'):JSON.parse(e.provenance_json);
    if(!e.parent_execution_id||!e.admitted_at||!e.admission_json||stableJson(origin)!==stableJson({source:'branch_call',parentExecutionId:e.parent_execution_id,parentAttemptId:e.parent_attempt_id})||o.audit.some((a:Row)=>a.kind==='foreign_tree_selected_prefix')||o.audit.find((a:Row)=>a.kind==='workflow_started')?.evidence_json!==stableJson({admission:JSON.parse(e.admission_json)}))return;
   }
  }
  return {seeds,provenance:old.provenance,reference:{executionId:c.rootExecutionId,foreignReviewSha256:reviewSha256,manifestSha256:source.sha256,checkpointSha256:review.selection.checkpointSha256}};
 }catch{return;}
}
