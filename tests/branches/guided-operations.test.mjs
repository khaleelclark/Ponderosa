import assert from 'node:assert/strict';
import test from 'node:test';
import '../shared/web-typescript-loader.mjs';
import {validateBranchDefinition} from '../../packages/agents/dist/branch-definition.js';
const {addNode,makeScript,newDefinition}=await import('../../apps/web/src/components/branches/model.ts');
const {guidedInsertionRestriction,insertGuidedStep}=await import('../../apps/web/src/components/branches/guided-operations.ts');

const kinds=['agent','script','human_gate','action','branch_call','parallel','for_each','condition','route'];
const script=id=>({...makeScript(id),label:id});
const edge=(id,from,to,on='success',extra={})=>({id,from,to,on,...extra});
const graph=(steps,edges,controls=[],entry=steps[0]?.id)=>({...newDefinition(),entry,steps,controls,edges});
function apply(definition,kind,target) {
 const before=structuredClone(definition),result=insertGuidedStep(definition,kind,target);
 assert.equal(result.ok,true,result.ok?'':result.reason);
 assert.deepEqual(definition,before,'Insertion must never mutate the current draft.');
 validateBranchDefinition(result.definition);
 return result;
}

for(const kind of kinds) {
 test(`${kind}: empty workflow, entry insertion and terminal insertion are structurally publishable without Agent bindings`,()=>{
  const first=apply(newDefinition(),kind,{kind:'entry'});
  assert.equal(first.definition.entry,first.selected);
  const existing=graph([script('original')],[]),before=apply(existing,kind,{kind:'entry'});
  assert.equal(before.definition.entry,before.selected);
  assert.ok(before.definition.edges.some(item=>item.to==='original'));
  const after=apply(existing,kind,{kind:'terminal',nodeId:'original',on:'success'});
  assert.equal(after.definition.entry,'original');
  assert.ok(after.definition.edges.some(item=>item.from==='original'&&item.to===after.selected&&item.on==='success'));
 });
}

for(const [kind,on] of [['script','success'],['script','failure'],['human_gate','approved'],['human_gate','rejected'],['branch_call','canceled']]) {
 test(`Inserting on ${on} preserves its exact edge identity, metadata and unrelated routes`,()=>{
  const first=kind==='human_gate'?{id:'first',kind,prompt:'Approve?',editable:true}:kind==='branch_call'?{id:'first',kind,branchRef:'nested'}:script('first');
  const definition=graph([first,script('destination'),script('shared')],[edge('chosen','first','destination',on,{input:{kind:'literal',text:'Authored override'},loop:false}),edge('continue','destination','shared')]);
  const result=apply(definition,'script',{kind:'edge',edgeId:'chosen'});
  assert.deepEqual(result.definition.edges.find(item=>item.id==='chosen'),{...definition.edges[0],to:result.selected});
  assert.deepEqual(result.definition.edges.find(item=>item.id==='continue'),definition.edges[1]);
  assert.ok(result.definition.edges.some(item=>item.from===result.selected&&item.to==='destination'&&item.on==='success'));
 });
}

test('A failure route retains the inactive retry policy and does not become a success route',()=>{
 const first={...script('first'),failure:{action:'retry',maxAttempts:4,delayMs:1200,freshContext:true}};
 const definition=graph([first,script('normal'),script('fallback')],[edge('normal-edge','first','normal'),edge('failure-edge','first','fallback','failure')]);
 const result=apply(definition,'human_gate',{kind:'edge',edgeId:'failure-edge'});
 assert.deepEqual(result.definition.steps.find(item=>item.id==='first'),first);
 assert.deepEqual(result.definition.edges.find(item=>item.id==='normal-edge'),definition.edges[0]);
 assert.equal(result.definition.edges.find(item=>item.id==='failure-edge').on,'failure');
 assert.ok(result.definition.edges.some(item=>item.from===result.selected&&item.to==='fallback'&&item.on==='approved'));
});

test('A named route keeps its choice and only updates its own Otherwise pointer',()=>{
 const controls=[{id:'route',kind:'route',label:'Which?',otherwise:'shared'},{id:'condition',kind:'condition',predicate:{source:'input',equals:'yes'},otherwise:'shared'}];
 const definition=graph([script('named'),script('shared')],[edge('choice','route','condition','selected',{choice:'My Route',input:{kind:'output'}}),edge('route-fallback','route','shared','failure'),edge('match','condition','named','selected'),edge('condition-fallback','condition','shared','failure')],controls,'route');
 const chosen=apply(definition,'script',{kind:'edge',edgeId:'choice'});
 assert.deepEqual(chosen.definition.edges.find(item=>item.id==='choice'),{...definition.edges[0],to:chosen.selected});
 const fallback=apply(definition,'condition',{kind:'edge',edgeId:'route-fallback'});
 assert.equal(fallback.definition.controls.find(item=>item.id==='route').otherwise,fallback.selected);
 assert.equal(fallback.definition.controls.find(item=>item.id==='condition').otherwise,'shared');
 assert.deepEqual(fallback.definition.edges.find(item=>item.id==='condition-fallback'),definition.edges[3]);
 assert.equal(fallback.definition.steps.filter(item=>item.id==='shared').length,1,'A shared destination stays one editable Step.');
});

test('Condition Otherwise insertion changes both its exact edge and canonical fallback reference',()=>{
 const definition=graph([script('yes'),script('no')],[edge('match','choose','yes','selected'),edge('otherwise','choose','no','failure')],[{id:'choose',kind:'condition',predicate:{source:'input',equals:'yes'},otherwise:'no'}],'choose');
 const result=apply(definition,'route',{kind:'edge',edgeId:'otherwise'});
 assert.equal(result.definition.controls.find(item=>item.id==='choose').otherwise,result.selected);
 assert.deepEqual(result.definition.edges.find(item=>item.id==='match'),definition.edges[0]);
});

test('Nested parallel insertion keeps original fork edge IDs, Join order, modes and unrelated arms',()=>{
 const original=addNode(newDefinition(),'parallel').definition,owner=original.controls.find(item=>item.kind==='fork'),join=original.controls.find(item=>item.kind==='join'),arm=original.edges.find(item=>item.from===owner.id);
 join.mode='quorum';join.quorum=1;join.remainder='cancel';join.onUnmet='continue';join.inputOrder.reverse();
 arm.input={kind:'literal',text:'arm override'};
 const result=apply(original,'parallel',{kind:'edge',edgeId:arm.id});
 assert.deepEqual(result.definition.controls.find(item=>item.id===join.id),join);
 assert.deepEqual(result.definition.edges.find(item=>item.id===arm.id),{...arm,to:result.selected});
 assert.deepEqual(result.definition.edges.filter(item=>original.edges.some(old=>old.id===item.id)&&item.id!==arm.id),original.edges.filter(item=>item.id!==arm.id));
 const inner=result.definition.controls.find(item=>item.id===result.selected);
 assert.ok(result.definition.edges.some(item=>item.from===inner.joinId&&item.to===arm.to));
});

test('For Each boundaries refuse splicing and preserve the exact worker contract',()=>{
 const definition=addNode(newDefinition(),'for_each').definition,map=definition.controls.find(item=>item.kind==='map');
 const targets=[...definition.edges.map(item=>({kind:'edge',edgeId:item.id})),{kind:'terminal',nodeId:map.id,on:'selected'},{kind:'terminal',nodeId:map.workerId,on:'failure'}];
 for(const target of targets) {
  const before=structuredClone(definition),result=insertGuidedStep(definition,'script',target);
  assert.equal(result.ok,false);assert.match(result.reason,/one worker.*directly.*Join/u);
  assert.equal(guidedInsertionRestriction(definition,target),result.reason);
  assert.deepEqual(definition,before);
 }
 const before=apply(definition,'condition',{kind:'entry'});
 assert.deepEqual(before.definition.controls.find(item=>item.id===map.id),map);
 assert.deepEqual(before.definition.edges.filter(item=>definition.edges.some(old=>old.id===item.id)),definition.edges);
 const after=apply(definition,'parallel',{kind:'terminal',nodeId:map.joinId,on:'success'});
 assert.deepEqual(after.definition.controls.find(item=>item.id===map.id),map);
 assert.deepEqual(after.definition.edges.filter(item=>definition.edges.some(old=>old.id===item.id)),definition.edges);
});

for(const kind of kinds) {
 test(`${kind}: declared loop insertion keeps the edge ID and payload, and returns through a marked continuation`,()=>{
  const definition=graph([script('start'),script('check'),script('done')],[edge('forward','start','check'),edge('finish','check','done'),edge('return','check','start','failure',{loop:true,input:{kind:'literal',text:'next iteration'}})]);
  const result=apply(definition,kind,{kind:'edge',edgeId:'return'}),incoming=result.definition.edges.find(item=>item.id==='return');
  assert.deepEqual(incoming,{id:'return',from:'check',to:result.selected,on:'failure',input:{kind:'literal',text:'next iteration'}});
  const returns=result.definition.edges.filter(item=>item.to==='start');
  assert.ok(returns.length);assert.ok(returns.every(item=>item.loop===true));
  assert.deepEqual(result.definition.edges.find(item=>item.id==='forward'),definition.edges[0]);
  assert.deepEqual(result.definition.edges.find(item=>item.id==='finish'),definition.edges[1]);
 });
}

test('Nested-loop insertion preserves the enclosing parallel context and its shared Join',()=>{
 const original=addNode(newDefinition(),'parallel').definition,fork=original.controls.find(item=>item.kind==='fork'),arm=original.edges.find(item=>item.from===fork.id),worker=arm.to;
 original.steps.push(script('loop-check'));
 original.edges.find(item=>item.from===worker).to='loop-check';
 original.edges.push(edge('complete','loop-check',fork.joinId),edge('repeat','loop-check',worker,'failure',{loop:true}));
 validateBranchDefinition(original);
 const result=apply(original,'condition',{kind:'edge',edgeId:'repeat'});
 assert.equal(result.definition.controls.filter(item=>item.kind==='join').length,1);
 assert.deepEqual(result.definition.controls.find(item=>item.id===fork.joinId),original.controls.find(item=>item.id===fork.joinId));
 assert.ok(result.definition.edges.filter(item=>item.to===worker&&item.id!==arm.id).every(item=>item.loop));
});

test('A declared loop into the original entry remains there when a new first Step is prepended',()=>{
 const definition=graph([script('start'),script('check')],[edge('forward','start','check'),edge('return','check','start','failure',{loop:true})]);
 const result=apply(definition,'script',{kind:'entry'});
 assert.deepEqual(result.definition.edges.find(item=>item.id==='return'),definition.edges[1]);
 assert.equal(result.definition.entry,result.selected);
});

test('Terminal rejected/canceled outcomes use the requested outcome, never an inferred success',()=>{
 for(const [kind,on] of [['human_gate','rejected'],['branch_call','canceled']]) {
  const first=addNode(newDefinition(),kind).definition,node=first.steps[0];
  const result=apply(first,'script',{kind:'terminal',nodeId:node.id,on});
  assert.equal(result.definition.edges.find(item=>item.from===node.id).on,on);
 }
});

test('Missing/stale/occupied targets fail without changing the draft',()=>{
 const definition=graph([script('first'),script('last')],[edge('existing','first','last')]);
 for(const target of [{kind:'edge',edgeId:'missing'},{kind:'terminal',nodeId:'missing',on:'success'},{kind:'terminal',nodeId:'first',on:'success'},{kind:'terminal',nodeId:'last',on:'approved'}]) {
  const before=structuredClone(definition),result=insertGuidedStep(definition,'script',target);
  assert.equal(result.ok,false);assert.ok(result.reason);assert.deepEqual(definition,before);
 }
});

test('New terminal work cannot silently escape its enclosing parallel Join',()=>{
 const definition=addNode(newDefinition(),'parallel').definition,worker=definition.steps[0];
 const result=insertGuidedStep(definition,'script',{kind:'terminal',nodeId:worker.id,on:'failure'});
 assert.equal(result.ok,false);assert.match(result.reason,/paired Join/u);
});

test('Draft topology guards reject malformed connections while leaving required-field validation to the server',()=>{
 const definition=graph([{id:'unbound',kind:'agent',label:'Needs setup',target:{kind:'persistent_agent',ref:'not_bound'},instructions:''}],[]);
 const result=apply(definition,'script',{kind:'terminal',nodeId:'unbound',on:'success'});
 assert.deepEqual(result.definition.steps[0],definition.steps[0]);
 const missing=structuredClone(definition);missing.edges.push(edge('bad','unbound','missing'));
 assert.equal(insertGuidedStep(missing,'script',{kind:'entry'}).ok,false);
 const ambiguous=graph([script('a'),script('b')],[edge('x','a','b'),edge('y','a','b')]);
 assert.equal(insertGuidedStep(ambiguous,'script',{kind:'entry'}).ok,false);
});

test('All unrelated authored metadata and existing node IDs survive the draft transformation',()=>{
 const definition=graph([script('first'),script('last')],[edge('existing','first','last')]);
 definition.trigger={kind:'schedule',configRef:'daily'};definition.parameters={message:{type:'text',label:'Message',default:'hello'}};
 definition.templates={};definition.policy.failure={action:'ask_human'};
 const result=apply(definition,'route',{kind:'edge',edgeId:'existing'});
 for(const key of ['schema','name','trigger','parameters','templates','policy'])assert.deepEqual(result.definition[key],definition[key]);
 for(const node of definition.steps)assert.deepEqual(result.definition.steps.find(item=>item.id===node.id),node);
});

test('Shared client-ID fallback supports rapid parallel and ordinary insertions without UUID support',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{}});
 try {
  const first=apply(newDefinition(),'parallel',{kind:'entry'});
  const second=apply(first.definition,'script',{kind:'terminal',nodeId:first.definition.controls.find(item=>item.kind==='join').id,on:'success'});
  const third=apply(second.definition,'script',{kind:'terminal',nodeId:second.selected,on:'success'});
  assert.notEqual(second.selected,third.selected);
 } finally {
  if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);
  else delete globalThis.crypto;
 }
});
