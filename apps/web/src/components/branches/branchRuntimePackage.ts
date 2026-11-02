import type {InstalledBranchPackage,BranchInstallationPreviewDto,BranchBindings,BranchPortableRuntimeData,BranchPortableExecutionTree,BranchRuntimeDataReadback,BranchRuntimeTreeReadback} from '@ponderosa/core';
export type RuntimePackageData=BranchPortableRuntimeData|BranchPortableExecutionTree;
export type RuntimePackageReadback=BranchRuntimeDataReadback|BranchRuntimeTreeReadback;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown):v is string=>typeof v==='string'&&!!v;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const canonical=(v:unknown):string=>JSON.stringify(v,(_key,value)=>object(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
export const runtimeBranches=(data:RuntimePackageData):BranchPortableRuntimeData[]=>data.schema==='ponderosa.branch-runtime-tree.v1'?Object.values(data.branches):[data];
export function parseTreeBindings(pkg:InstalledBranchPackage,bytes:Record<string,string>):Record<string,BranchBindings>{
 const nodes=pkg.definitionTree?.nodes??[];
 if(Object.keys(bytes).length!==nodes.length)throw Error('Choose bindings for every source Branch');
 return Object.fromEntries(nodes.map(node=>{const value:unknown=JSON.parse(bytes[node.sourceBranchId]??'');if(!object(value)||!object(value.agents)||Object.keys(value.agents).length||value.branches&&(!object(value.branches)||Object.keys(value.branches).length)||!object(value.directories)||!Object.values(value.directories).every(text)||value.engines&&(!object(value.engines)||!Object.values(value.engines).every(text)))throw Error('Each Branch needs directories/Engines; Agent and called-Branch bindings must be empty');return [node.sourceBranchId,value as unknown as BranchBindings];}));
}
export function runtimePackageReviewError(pkg:InstalledBranchPackage,preview:BranchInstallationPreviewDto,branchId?:string,bindings?:Record<string,BranchBindings>):string {
 const d=pkg.executionTree??pkg.runtimeData,r=preview.runtimeDataReview,t=pkg.definitionTree,tr=preview.definitionTreeReview;
 if((t||d)&&(branchId||pkg.mode!=='full'))return 'Tree/runtime data requires a new full installation · existing workflow cannot be overwritten';
 if(t){
  if(!tr||!hash(tr.reviewSha256)||tr.manifestSha256!==t.sha256||tr.branches!==t.nodes.length||!bindings||!preview.fullImportReview)return 'Exact definition/destination/full-context review unavailable';
  const normalized=Object.fromEntries(t.nodes.map(n=>[n.sourceBranchId,{...bindings[n.sourceBranchId],agents:{},branches:n.dependencies}]));
  if(canonical(tr.bindings)!==canonical(normalized))return 'Every destination binding must match the original review';
  const ops=preview.operations.filter(op=>op.kind==='install-definition-tree');
  const after=ops[0]?.after;
  if(ops.length!==1||!object(after)||canonical(after.inventory)!==canonical(t)||canonical(after.bindings)!==canonical(tr.bindings)||canonical(after.chatOwners)!==canonical(Object.fromEntries(t.nodes.flatMap(n=>n.chatRefs.map(ref=>[ref,n.sourceBranchId])))))return 'Complete definition tree/Chat ownership review unavailable';
 }else if(tr)return 'Unexpected definition tree review';
 if(!d)return r?'Unexpected runtime data review':'';
 const owners=runtimeBranches(d).flatMap(b=>b.owners);
 if(!r||!hash(r.manifestSha256)||r.manifestSha256!==d.sha256||r.disposition!=='held'||r.currentAuthority!==false||r.owners!==owners.length||r.facts!==owners.reduce((n,o)=>n+o.facts.length,0)||!preview.fullImportReview)return 'Exact full runtime review unavailable · confirmation held';
 const operations=preview.operations.filter(op=>op.kind===(pkg.executionTree?'retain-private-runtime-tree':'retain-private-runtime-data'));
 const after=operations[0]?.after;
 return operations.length===1&&canonical(pkg.executionTree&&object(after)?after.data:after)===canonical(d)?'':'Complete private runtime facts unavailable · confirmation held';
}
function freshMap(value:unknown,original:Record<string,unknown>):boolean{return object(value)&&canonical(Object.keys(value).sort())===canonical(Object.keys(original).sort())&&Object.values(value).every(text)&&new Set(Object.values(value)).size===Object.keys(value).length&&!Object.values(value).some(id=>Object.hasOwn(original,id as string));}
export function runtimeReadbackMatches(v:unknown,planId:string,branchId:string,manifestSha256:string,expected?:RuntimePackageData,expectedReceipt?:unknown):v is RuntimePackageReadback {
 if(!object(v)||!object(v.receipt)||!object(v.data))return false;
 const r=v.receipt,d=v.data as unknown as RuntimePackageData,tree=d.schema==='ponderosa.branch-runtime-tree.v1';
 if(!['ponderosa.branch-runtime-tree.v1','ponderosa.branch-runtime-data.v1'].includes(d.schema)||r.planId!==planId||!hash(manifestSha256)||r.manifestSha256!==manifestSha256||d.sha256!==manifestSha256||r.currentAuthority!==false||r.dispatched!==false||expected&&canonical(d)!==canonical(expected)||expectedReceipt&&canonical(r)!==canonical(expectedReceipt))return false;
 if(tree){if(r.schema!=='ponderosa.branch-runtime-tree-import.v1'||r.rootBranchId!==branchId||r.held!==true||!object(d.branches)||!Object.keys(d.branches).length||!freshMap(r.branchMap,d.branches)||!object(r.branchMap)||r.branchMap[d.rootSourceBranchId]!==branchId)return false;}
 else if(r.schema!=='ponderosa.branch-runtime-import.v1'||r.branchId!==branchId||r.disposition!=='held'||r.workflowEnabled!==false||r.credentials!=='reenter'||r.nativeState!=='not_adopted'||!text(r.createdAt)||!Number.isFinite(Date.parse(r.createdAt)))return false;
 const branches=runtimeBranches(d);
 if(!branches.every(b=>object(b)&&b.schema==='ponderosa.branch-runtime-data.v1'&&text(b.sourceBranchId)&&Array.isArray(b.owners)&&object(b.identities)&&object(b.identities.chats)&&object(b.identities.agents)&&b.owners.every(o=>object(o)&&text(o.sourceExecutionId)&&o.sourceBranchId===b.sourceBranchId&&Array.isArray(o.chatRefs)&&Array.isArray(o.facts)&&o.facts.every(f=>object(f)&&text(f.kind)&&text(f.key)&&typeof f.json==='string'&&hash(f.sha256)))))return false;
 if(tree&&Object.entries(d.branches).some(([source,b])=>source!==b.sourceBranchId))return false;
 const sources=branches.flatMap(b=>b.owners.map(o=>o.sourceExecutionId));if(new Set(sources).size!==sources.length)return false;
 if(!object(r.frontiers)||canonical(Object.keys(r.frontiers).sort())!==canonical([...sources].sort()))return false;
 const chats=Object.assign(Object.create(null),...branches.map(b=>b.identities.chats)),agents=Object.assign(Object.create(null),...branches.map(b=>b.identities.agents));
 if(!freshMap(r.executionMap,Object.fromEntries(sources.map(id=>[id,true])))||!freshMap(r.chatMap,chats)||!freshMap(r.agentMap,agents))return false;
 if(tree&&(!object(r.ownerPins)||canonical(Object.keys(r.ownerPins).sort())!==canonical([...sources].sort())||!Object.values(r.ownerPins).every(p=>object(p)&&text(p.versionId)&&text(p.bindingRevisionId))||!object(r.reservedFrontiers)||canonical(Object.keys(r.reservedFrontiers).sort())!==canonical([...sources].sort())||!Object.values(r.reservedFrontiers).every(p=>object(p)&&Object.values(p).every(text))))return false;
 return Object.values(r.frontiers).every(f=>object(f)&&['recreated_held','evidence_only'].includes(String(f.disposition))&&object(f.idMap)&&Object.values(f.idMap).every(text)&&new Set(Object.values(f.idMap)).size===Object.keys(f.idMap).length&&(f.disposition!=='evidence_only'||text(f.reason)));
}
export function definitionReceiptMatches(v:unknown,pkg:InstalledBranchPackage,rootBranchId:string,reviewed?:Record<string,BranchBindings>):boolean{
 const t=pkg.definitionTree;if(!t||!object(v)||v.manifestSha256!==t.sha256||v.currentAuthority!==false||v.dispatched!==false||v.workflowEnabled!==false||!freshMap(v.branchMap,Object.fromEntries(t.nodes.map(n=>[n.sourceBranchId,true])))||!object(v.branchMap)||v.branchMap[t.rootSourceBranchId]!==rootBranchId||!object(v.nodes)||canonical(Object.keys(v.nodes).sort())!==canonical(t.nodes.map(n=>n.sourceBranchId).sort()))return false;
 const chats=Object.fromEntries(pkg.chats.map(c=>[c.ref,true])),agents=Object.fromEntries(pkg.chats.flatMap(c=>c.agents.map(a=>[JSON.stringify([c.ref,a.ref]),true])));
 if(!freshMap(v.chatMap,chats)||!freshMap(v.agentMap,agents)||!object(v.agentMap)||v.executionOwners!==(pkg.executionTree?runtimeBranches(pkg.executionTree).reduce((count,b)=>count+b.owners.length,0):0))return false;
 return t.nodes.every(n=>{const r=(v.nodes as Record<string,unknown>)[n.sourceBranchId],destination=reviewed?.[n.sourceBranchId];
  if(!object(r)||r.branchId!==(v.branchMap as Record<string,unknown>)[n.sourceBranchId]||r.sourceVersionId!==n.sourceVersionId||r.sourceBindingRevisionId!==n.sourceBindingRevisionId||!text(r.versionId)||!text(r.bindingRevisionId)||r.packageId!==n.packageId||canonical(r.definition)!==canonical(n.definition)||!object(r.configuration)||canonical({secretBindings:{},...r.configuration})!==canonical({secretBindings:{},...n.configuration})||canonical(r.chatRefs)!==canonical(n.chatRefs))return false;
  if(!destination)return !reviewed;
  const resolved={...destination,agents:Object.fromEntries(Object.entries(n.agentBindings).map(([ref,target])=>[ref,(v.agentMap as Record<string,unknown>)[JSON.stringify([target.chatRef,target.agentRef])]])),branches:Object.fromEntries(Object.entries(n.dependencies).map(([ref,source])=>[ref,(v.branchMap as Record<string,unknown>)[source]])),engines:destination.engines??n.engines,triggers:Object.fromEntries(Object.entries(destination.triggers??n.triggers??{}).map(([ref,trigger])=>[ref,{...trigger,enabled:false}]))};
  return canonical(r.bindings)===canonical(resolved);
 });
}
export type SavedPackageCommand={package:InstalledBranchPackage;branchId?:string;preview:BranchInstallationPreviewDto;treeBytes:Record<string,string>;body:{acknowledgeFullImport:boolean;acknowledgeMemoryUpdate:boolean;acknowledgeRuntimeDataSha256?:string;acknowledgeDefinitionTreeSha256?:string}};
export function savedPackageCommandMatches(value:unknown,pkg:InstalledBranchPackage,branchId?:string):value is SavedPackageCommand{
 if(!object(value)||canonical(value.package)!==canonical(pkg)||value.branchId!==branchId||!object(value.preview)||!text(value.preview.id)||!object(value.treeBytes)||!Object.values(value.treeBytes).every(v=>typeof v==='string')||!object(value.body)||value.body.acknowledgeFullImport!==true)return false;
 try{const preview=value.preview as unknown as BranchInstallationPreviewDto;return !runtimePackageReviewError(pkg,preview,branchId,pkg.definitionTree?parseTreeBindings(pkg,value.treeBytes as Record<string,string>):undefined)&&(!preview.runtimeDataReview||value.body.acknowledgeRuntimeDataSha256===preview.runtimeDataReview.manifestSha256)&&(!preview.definitionTreeReview||value.body.acknowledgeDefinitionTreeSha256===preview.definitionTreeReview.reviewSha256)}catch{return false}
}
