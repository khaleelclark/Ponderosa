import assert from 'node:assert/strict';
import test from 'node:test';
import {addNode,bindDefinitionDirectories,branchDraftRevision,conditionBefore,isCurrentWorkflowResponse,newDefinition,removeWorkflowNode,workflowGraphLevels} from '../src/components/branches/model.js';
test('new Scripts and parallel/condition helper paths bind the existing Chat folder',()=>{
 const original={...newDefinition(),entry:'work',steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Work'}]};
 for(const kind of ['script','parallel']){const added=addNode(original,kind,'work').definition;const bindings=bindDefinitionDirectories(added,{agents:{worker:'existing'},directories:{}},'/chosen/chat');assert.equal(bindings.directories.workspace,'/chosen/chat');assert.equal(bindings.agents.worker,'existing');assert.ok(added.edges.some(e=>e.from==='work'))}
 const conditional=conditionBefore(original,'work').definition;assert.equal(bindDefinitionDirectories(conditional,{agents:{worker:'existing'},directories:{}},'/chosen/chat').directories.workspace,'/chosen/chat');
});
test('inserting approval preserves its approved continuation and paired fork input order',()=>{
 let d=newDefinition();const notify=addNode(d,'action',d.entry);d=notify.definition;const approval=addNode(d,'human_gate',d.entry);d=approval.definition;
 assert.ok(d.edges.some(e=>e.from===approval.selected&&e.to===notify.selected&&e.on==='approved'));
 const parallel=addNode(d,'parallel',approval.selected);const fork=parallel.definition.controls.find(c=>c.id===parallel.selected),join=parallel.definition.controls.find(c=>c.id===fork.joinId);
 assert.deepEqual(join.inputOrder,parallel.definition.edges.filter(e=>e.from===fork.id).map(e=>e.id));assert.ok(parallel.definition.edges.some(e=>e.from===join.id&&e.to===notify.selected));
});
test('late workflow mutation responses cannot replace a different or revisited selection',()=>{
 const started={branchId:'a',selection:1};assert.equal(isCurrentWorkflowResponse(started,{branchId:'b',selection:2}),false);assert.equal(isCurrentWorkflowResponse(started,{branchId:'a',selection:3}),false);assert.equal(isCurrentWorkflowResponse(started,started),true);
});

test('dirty comparison ignores trigger bindings that a manual workflow cannot use',()=>{
 const definition=newDefinition(),base={branchId:'branch',expectedVersionId:'version',chatId:'chat',definition,bindings:{agents:{},directories:{workspace:'/tmp/work'}}};
 const touched={...base,bindings:{...base.bindings,triggers:{source:{enabled:true,sourceConfig:{scheduleKind:'interval',everyMs:60000,startsAt:'2026-09-20T00:00:00.000Z'}}}}};
 assert.equal(branchDraftRevision(touched),branchDraftRevision(base));
 const scheduled={...touched,definition:{...definition,trigger:{kind:'schedule',configRef:'source'}}};
 assert.notEqual(branchDraftRevision(scheduled),branchDraftRevision(base));
});

test('failure summary uses the current attempt and excludes recovered invocations',async()=>{
 const {executionFailures}=await import('../src/components/branches/model.js');
 const detail={steps:[{id:'done',stepId:'recovered',pathId:'p0',state:'completed'},{id:'bad',stepId:'review',pathId:'p1',state:'failed'},{id:'unknown',stepId:'script',pathId:'p2',state:'outcome_unknown'}],paths:[{id:'p0',stepExecutionId:'done',state:'completed'},{id:'p1',stepExecutionId:'bad',state:'failed'},{id:'p2',stepExecutionId:'unknown',state:'waiting'}],attempts:[{stepExecutionId:'done',number:1,error:'old failure'},{stepExecutionId:'bad',number:2,result:{failed:true,output:'Provider unavailable'}},{stepExecutionId:'bad',number:1,error:'obsolete'}]};
 const rows=executionFailures(detail);assert.equal(rows.length,2);assert.deepEqual(rows[0],{stepId:'review',invocationId:'bad',reason:'Provider unavailable'});assert.match(rows[1].reason,/outcome is unknown/);
 detail.steps.push({id:'old',stepId:'review',pathId:'p1',state:'failed'});assert.equal(executionFailures(detail).length,2);
});


test('removing a condition fallback repairs it to the next Step and blocks a terminal fallback',()=>{
 const base={...newDefinition(),entry:'work',steps:[
  {id:'work',kind:'script',runtime:'node',source:'',cwdRef:'workspace',timeoutMs:1000},
  {id:'done',kind:'script',runtime:'node',source:'',cwdRef:'workspace',timeoutMs:1000},
 ],edges:[{id:'work_done',from:'work',to:'done',on:'success'}]};
 const conditional=conditionBefore(base,'work').definition;
 const condition=conditional.controls.find(node=>node.kind==='condition');
 const fallback=condition.otherwise;
 const repaired=removeWorkflowNode(conditional,fallback);
 assert.equal(repaired.ok,true);
 assert.equal(repaired.definition.controls.find(node=>node.id===condition.id).otherwise,'done');
 assert.ok(repaired.definition.edges.some(edge=>edge.from===condition.id&&edge.on==='failure'&&edge.to==='done'));
 const terminal={...conditional,edges:conditional.edges.filter(edge=>edge.from!==fallback)};
 const blocked=removeWorkflowNode(terminal,fallback);
 assert.equal(blocked.ok,false);
 assert.match(blocked.reason,/Condition fallback/);
});

test('graph layout ignores loop-back edges while preserving forward levels',()=>{
 const definition={...newDefinition(),entry:'first',steps:[
  {id:'first',kind:'script',runtime:'node',source:'',cwdRef:'workspace',timeoutMs:1000},
  {id:'second',kind:'script',runtime:'node',source:'',cwdRef:'workspace',timeoutMs:1000},
  {id:'third',kind:'script',runtime:'node',source:'',cwdRef:'workspace',timeoutMs:1000},
 ],edges:[
  {id:'forward_a',from:'first',to:'second',on:'success'},
  {id:'forward_b',from:'second',to:'third',on:'success'},
  {id:'loop',from:'third',to:'first',on:'success',loop:true},
 ]};
 const levels=workflowGraphLevels(definition);
 assert.deepEqual([levels.get('first'),levels.get('second'),levels.get('third')],[0,1,2]);
});
