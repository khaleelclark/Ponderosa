import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {branchContinuationIds,remapBranchFrontier} from '../../packages/agents/dist/branch-continuation-remap.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
const json=value=>JSON.stringify(value);
const source='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222',bundle='33333333-3333-4333-8333-333333333333',freshBundle='44444444-4444-4444-8444-444444444444';
function fixture(){
 const selected=Object.fromEntries(['execution','paths','steps','attempts','forks','joins','loops','maps','items','sealedResults','bundles','gates','actions','resources'].map(key=>[key,[]]));
 const path=(id,parent=null,fork=null)=>({id,execution_id:source,parent_path_id:parent,fork_invocation_id:fork,edge_id:parent?'graph-edge':null,state:'active',node_id:'graph-node',step_execution_id:null,last_result_id:null,input_text:'authored old fork text',result_json:null,traversals:1,handling_limit:0});
 // UUID order is unrelated to ancestry; nested paths must be inserted parents first.
 selected.paths=[path('nested','child','map'),path('child','root','fork'),path('root')];
 selected.forks=[{id:'fork',execution_id:source,parent_path_id:'root',fork_id:'graph-fork',join_id:'graph-join',state:'closed',selected_paths_json:json(['child']),result_json:null},{id:'map',execution_id:source,parent_path_id:'child',fork_id:'graph-map',join_id:'graph-map-join',state:'open',selected_paths_json:null,result_json:null}];
 selected.maps=[{id:'map',execution_id:source,map_id:'graph-map',parent_path_id:'child',join_id:'graph-map-join',source_result_id:null,item_count:1,items_hash:hash(json(['sealed item'])),state:'open'}];
 selected.items=[{id:'map:0',map_invocation_id:'map',item_index:0,path_id:'nested',input_text:'sealed item',input_hash:hash('sealed item'),dispatched:0}];
 selected.joins=[{execution_id:source,fork_invocation_id:'fork',join_id:'graph-join',path_id:'child',outcome:'completed',output_text:'original output'}];
 selected.bundles=[{id:bundle,execution_id:source,fork_invocation_id:'fork',content_text:'original bundle bytes',content_hash:hash('original bundle bytes')}];
 const ids=Object.fromEntries(branchContinuationIds(selected).map(id=>[id,'fresh-'+id]));ids['map:0']=ids.map+':0';ids[bundle]=freshBundle;
 return {selected,ids,remap:()=>remapBranchFrontier(selected,ids,source,target)};
}
test('nested Fork/Map ancestry, ordered selection and sealed item identity remap without source mutation',()=>{
 const f=fixture(),before=structuredClone(f.selected),out=f.remap();
 assert.deepEqual(f.selected,before);
 assert.deepEqual(out.paths.map(row=>row.id),['fresh-root','fresh-child','fresh-nested']);
 assert.equal(out.paths[2].parent_path_id,'fresh-child');assert.equal(out.paths[2].fork_invocation_id,'fresh-map');
 assert.equal(out.paths[2].node_id,'graph-node');assert.equal(out.paths[2].edge_id,'graph-edge');
 assert.equal(out.paths[2].input_text,'authored old fork text');
 assert.equal(out.forks[0].selected_paths_json,json(['fresh-child']));
 assert.equal(out.joins[0].path_id,'fresh-child');assert.equal(out.joins[0].fork_invocation_id,'fresh-fork');
 assert.equal(out.maps[0].id,out.forks[1].id);assert.equal(out.items[0].id,'fresh-map:0');assert.equal(out.items[0].dispatched,0);
 assert.equal(out.bundles[0].content_text,before.bundles[0].content_text);assert.equal(out.bundles[0].content_hash,before.bundles[0].content_hash);
 for(const key of ['execution','actions','resources'])assert.equal(out[key],undefined,'remapping grants no '+key+' authority');
});
test('owned bundle pointers and their sealed hashes remap together; prose stays byte exact',()=>{
 const f=fixture(),input=`branch-result-bundle:${source}:${bundle}`,result=json({failed:false,output:input});
 f.selected.paths[0].step_execution_id='step';f.selected.paths[0].last_result_id='result';f.selected.paths[0].input_text=input;
 f.selected.steps=[{id:'step',execution_id:source,path_id:'nested',step_id:'graph-step',invocation:1,state:'completed',input_text:input,result_json:result}];
 f.selected.attempts=[{id:'attempt',step_execution_id:'step',state:'completed',input_hash:hash(input),result_json:result,fence:7,request_id:null,recovery_of_request_id:null,runtime_outcome_json:null,cancel_requested:0}];
 f.selected.sealedResults=[{id:'result',execution_id:source,path_id:'nested',step_execution_id:'step',terminal_attempt_id:'attempt',result_json:result,content_hash:hash(result)}];
 Object.assign(f.ids,{step:'fresh-step',attempt:'fresh-attempt',result:'fresh-result'});
 const out=f.remap(),mapped=`branch-result-bundle:${target}:${freshBundle}`;
 assert.equal(out.steps[0].input_text,mapped);assert.equal(out.attempts[0].input_hash,hash(mapped));assert.equal(out.attempts[0].fence,0);
 assert.equal(out.sealedResults[0].result_json,json({failed:false,output:mapped}));assert.equal(out.sealedResults[0].content_hash,hash(out.sealedResults[0].result_json));
 assert.equal(out.sealedResults[0].terminal_attempt_id,'fresh-attempt');
});
for(const [label,mutate] of [
 ['missing mapping',f=>delete f.ids.root],
 ['aliased mapping',f=>f.ids.child=f.ids.root],
 ['ancestry cycle',f=>f.selected.paths[2].parent_path_id='nested'],
 ['wrong nested parent',f=>f.selected.paths[0].parent_path_id='root'],
 ['foreign Join selection',f=>f.selected.forks[0].selected_paths_json=json(['nested'])],
 ['changed item list',f=>f.selected.items[0].input_text='changed'],
 ['changed item index',f=>f.selected.items[0].item_index=1],
 ['changed bundle bytes',f=>f.selected.bundles[0].content_text='changed'],
 ['foreign bundle pointer',f=>f.selected.paths[0].input_text=`branch-result-bundle:${target}:${bundle}`],
])test('refuses '+label,()=>{const f=fixture();mutate(f);assert.throws(f.remap);});

for(const state of ['leased','running','outcome_unknown'])test('refuses '+state+' attempt authority',()=>{
 const f=fixture();f.selected.steps=[{id:'step',execution_id:source,path_id:'nested',input_text:'input',result_json:null}];
 f.selected.attempts=[{id:'attempt',step_execution_id:'step',state,input_hash:hash('input'),result_json:null}];
 Object.assign(f.ids,{step:'fresh-step',attempt:'fresh-attempt'});assert.throws(f.remap,/authority or uncertain effect/);
});
test('refuses lease data even on a completed attempt',()=>{
 const f=fixture();f.selected.steps=[{id:'step',execution_id:source,path_id:'nested',input_text:'input',result_json:null}];
 f.selected.attempts=[{id:'attempt',step_execution_id:'step',state:'completed',input_hash:hash('input'),result_json:null,lease_owner:'foreign-owner'}];
 Object.assign(f.ids,{step:'fresh-step',attempt:'fresh-attempt'});assert.throws(f.remap,/unselected runtime state/);
});

test('Join selection retains captured order rather than path or identifier order',()=>{
 const f=fixture(),sibling={...f.selected.paths[1],id:'sibling'};f.selected.paths.push(sibling);f.ids.sibling='fresh-sibling';
 f.selected.forks[0].selected_paths_json=json(['sibling','child']);
 assert.equal(f.remap().forks[0].selected_paths_json,json(['fresh-sibling','fresh-child']));
});
