import test from 'node:test';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
const {layoutWorkflowCanvas:layoutWithEngine,workflowCanvasKey,workflowConnectionLabel,workflowTerminalOutcomes}=await import('../../apps/web/src/components/branches/canvas-layout.ts');
const ELK=createRequire(new URL('../../apps/web/package.json',import.meta.url))('elkjs/lib/elk.bundled.js'),engine=new ELK();
const layoutWorkflowCanvas=(definition,bindings,measurements={},context={})=>layoutWithEngine(definition,bindings,measurements,context,engine);
const script=id=>({id,label:id,kind:'script',runtime:'node',source:'process.stdout.write("done")',cwdRef:'workspace',timeoutMs:1000});
const edge=(id,from,to,on='success',extra={})=>({id,from,to,on,...extra});
const graph=(steps,controls=[],edges=[],entry=steps[0]?.id??controls[0]?.id??'')=>({schema:'ponderosa.branch.v1',name:'Canvas test',trigger:{kind:'manual'},entry,steps,controls,edges,policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}});
const bindings={agents:{},directories:{workspace:'/unused'}};
const overlaps=(a,b)=>a.x<b.x+b.width-.01&&a.x+a.width>b.x+.01&&a.y<b.y+b.height-.01&&a.y+a.height>b.y+.01;
const crosses=(a,b,box)=>a.x===b.x?a.x>box.x+.01&&a.x<box.x+box.width-.01&&Math.max(a.y,b.y)>box.y+.01&&Math.min(a.y,b.y)<box.y+box.height-.01:a.y===b.y?a.y>box.y+.01&&a.y<box.y+box.height-.01&&Math.max(a.x,b.x)>box.x+.01&&Math.min(a.x,b.x)<box.x+box.width-.01:false;
function assertGeometry(layout){
 for(const node of layout.nodes){assert.ok(Number.isFinite(node.x)&&Number.isFinite(node.y),`Position is finite: ${node.id}`);for(const other of layout.nodes)if(other.id!==node.id)assert.ok(!overlaps(node,other),`Cards do not overlap: ${node.id}, ${other.id}`);}
 const boxes=layout.edges.flatMap(e=>[{...e.labelBox,id:e.id+':label'},{...e.insertion,id:e.id+':insert'}]);
 for(const box of boxes){for(const node of layout.nodes)assert.ok(!overlaps(box,node),`${box.id} clears ${node.id}`);for(const other of boxes)if(other.id!==box.id)assert.ok(!overlaps(box,other),`${box.id} clears ${other.id}`);}
 for(const e of layout.edges){assert.ok(e.sections.length,`Canonical route is laid out: ${e.id}`);for(const points of e.sections)for(let i=1;i<points.length;i++){
  const a=points[i-1],b=points[i];assert.ok(a.x===b.x||a.y===b.y,`Orthogonal routing for ${e.id}`);
  for(const node of layout.nodes)assert.ok(!crosses(a,b,node),`Connection ${e.id} routes outside card ${node.id}`);
  for(const box of boxes)assert.ok(!crosses(a,b,box),`Connection ${e.id} clears ${box.id}`);
 }}
}

test('ELK presentation is deterministic, immutable and retains shared and disconnected cards once',async()=>{
 const d=graph([script('a'),script('b'),script('shared'),script('draft')],[],[edge('first','a','shared'),edge('second','b','shared')]);
 const before=JSON.stringify(d),bindingBefore=JSON.stringify(bindings),one=await layoutWorkflowCanvas(d,bindings),two=await layoutWorkflowCanvas(d,bindings);
 assert.deepEqual(one,two);assert.equal(JSON.stringify(d),before);assert.equal(JSON.stringify(bindings),bindingBefore);
 assert.deepEqual(one.nodes.filter(n=>n.kind==='workflow').map(n=>n.id).sort(),['a','b','draft','shared']);
 assert.equal(one.edges.filter(e=>e.target==='shared').length,2);assert.deepEqual(one.edges.filter(e=>e.canonicalEdgeId).map(e=>e.canonicalEdgeId).sort(),['first','second']);assertGeometry(one);
});

test('measured cards and long labels reserve independent insertion targets clear of routes',async()=>{
 const d=graph([script('start'),script('wide'),script('last')],[{id:'route',kind:'route',otherwise:'last'}],[edge('in','start','route'),edge('named','route','wide','selected',{choice:'The selected route has a much longer descriptive name'}),edge('otherwise','route','last','failure'),edge('merge','wide','last')]);
 const measured={nodes:{start:{width:312,height:160},wide:{width:380,height:210},last:{width:280,height:130}},labels:{named:{width:420,height:96},otherwise:{width:130,height:40}}};
 const layout=await layoutWorkflowCanvas(d,bindings,measured);
 assert.equal(layout.nodes.find(n=>n.id==='wide').width,380);assert.equal(layout.nodes.find(n=>n.id==='wide').height,210);
 assert.equal(layout.edges.find(e=>e.id==='named').labelBox.width,420);assert.equal(layout.edges.find(e=>e.id==='named').labelBox.height,96);
 assert.ok(layout.edges.every(e=>e.insertion.width>=44&&e.insertion.height>=44));assertGeometry(layout);
});

test('nested parallel and For Each groups preserve shared destinations and required control relationships',async()=>{
 const controls=[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['arm-b','arm-map']},{id:'map',kind:'map',workerId:'worker',joinId:'items',source:'list',maxItems:10,maxConcurrentItems:2},{id:'items',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]}];
 const edges=[edge('arm-map','fork','map','selected'),edge('arm-b','fork','b','selected'),edge('each','map','worker','selected'),edge('item-in','worker','items'),edge('map-in','items','join'),edge('b-in','b','join'),edge('done','join','shared')];
 const d=graph([script('b'),script('worker'),script('shared')],controls,edges,'fork'),layout=await layoutWorkflowCanvas(d,bindings);
 assert.equal(layout.nodes.filter(n=>n.id==='shared').length,1);assert.equal(layout.edges.filter(e=>e.canonicalEdgeId).length,edges.length);
 assert.deepEqual(layout.groups.map(g=>[g.kind,g.forkId,g.joinId]),[['parallel','fork','join'],['for_each','map','items']]);
 assert.ok(layout.groups[0].nodeIds.includes('worker'));assert.ok(!layout.groups[0].nodeIds.includes('shared'));assert.ok(!layout.groups[1].nodeIds.includes('b'));assert.equal(layout.edges.find(e=>e.id==='each').label,'Each Item');assertGeometry(layout);
});

test('declared loops and self-loops remain distinct labeled return routes outside cards',async()=>{
 const d=graph([script('a'),script('b'),script('end')],[],[edge('down','a','b'),edge('finish','b','end'),edge('again','b','a','failure',{loop:true}),edge('self','a','a','failure',{loop:true})]);
 const layout=await layoutWorkflowCanvas(d,bindings);
 for(const id of ['again','self']){const e=layout.edges.find(e=>e.id===id);assert.equal(e.loop,true);assert.equal(e.label,'Return — Failure');assert.ok(e.sections.some(points=>points.length>2));assert.ok(layout.nodes.find(n=>n.id===e.source).ports.some(port=>port.id===e.sourcePort&&port.side==='EAST'));}
 assert.ok(layout.nodes.find(n=>n.id==='a').y<layout.nodes.find(n=>n.id==='b').y,'Ordinary Success stays top to bottom despite cycle breaking');
 assert.ok(layout.nodes.find(n=>n.id==='b').y<layout.nodes.find(n=>n.id==='end').y,'Forward chain retains its reading direction');
 assert.equal(d.edges.length,4);assertGeometry(layout);
});

test('terminal slots model only actual success, approval and configured terminating cancellation outcomes',async()=>{
 const agent={id:'agent',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Work'},approval={id:'gate',kind:'human_gate',prompt:'Review',editable:true},child={id:'child',kind:'branch_call',branchRef:'child',canceled:'terminate'};
 const d=graph([agent,approval,child],[{id:'condition',kind:'condition',predicate:{source:'input',equals:'yes'},otherwise:'child'}],[edge('matches','condition','gate','selected'),edge('other','condition','child','failure'),edge('approve','gate','agent','approved')]);
 const terminals=workflowTerminalOutcomes(d);
 assert.deepEqual(terminals,[{from:'agent',on:'success'},{from:'gate',on:'rejected'},{from:'child',on:'success'},{from:'child',on:'canceled'}]);
 const layout=await layoutWorkflowCanvas(d,bindings);assert.equal(layout.nodes.filter(n=>n.kind==='terminal').length,4);assert.ok(!layout.edges.some(e=>e.terminal?.on==='failure'));
 assert.equal(layout.edges.find(e=>e.id==='other').label,'Otherwise');assert.equal(layout.edges.find(e=>e.id==='matches').label,'Matches');assertGeometry(layout);
});

test('layout key ignores instruction keystrokes and unrelated bindings but tracks rendered context, dimensions and graph semantics',()=>{
 const d=graph([{id:'a',label:'Agent work',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'First'}]);
 const b={...bindings,agents:{worker:'agent-1'}},key=workflowCanvasKey(d,b),same=structuredClone(d);same.steps[0].instructions='Every keystroke';same.name='Renamed workflow';
 assert.equal(workflowCanvasKey(same,b),key);assert.equal(workflowCanvasKey(same,{...b,agents:{...b.agents,unrelated:'other'}}),key);
 assert.notEqual(workflowCanvasKey(d,{...b,agents:{worker:'agent-2'}}),key);assert.notEqual(workflowCanvasKey(d,b,{}, {a:'Renamed actual Agent'}),key);assert.notEqual(workflowCanvasKey(d,b,{nodes:{a:{width:320,height:150}}}),key);
 same.steps[0].label='Changed card';assert.notEqual(workflowCanvasKey(same,b),key);
});

test('empty workflows have no fabricated example graph; invalid dangling edges remain represented for correction',async()=>{
 const empty=await layoutWorkflowCanvas(graph([]),bindings);assert.deepEqual(empty.nodes,[]);assert.deepEqual(empty.edges,[]);assert.equal(empty.width,0);
 const d=graph([script('a')],[],[edge('missing','a','deleted','failure')]),layout=await layoutWorkflowCanvas(d,bindings),missing=layout.edges.find(e=>e.id==='missing');
 assert.equal(missing.canonicalEdgeId,'missing');assert.equal(missing.target,'deleted');assert.equal(missing.unresolved,true);assert.deepEqual(missing.sections,[]);
});

test('outcome labels distinguish alternatives, approval and configured names without inferring failure',()=>{
 const d=graph([script('s')],[{id:'choose',kind:'condition',otherwise:'s'},{id:'named',kind:'route',otherwise:'s'}]);
 assert.equal(workflowConnectionLabel(d,{from:'s',on:'success'}),'Success');assert.equal(workflowConnectionLabel(d,{from:'s',on:'failure'}),'Failure');assert.equal(workflowConnectionLabel(d,{from:'s',on:'approved'}),'Approved');assert.equal(workflowConnectionLabel(d,{from:'s',on:'rejected'}),'Rejected');assert.equal(workflowConnectionLabel(d,{from:'choose',on:'failure'}),'Otherwise');assert.equal(workflowConnectionLabel(d,{from:'named',on:'selected',choice:'Legal review'}),'Legal review');
});


test('wide parallel paths keep distinct labels and controls without duplicating the shared Join',async()=>{
 const arms=12,ids=Array.from({length:arms},(_,i)=>`path-${String(i).padStart(2,'0')}`),controls=[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:ids.map(id=>'out-'+id)}];
 const d=graph(ids.map(script),controls,ids.flatMap(id=>[edge('out-'+id,'fork',id,'selected'),edge('in-'+id,id,'join')]),'fork');
 const layout=await layoutWorkflowCanvas(d,bindings);assert.equal(layout.nodes.filter(n=>n.id==='join').length,1);assert.equal(layout.edges.filter(e=>e.source==='fork').length,arms);assertGeometry(layout);
});

test('canonical array order alone does not rearrange a graph or change the projection key',async()=>{
 const d=graph([script('a'),script('b'),script('shared')],[],[edge('first','a','shared'),edge('second','b','shared')]);
 const reordered={...d,steps:d.steps.slice().reverse(),edges:d.edges.slice().reverse()};
 const one=await layoutWorkflowCanvas(d,bindings),two=await layoutWorkflowCanvas(reordered,bindings);
 assert.deepEqual(one,two);
});

// React Flow uses node IDs inside quoted attribute selectors for Handle updates.
test('terminal presentation identities are selector-safe and cannot collide with canonical identities',async()=>{
 const d=graph([script('canvas:terminal:source')]),layout=await layoutWorkflowCanvas(d,bindings);
 const terminal=layout.nodes.find(node=>node.kind==='terminal');
 assert.ok(terminal&&!/["\\\r\n]/u.test(terminal.id),'Presentation IDs must not break library selectors');
 assert.ok(terminal.id.includes('%'),'Canonical Branch IDs cannot contain the terminal namespace delimiter');
});
