// Deferred caller-flow source only. Do not execute while the runtime qualification hold is active.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,stableJson} from '@ponderosa/agents';
import {createHash} from 'node:crypto';
import {createServer} from '../../apps/server/dist/app.js';
const hash=v=>createHash('sha256').update(stableJson(v)).digest('hex');
async function fixture(t){
 const root=mkdtempSync(path.join(tmpdir(),'branch-definition-tree-')),childDirectory=path.join(root,'child');mkdirSync(childDirectory);
 let store,app;
 const inert=async function*(){throw Error('No provider execution belongs to definition publication')};
 const adapter={id:'codex',displayName:'Inert definition fixture',trustedSystemPromptChannel:'developer',listModels:()=>[{id:'fixture',label:'Fixture'}],listEfforts:()=>[{id:'medium',label:'Medium'}],defaultModel:()=>'fixture',defaultEffort:()=>'medium',seed:inert,continue:inert};
 const open=()=>{store=new AgentStore(path.join(root,'state'));app=createServer({dataDir:path.join(root,'state'),store,logger:false,engines:[{adapter,authStatus:async()=>({authenticated:true})}]});};open();
 const close=async()=>{app.prepareForShutdown();await app.close();store.close();};
 t.after(async()=>{await close();rmSync(root,{recursive:true,force:true});});
 const api=async(method,url,payload)=>{const r=await app.inject({method,url,...(payload!==undefined?{payload}:{})});assert.equal(r.statusCode,200,r.body);return r.json();};
 const pkg=name=>({schema:'ponderosa.branch-installation.v1',packageId:'fixture.'+name,mode:'template',exportedAt:new Date().toISOString(),definition:{schema:'ponderosa.branch.v1',name,trigger:{kind:'manual'},entry:'agent',steps:[{id:'agent',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Inert fixture'}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},chats:[{ref:'chat',title:name+' template Chat',agents:[{ref:'worker',definition:{schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:name,rootRef:'worker',agents:[{ref:'worker',title:name+' Worker',engine:'codex',model:'fixture',effort:'medium',initialInstructions:'Definition-only fixture',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]}}]}],agentBindings:{worker:{chatRef:'chat',agentRef:'worker'}}});
 const bindings=dir=>({agents:{},directories:{workspace:dir,work:dir},engines:{codex:'codex'}});
 const install=async(name,dir)=>{const p=await api('POST','/api/branches/install-preview',{package:pkg(name),bindings:bindings(dir)}),done=await api('POST',`/api/branches/installations/${p.id}/confirm`,{});assert.equal(done.state,'completed',done.error);return {branch:await api('GET',`/api/branches/${done.branchId}`),config:await api('GET',`/api/branches/${done.branchId}/configuration`)};};
 const parent=await install('Parent',root),child=await install('Child',childDirectory);
 const update=async(owner,name,steps,edges,targets)=>{
  const definition={...pkg(name).definition,steps:[...pkg(name).definition.steps,...steps],edges};
  owner.branch=await api('POST','/api/branches/deploy',{chatId:'',branchId:owner.branch.id,expectedVersionId:owner.branch.versionId,idempotencyKey:'graph-'+name,definition,bindings:{...owner.config,branches:targets}});
 };
 await update(parent,'Parent',[{id:'call',kind:'branch_call',branchRef:'child'},{id:'shared',kind:'branch_call',branchRef:'shared'}],[{id:'a',from:'agent',to:'call',on:'success'},{id:'b',from:'call',to:'shared',on:'success'}],{child:child.branch.id,shared:child.branch.id});
 await update(child,'Child',[{id:'script',kind:'script',runtime:'node',source:'// never executed',cwdRef:'work',timeoutMs:5000},{id:'back',kind:'branch_call',branchRef:'parent'}],[{id:'a',from:'agent',to:'script',on:'success'},{id:'b',from:'script',to:'back',on:'success'}],{parent:parent.branch.id});
 const exported=await api('GET',`/api/branches/${parent.branch.id}/package?mode=full&includeValues=true`);
 assert.equal(exported.definitionTree.nodes.length,2,'shared and cyclic traversal visits each Branch once');assert.equal(exported.chats.length,2);assert.equal(exported.runtimeData,undefined);
 const treeBindings={[parent.branch.id]:bindings(root),[child.branch.id]:bindings(childDirectory)};
 const preview=()=>api('POST','/api/branches/install-preview',{package:exported,bindings:bindings(root),treeBindings});
 const confirm=async(p)=>{
  const url=`/api/branches/installations/${p.id}`;
  let done=await api('POST',url+'/confirm',{acknowledgeFullImport:true,acknowledgeDefinitionTreeSha256:p.definitionTreeReview.reviewSha256});
  for(let i=0;i<8&&done.state==='applying';i++){
   const state=await api('GET',url);
   if(state.accessSettingsReview){const r=state.accessSettingsReview;await api('POST',url+'/access-review',{chatRef:r.chatRef,agentRef:r.agentRef,resolution:{action:'keep_destination',reviewSha256:r.review.reviewSha256}});}
   else if(state.error)break;
   done=await api('POST',url+'/confirm',{});
  }
  return done;
 };
 return {root,childDirectory,parent,child,exported,treeBindings,preview,confirm,api,get store(){return store},get app(){return app},async reopen(){await close();open();}};
}
test('definition closure: actual exporter -> per-Branch preview -> actual composer -> atomic publication -> replay/restart readback',async t=>{
 const f=await fixture(t),p=await f.preview();assert.equal(p.definitionTreeReview.branches,2);
 const denied=await f.app.inject({method:'POST',url:`/api/branches/installations/${p.id}/confirm`,payload:{acknowledgeFullImport:true,acknowledgeDefinitionTreeSha256:f.exported.definitionTree.sha256}});assert.equal(denied.statusCode,409,'source inventory hash cannot acknowledge different destination bindings');
 // Restart the reviewed private plan before confirmation: fresh IDs must be retained.
 const before=JSON.parse(f.store.sqlite.prepare('SELECT preview_json FROM branch_installation_plans WHERE id=?').get(p.id).preview_json).tree;
 await f.reopen();const done=await f.confirm(p);assert.equal(done.state,'completed',done.error);
 const r=done.definitionTreeReceipt;assert.deepEqual(r.branchMap,before.branchMap);assert.notEqual(r.branchMap[f.parent.branch.id],f.parent.branch.id);assert.notEqual(r.branchMap[f.child.branch.id],f.child.branch.id);
 for(const n of f.exported.definitionTree.nodes){const saved=r.nodes[n.sourceBranchId];assert.deepEqual(saved.definition,n.definition);assert.equal(saved.bindings.directories.work,n.sourceBranchId===f.parent.branch.id?f.root:f.childDirectory);for(const [ref,target] of Object.entries(n.dependencies))assert.equal(saved.bindings.branches[ref],r.branchMap[target]);assert.equal(f.store.sqlite.prepare('SELECT enabled FROM branches WHERE id=?').get(saved.branchId).enabled,0);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions WHERE branch_id=?').get(saved.branchId).n,0);}
 assert.equal(Object.keys(r.agentMap).length,2);assert.equal(Object.keys(r.chatMap).length,2);assert.equal(r.currentAuthority,false);assert.equal(r.dispatched,false);
 assert.deepEqual((await f.api('POST',`/api/branches/installations/${p.id}/confirm`,{})).definitionTreeReceipt,r);
 await f.reopen();assert.deepEqual((await f.api('GET',`/api/branches/installations/${p.id}`)).definitionTreeReceipt,r);
 const reexported=await f.api('GET',`/api/branches/${done.branchId}/package?mode=full`);assert.equal(reexported.definitionTree.nodes.length,2);assert.equal(reexported.runtimeData,undefined);
});
test('definition closure rejects incomplete/aliased manifests and refuses execution-bearing graphs before export writes',async t=>{
 const f=await fixture(t);
 for(const edit of [d=>d.nodes.pop(),d=>d.nodes[1].chatRefs=d.nodes[0].chatRefs,d=>delete d.nodes[0].dependencies.child]){
  const pkg=structuredClone(f.exported);edit(pkg.definitionTree);const {sha256,...data}=pkg.definitionTree;pkg.definitionTree.sha256=hash(data);
  const response=await f.app.inject({method:'POST',url:'/api/branches/install-preview',payload:{package:pkg,bindings:{agents:{},directories:{}},treeBindings:f.treeBindings}});assert.equal(response.statusCode,400);
 }
 const tampered=structuredClone(f.exported);tampered.chats[1].instructions='Changed private Chat context';
 const changed=await f.app.inject({method:'POST',url:'/api/branches/install-preview',payload:{package:tampered,bindings:{agents:{},directories:{}},treeBindings:f.treeBindings}});assert.equal(changed.statusCode,400);assert.match(changed.json().error,/package bytes differ/);
 await f.api('POST',`/api/branches/${f.child.branch.id}/executions`,{occurrenceKey:'unknown-source-owner',input:'do not dispatch'});
 const before=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_installation_resources').get().n;
 const response=await f.app.inject({method:'GET',url:`/api/branches/${f.parent.branch.id}/package?mode=full`});assert.equal(response.statusCode,400);assert.match(response.json().error,/ZERO execution owners/);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_installation_resources').get().n,before);
});
test('failure at the final child publication rolls back every version/dependency/final Chat ownership change',async t=>{
 const f=await fixture(t),p=await f.preview(),plan=JSON.parse(f.store.sqlite.prepare('SELECT preview_json FROM branch_installation_plans WHERE id=?').get(p.id).preview_json).tree,childId=plan.branchMap[f.child.branch.id];
 // Fault injection only; all source creation/export/installation uses actual callers.
 assert.match(childId,/^[a-f0-9-]+$/);
 f.store.sqlite.exec(`CREATE TEMP TRIGGER definition_tree_last_failure BEFORE INSERT ON branch_versions WHEN NEW.branch_id='${childId}' BEGIN SELECT RAISE(ABORT,'last-publication-fixture'); END`);
 const done=await f.confirm(p);assert.notEqual(done.state,'completed');
 for(const id of Object.values(plan.branchMap)){assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_versions WHERE branch_id=?').get(id).n,0);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_dependencies WHERE branch_id=?').get(id).n,0);}
 assert.equal(f.store.sqlite.prepare('SELECT id FROM branches WHERE id=?').get(childId),undefined);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM conversations WHERE branch_id=?').get(childId).n,0);
 const resources=f.store.sqlite.prepare('SELECT branch_id,state FROM branch_installation_resources WHERE staging_plan_id=?').all(p.id);assert.ok(resources.every(r=>r.branch_id===done.branchId&&r.state==='staging'));
 f.store.sqlite.exec('DROP TRIGGER definition_tree_last_failure');
});
