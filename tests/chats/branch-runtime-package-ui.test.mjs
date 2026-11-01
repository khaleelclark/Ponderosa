// Deferred source fixtures. No execution or preparation authorized.
import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimePackageReviewError,runtimeReadbackMatches} from '../../apps/web/src/components/branches/branchRuntimePackage.ts';
const sha='a'.repeat(64),owner={sourceExecutionId:'source-execution',sourceBranchId:'source-branch',chatRefs:['chat-ref'],facts:[{kind:'frontier',key:'current',json:'{"execution":[{"traversals":2,"state":"waiting"}]}',sha256:'b'.repeat(64)}],sha256:'c'.repeat(64)};
const data={schema:'ponderosa.branch-runtime-data.v1',sourceBranchId:'source-branch',sha256:sha,identities:{chats:{'source-chat':'chat-ref'},agents:{'source-agent':{chatRef:'chat-ref',agentRef:'agent-ref'}}},owners:[owner]};
const pkg={mode:'full',runtimeData:data},preview={id:'plan',fullImportReview:{mode:'full',agents:[],warning:'private'},runtimeDataReview:{manifestSha256:sha,owners:1,facts:1,disposition:'held',currentAuthority:false},operations:[{kind:'retain-private-runtime-data',after:data}]};
const receipt={schema:'ponderosa.branch-runtime-import.v1',planId:'plan',branchId:'fresh-branch',manifestSha256:sha,disposition:'held',currentAuthority:false,dispatched:false,workflowEnabled:false,credentials:'reenter',nativeState:'not_adopted',createdAt:'2026-11-01T00:00:00Z',executionMap:{'source-execution':'fresh-execution'},chatMap:{'source-chat':'fresh-chat'},agentMap:{'source-agent':'fresh-agent'},frontiers:{'source-execution':{disposition:'recreated_held',idMap:{'old-path':'fresh-path'}}}};
test('new full installation requires exact complete all-private-fact review',()=>{
 assert.equal(runtimePackageReviewError(pkg,preview),'');assert.ok(runtimePackageReviewError(pkg,preview,'existing'));
 for(const patch of [{runtimeDataReview:undefined},{runtimeDataReview:{...preview.runtimeDataReview,manifestSha256:'d'.repeat(64)}},{runtimeDataReview:{...preview.runtimeDataReview,facts:0}},{runtimeDataReview:{...preview.runtimeDataReview,currentAuthority:true}},{operations:[]},{operations:[{kind:'retain-private-runtime-data',after:{...data,owners:[]}}]},{fullImportReview:undefined}])assert.ok(runtimePackageReviewError(pkg,{...preview,...patch}));
 assert.ok(runtimePackageReviewError({...pkg,mode:'template'},preview));
});
test('readback binds held receipt, all fresh owners and exact private data without import replay',()=>{
 const check=value=>runtimeReadbackMatches(value,'plan','fresh-branch',sha,data);
 assert.ok(check({receipt,data}));
 for(const patch of [{planId:'other'},{branchId:'other'},{manifestSha256:'d'.repeat(64)},{currentAuthority:true},{dispatched:true},{workflowEnabled:true},{nativeState:'adopted'},{executionMap:{}},{executionMap:{'source-execution':'source-execution'}},{chatMap:{'source-chat':'source-chat'}},{agentMap:{}},{frontiers:{}}])assert.equal(check({receipt:{...receipt,...patch},data}),false);
 assert.equal(check({receipt,data:{...data,owners:[{...owner,facts:[]}]}}),false);
 assert.ok(check({receipt:{...receipt,frontiers:{'source-execution':{disposition:'evidence_only',reason:'Unknown native effects',idMap:{}}}},data}));
 assert.equal(check({receipt:{...receipt,frontiers:{'source-execution':{disposition:'evidence_only',idMap:{}}}},data}),false);
});

import {parseTreeBindings,savedPackageCommandMatches,definitionReceiptMatches} from '../../apps/web/src/components/branches/branchRuntimePackage.ts';
const bindings={agents:{},directories:{workspace:'/reviewed/root'},engines:{default:'claude'},triggers:{}};
const node={sourceBranchId:'source-branch',sourceVersionId:'old-v',sourceBindingRevisionId:'old-b',packageId:'package',definition:{name:'Root'},configuration:{limits:{}},dependencies:{child:'template-branch'},chatRefs:['chat-ref']};
const child={...node,sourceBranchId:'template-branch',definition:{name:'Template'},dependencies:{},chatRefs:[]};
const definitionTree={rootSourceBranchId:'source-branch',sha256:'d'.repeat(64),packageSha256:'e'.repeat(64),nodes:[node,child]};
const empty={...data,sourceBranchId:'template-branch',identities:{chats:{},agents:{}},owners:[]};
const executionTree={schema:'ponderosa.branch-runtime-tree.v1',rootSourceBranchId:'source-branch',sha256:sha,branches:{'source-branch':data,'template-branch':empty}};
const treePkg={mode:'full',chats:[{ref:'chat-ref',agents:[]}],definitionTree,executionTree},treeBindings={'source-branch':bindings,'template-branch':{...bindings,directories:{workspace:'/reviewed/child'}}};
const reviewedBindings=Object.fromEntries(definitionTree.nodes.map(n=>[n.sourceBranchId,{...treeBindings[n.sourceBranchId],branches:n.dependencies}]));
const treePreview={...preview,definitionTreeReview:{manifestSha256:definitionTree.sha256,reviewSha256:'f'.repeat(64),branches:2,bindings:reviewedBindings},operations:[{kind:'install-definition-tree',after:{inventory:definitionTree,bindings:reviewedBindings,chatOwners:{'chat-ref':'source-branch'}}},{kind:'retain-private-runtime-tree',after:{data:executionTree,frontiers:receipt.frontiers}}]};
const treeReceipt={schema:'ponderosa.branch-runtime-tree-import.v1',planId:'plan',rootBranchId:'fresh-root',manifestSha256:sha,held:true,currentAuthority:false,dispatched:false,branchMap:{'source-branch':'fresh-root','template-branch':'fresh-child'},executionMap:receipt.executionMap,chatMap:receipt.chatMap,agentMap:receipt.agentMap,frontiers:receipt.frontiers,reservedFrontiers:{'source-execution':{'old-path':'fresh-path'}},ownerPins:{'source-execution':{versionId:'new-v',bindingRevisionId:'new-b'}}};
test('tree review binds exhaustive destinations, exact inventory/fact bytes and two independent digests',()=>{
 const bytes=Object.fromEntries(Object.entries(treeBindings).map(([k,v])=>[k,JSON.stringify(v)]));
 assert.deepEqual(parseTreeBindings(treePkg,bytes),treeBindings);assert.throws(()=>parseTreeBindings(treePkg,{'source-branch':bytes['source-branch']}));assert.throws(()=>parseTreeBindings(treePkg,{...bytes,'source-branch':JSON.stringify({...bindings,agents:{invented:'id'}})}));
 assert.equal(runtimePackageReviewError(treePkg,treePreview,undefined,treeBindings),'');
 assert.ok(runtimePackageReviewError(treePkg,treePreview,'existing',treeBindings));
 assert.ok(runtimePackageReviewError(treePkg,{...treePreview,definitionTreeReview:{...treePreview.definitionTreeReview,bindings:{}}},undefined,treeBindings));
 assert.ok(runtimePackageReviewError(treePkg,{...treePreview,operations:treePreview.operations.slice(0,1)},undefined,treeBindings));
 assert.ok(runtimePackageReviewError(treePkg,{...treePreview,runtimeDataReview:{...preview.runtimeDataReview,facts:0}},undefined,treeBindings));
 const command={package:treePkg,preview:treePreview,treeBytes:bytes,body:{acknowledgeFullImport:true,acknowledgeMemoryUpdate:false,acknowledgeRuntimeDataSha256:sha,acknowledgeDefinitionTreeSha256:'f'.repeat(64)}};
 assert.ok(savedPackageCommandMatches(command,treePkg));
 for(const body of [{...command.body,acknowledgeFullImport:false},{...command.body,acknowledgeDefinitionTreeSha256:definitionTree.sha256},{...command.body,acknowledgeRuntimeDataSha256:undefined}])assert.equal(savedPackageCommandMatches({...command,body},treePkg),false);
 assert.equal(savedPackageCommandMatches({...command,package:{...treePkg,parameters:{root:'rewritten'}}},treePkg),false);
 assert.equal(runtimePackageReviewError({...treePkg,executionTree:undefined},{...treePreview,runtimeDataReview:undefined,operations:treePreview.operations.slice(0,1)},undefined,treeBindings),'');
});
test('schema-discriminated tree readback retains empty template identities and exhaustive held maps',()=>{
 const check=v=>runtimeReadbackMatches(v,'plan','fresh-root',sha,executionTree,treeReceipt);
 assert.ok(check({receipt:treeReceipt,data:executionTree}));
 for(const patch of [{schema:receipt.schema},{rootBranchId:'fresh-child'},{branchMap:{'source-branch':'fresh-root'}},{ownerPins:{}},{reservedFrontiers:{}},{frontiers:{}},{held:false},{dispatched:true}])assert.equal(check({receipt:{...treeReceipt,...patch},data:executionTree}),false);
 assert.equal(check({receipt:treeReceipt,data:{...executionTree,branches:{'source-branch':data}}}),false);
 assert.equal(runtimeReadbackMatches({receipt:treeReceipt,data},'plan','fresh-root',sha),false);
 assert.equal(runtimeReadbackMatches({receipt,data:executionTree},'plan','fresh-root',sha),false);
});
test('definition-only saved receipt is exhaustive and cannot silently substitute nodes',()=>{
 const saved={manifestSha256:definitionTree.sha256,branchMap:treeReceipt.branchMap,chatMap:{'chat-ref':'new-chat'},agentMap:{},nodes:Object.fromEntries(definitionTree.nodes.map(n=>[n.sourceBranchId,{...n,branchId:treeReceipt.branchMap[n.sourceBranchId],versionId:'new-version',bindingRevisionId:'new-binding'}])),executionOwners:0,currentAuthority:false,dispatched:false,workflowEnabled:false};
 assert.ok(definitionReceiptMatches(saved,{...treePkg,executionTree:undefined},'fresh-root'));
 for(const patch of [{manifestSha256:sha},{branchMap:{}},{nodes:{}},{workflowEnabled:true},{currentAuthority:true}])assert.equal(definitionReceiptMatches({...saved,...patch},{...treePkg,executionTree:undefined},'fresh-root'),false);
 assert.equal(definitionReceiptMatches({...saved,nodes:{...saved.nodes,'source-branch':{...saved.nodes['source-branch'],definition:{name:'substituted'}}}},{...treePkg,executionTree:undefined},'fresh-root'),false);
});
