import test from 'node:test';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
const {layoutWorkflowCanvas:layoutWithEngine,workflowCanvasKey,workflowConnectionLabel,workflowTerminalOutcomes,roundedWorkflowPath}=await import('../../apps/web/src/components/branches/canvas-layout.ts');
const ELK=createRequire(new URL('../../apps/web/package.json',import.meta.url))('elkjs/lib/elk.bundled.js'),engine=new ELK();
const layoutWorkflowCanvas=(definition,bindings,measurements={},context={})=>layoutWithEngine(definition,bindings,measurements,context,engine);
const script=id=>({id,label:id,kind:'script',runtime:'node',source:'process.stdout.write("done")',cwdRef:'workspace',timeoutMs:1000});
const edge=(id,from,to,on='success',extra={})=>({id,from,to,on,...extra});
const graph=(steps,controls=[],edges=[],entry=steps[0]?.id??controls[0]?.id??'')=>({schema:'ponderosa.branch.v1',name:'Canvas test',trigger:{kind:'manual'},entry,steps,controls,edges,policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}});
const bindings={agents:{},directories:{workspace:'/unused'}};
const overlaps=(a,b)=>a.x<b.x+b.width-.01&&a.x+a.width>b.x+.01&&a.y<b.y+b.height-.01&&a.y+a.height>b.y+.01;
const crosses=(a,b,box)=>Math.abs(a.x-b.x)<.01?a.x>box.x+.01&&a.x<box.x+box.width-.01&&Math.max(a.y,b.y)>box.y+.01&&Math.min(a.y,b.y)<box.y+box.height-.01:Math.abs(a.y-b.y)<.01?a.y>box.y+.01&&a.y<box.y+box.height-.01&&Math.max(a.x,b.x)>box.x+.01&&Math.min(a.x,b.x)<box.x+box.width-.01:false;
const onSegment=(p,a,b)=>Math.abs(a.x-b.x)<.01?Math.abs(p.x-a.x)<.01&&p.y>=Math.min(a.y,b.y)-.01&&p.y<=Math.max(a.y,b.y)+.01:Math.abs(a.y-b.y)<.01&&Math.abs(p.y-a.y)<.01&&p.x>=Math.min(a.x,b.x)-.01&&p.x<=Math.max(a.x,b.x)+.01;
const inside=(p,box)=>p.x>box.x+.01&&p.x<box.x+box.width-.01&&p.y>box.y+.01&&p.y<box.y+box.height-.01;
function samplePath(path){
 const tokens=path.match(/[MLQ]|-?(?:\d*\.)?\d+(?:e[+-]?\d+)?/gi)??[],points=[];let current;
 for(let i=0;i<tokens.length;){
  const command=tokens[i++],numbers=Array.from({length:command==='Q'?4:2},()=>Number(tokens[i++])),end={x:numbers.at(-2),y:numbers.at(-1)};
  if(command==='M'){current=end;points.push(end);continue;}
  for(let j=1;j<=24;j++){const t=j/24,u=1-t;points.push(command==='Q'?{x:u*u*current.x+2*u*t*numbers[0]+t*t*end.x,y:u*u*current.y+2*u*t*numbers[1]+t*t*end.y}:{x:current.x+(end.x-current.x)*t,y:current.y+(end.y-current.y)*t});}
  current=end;
 }
 return points;
}
function assertGeometry(layout){
 for(const node of layout.nodes){assert.ok(Number.isFinite(node.x)&&Number.isFinite(node.y),`Position is finite: ${node.id}`);for(const other of layout.nodes)if(other.id!==node.id)assert.ok(!overlaps(node,other),`Cards do not overlap: ${node.id}, ${other.id}`);}
 const boxes=layout.edges.flatMap(e=>[{...e.labelBox,id:e.id+':label'},...(e.insertionAvailable?[{...e.insertion,id:e.id+':insert'}]:[])]);
 for(const edge of layout.edges)if(edge.insertionAvailable){
  const point={x:edge.insertion.x+edge.insertion.width/2,y:edge.insertion.y+edge.insertion.height/2};
  assert.ok(edge.sections.some(section=>section.some((end,i)=>i>0&&onSegment(point,section[i-1],end))),`Insertion center follows its ELK connection: ${edge.id}`);
  for(const other of layout.edges)if(!other.unresolved)assert.ok(!overlaps(edge.insertion,{x:other.labelBox.x-16,y:other.labelBox.y-16,width:other.labelBox.width+32,height:other.labelBox.height+32}),`Insertion has 16px text clearance: ${edge.id}`);
 }
 for(const edge of layout.edges)for(const point of samplePath(roundedWorkflowPath(edge.sections))){
  for(const node of layout.nodes)assert.ok(!inside(point,node),`Rounded connection ${edge.id} clears card ${node.id}`);
  for(const other of layout.edges){if(!other.unresolved)assert.ok(!inside(point,other.labelBox),`Rounded connection ${edge.id} clears label ${other.id}`);if(other!==edge&&other.insertionAvailable)assert.ok(!inside(point,other.insertion),`Rounded connection ${edge.id} clears insertion ${other.id}`);}
 }
 for(const box of boxes){for(const node of layout.nodes)assert.ok(!overlaps(box,node),`${box.id} clears ${node.id}`);for(const other of boxes)if(other.id!==box.id)assert.ok(!overlaps(box,other),`${box.id} clears ${other.id}`);}
 for(const e of layout.edges){assert.ok(e.sections.length,`Canonical route is laid out: ${e.id}`);for(const points of e.sections)for(let i=1;i<points.length;i++){
  const a=points[i-1],b=points[i];assert.ok(Math.abs(a.x-b.x)<.01||Math.abs(a.y-b.y)<.01,`Orthogonal routing for ${e.id}`);
  for(const node of layout.nodes)assert.ok(!crosses(a,b,node),`Connection ${e.id} routes outside card ${node.id}`);
  for(const box of boxes)if(box.id!==e.id+':insert')assert.ok(!crosses(a,b,box),`Connection ${e.id} clears ${box.id}`);
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
 for(const id of ['again','self']){const e=layout.edges.find(e=>e.id===id);assert.equal(e.loop,true);assert.equal(e.label,'Return — Failure Path');assert.ok(e.sections.some(points=>points.length>2));assert.ok(layout.nodes.find(n=>n.id===e.source).ports.some(port=>port.id===e.sourcePort&&port.side==='EAST'));}
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


test('alternative success and failure paths occupy ordered lanes beneath their origin with independent real endings',async()=>{
 const d=graph([script('start'),script('ok'),script('failed')],[],[edge('ok-route','start','ok'),edge('failure-route','start','failed','failure')]);
 const layout=await layoutWorkflowCanvas(d,bindings),start=layout.nodes.find(n=>n.id==='start'),ok=layout.nodes.find(n=>n.id==='ok'),failed=layout.nodes.find(n=>n.id==='failed');
 assert.equal(start.width,320);assert.equal(start.height,128);assert.ok(ok.y>start.y+start.height&&failed.y>start.y+start.height);
 assert.ok(ok.x+ok.width+99<=failed.x,'Success is the left lane; Failure is separate on the right');
 assert.equal(layout.edges.find(e=>e.id==='ok-route').label,'Success Path');assert.equal(layout.edges.find(e=>e.id==='failure-route').label,'Failure Path');
 assert.deepEqual(layout.nodes.filter(n=>n.terminal).map(n=>n.terminal.from).sort(),['failed','ok']);
 assert.ok(layout.nodes.filter(n=>n.terminal).every(n=>n.width===200&&n.height===64));assert.ok(layout.edges.every(e=>e.insertionAvailable));assertGeometry(layout);
});

test('Parallel Paths follows the paired Join input order without duplicating a reconnecting destination',async()=>{
 const controls=[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['to-z','to-a']}];
 const d=graph([script('a'),script('z')],controls,[edge('to-a','fork','a','selected'),edge('to-z','fork','z','selected'),edge('a-in','a','join'),edge('z-in','z','join')],'fork'),layout=await layoutWorkflowCanvas(d,bindings);
 assert.ok(layout.nodes.find(n=>n.id==='z').x<layout.nodes.find(n=>n.id==='a').x);
 assert.equal(layout.nodes.filter(n=>n.id==='join').length,1);assertGeometry(layout);
});

test('rounded connectors retain separate ELK sections and bound short or degenerate corner radii',()=>{
 assert.equal(roundedWorkflowPath([]),'');assert.equal(roundedWorkflowPath([[{x:1,y:2},{x:1,y:2}]]),'M 1 2');
 assert.equal(roundedWorkflowPath([[{x:0,y:0},{x:0,y:100},{x:100,y:100}],[{x:200,y:0},{x:200,y:8},{x:210,y:8}]]),'M 0 0 L 0 88 Q 0 100 12 100 L 100 100 M 200 0 L 200 4 Q 200 8 204 8 L 210 8');
 const path=roundedWorkflowPath([[{x:0,y:0},{x:0,y:0},{x:0,y:8},{x:0,y:8},{x:6,y:8},{x:6,y:8}]]);
 assert.equal(path,'M 0 0 L 0 5 Q 0 8 3 8 L 6 8');assert.ok(!/NaN|Infinity/.test(path));
 assert.equal(roundedWorkflowPath([[{x:0,y:0},{x:0,y:8},{x:0,y:16}]]),'M 0 0 L 0 8 L 0 16');
});

test('unsafe insertion anchors fall back visibly rather than overlap or alter ELK geometry',async()=>{
 const d=graph([script('a'),script('b')],[],[edge('route','a','b')]);
 const tightEngine={layout:async graph=>({...graph,width:400,height:300,children:graph.children.map((node,i)=>({...node,x:20,y:i*130+20})),edges:graph.edges.map(item=>({...item,sections:[{id:item.id,startPoint:{x:180,y:148},endPoint:{x:180,y:150}}],labels:item.labels.map(label=>({...label,x:200,y:145}))}))})};
 const layout=await layoutWithEngine(d,bindings,{}, {},tightEngine);
 assert.ok(layout.edges.every(e=>!e.insertionAvailable));assert.deepEqual(layout.edges[0].sections,[[{x:180,y:148},{x:180,y:150}]]);
});
