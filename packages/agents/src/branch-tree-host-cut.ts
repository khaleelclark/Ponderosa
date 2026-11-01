import {verifyBranchHostCut,type BranchHostCut} from './branch-host-cut.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
type Row=Record<string,any>;
export type RetainedHostOwner={executionId:string;branchId:string;cut:BranchHostCut};

/** Resolve only sealed server-retained owner cuts. Shared graph facts must agree byte for byte. */
export function retainedBranchHostGraph(snapshot:Row,executionId:string):{cut:BranchHostCut;owners:RetainedHostOwner[]} {
 const c=snapshot.continuation;
 if(c?.schema!=='ponderosa.branch.script-tree-continuation.v1'){
  const cut=snapshot.hostDependencies as BranchHostCut;
  if(!cut||!verifyBranchHostCut(cut,executionId)||!cut.coverage.complete)throw Error('Retained host cut integrity failure');
  return {cut,owners:[{executionId,branchId:snapshot.selected.execution[0].branch_id,cut}]};
 }
 if(c.rootExecutionId!==executionId||!Array.isArray(c.owners)||!c.owners.length||new Set(c.owners.map((o:Row)=>o.executionId)).size!==c.owners.length)throw Error('Tree host owner inventory differs');
 const root=c.owners.find((o:Row)=>o.executionId===executionId);
 if(!root||stableJson(root.selected)!==stableJson(snapshot.selected))throw Error('Tree host root inventory differs');
 const owners:RetainedHostOwner[]=[];
 for(const o of c.owners){
  const e=o.selected.execution[0],issued=o.selected.attempts.filter((a:Row)=>a.request_id||a.recovery_of_request_id),cut=o.hostDependencies as BranchHostCut|undefined;
  if(e.id!==o.executionId||e.version_id!==o.versionId||e.binding_revision_id!==o.bindingRevisionId)throw Error('Tree host owner pins differ');
  const visited=new Set<string>();let current=o;
  while(current.executionId!==executionId){
   if(visited.has(current.executionId))throw Error('Tree host ancestry cycle');visited.add(current.executionId);
   const ce=current.selected.execution[0],parent=c.owners.find((p:Row)=>p.executionId===ce.parent_execution_id);
   if(!parent||!parent.selected.attempts.some((a:Row)=>a.id===ce.parent_attempt_id))throw Error('Tree host ancestry differs');current=parent;
  }
  if(!issued.length){if(cut||o.hostDependenciesHash)throw Error('Tree host cut has no owned Request');continue;}
  if(!cut||o.hostDependenciesHash!==payloadHash(cut)||!verifyBranchHostCut(cut,o.executionId)||!cut.coverage.complete
    ||cut.bindingPin.revisionId!==o.bindingRevisionId||cut.bindingPin.sha256!==o.bindingHash||cut.bindingPin.requiredSecretRefs.length
    ||o.selected.resources.length||cut.resources.length||cut.roots.length!==issued.length
    ||issued.some((a:Row)=>!cut.roots.some(r=>r.attemptId===a.id&&r.requestId===a.request_id&&r.recoveryOfRequestId===a.recovery_of_request_id)))throw Error('Tree per-owner host cut differs');
  owners.push({executionId:o.executionId,branchId:e.branch_id,cut});
 }
 if(!owners.length)throw Error('Tree contains no issued host graph');
 if(stableJson(snapshot.hostDependencies??null)!==stableJson(root.hostDependencies??null))throw Error('Tree root host cut differs');
 const base=owners[0]!.cut;
 const merge=(key:keyof BranchHostCut,identity:(row:Row)=>string)=>{
  const rows=new Map<string,Row>();
  for(const o of owners)for(const record of o.cut[key] as Row[]){const id=identity(record.row),prior=rows.get(id);if(prior&&stableJson(prior)!==stableJson(record))throw Error(`Shared tree ${key} fact differs`);rows.set(id,record);}
  return [...rows].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,v])=>v);
 };
 const roots=owners.flatMap(o=>o.cut.roots);
 if(new Set(roots.map(r=>r.attemptId)).size!==roots.length||new Set(roots.map(r=>r.requestId)).size!==roots.length)throw Error('Tree Request roots alias');
 const versions=new Map<string,BranchHostCut['coverage']['requestVersions'][number]>();
 for(const o of owners)for(const v of o.cut.coverage.requestVersions){if(versions.has(v.requestId)&&stableJson(versions.get(v.requestId))!==stableJson(v))throw Error('Shared tree Request version differs');versions.set(v.requestId,v);}
 const cut={...base,executionId,roots,coverage:{complete:true,missingReferences:[],requestVersions:[...versions.values()].sort((a,b)=>a.requestId<b.requestId?-1:a.requestId>b.requestId?1:0)},
  requests:merge('requests',r=>r.id),updates:merge('updates',r=>r.id),lateResults:merge('lateResults',r=>r.id),joins:merge('joins',r=>r.id),
  members:merge('members',r=>stableJson([r.join_id,r.request_id])),suspensions:merge('suspensions',r=>stableJson([r.question_update_id,r.dependency_kind,r.dependency_id])),
  communications:merge('communications',r=>r.id),joinOutcomes:merge('joinOutcomes',r=>r.id),artifactRefs:merge('artifactRefs',r=>r.id),
  resources:[],resourceMembers:[],resourceContexts:[],resourceReceipts:[],bindingPin:{revisionId:root.bindingRevisionId,sha256:root.bindingHash,requiredSecretRefs:[]}} as BranchHostCut;
 if(!verifyBranchHostCut(cut,executionId)||Buffer.byteLength(stableJson(cut))>8_000_000)throw Error('Tree host graph exceeds retained integrity bound');
 return {cut,owners};
}
