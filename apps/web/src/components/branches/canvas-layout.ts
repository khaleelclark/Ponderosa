import type {ElkExtendedEdge,ElkNode} from 'elkjs/lib/elk-api.js';
import type {BranchBindings,BranchDefinition} from '@ponderosa/core';

type WorkflowNode=BranchDefinition['steps'][number]|BranchDefinition['controls'][number];
type WorkflowEdge=BranchDefinition['edges'][number];
export type CanvasPoint={x:number;y:number};
export type CanvasSize={width:number;height:number};
export type CanvasBox=CanvasPoint&CanvasSize;
export type CanvasTerminal={from:string;on:WorkflowEdge['on']};
export type CanvasMeasurements={nodes?:Record<string,CanvasSize>;labels?:Record<string,CanvasSize>};
export type CanvasPort=CanvasPoint&{id:string;side:'NORTH'|'SOUTH'|'EAST'};
export type CanvasLayoutNode=CanvasBox&{
 id:string;kind:'workflow'|'terminal';workflowNodeId?:string;terminal?:CanvasTerminal;context?:string;ports:CanvasPort[];
};
export type CanvasLayoutEdge={
 id:string;canonicalEdgeId?:string;source:string;target:string;sourcePort:string;targetPort:string;
 on:WorkflowEdge['on'];choice?:string;loop:boolean;label:string;sections:CanvasPoint[][];
 labelBox:CanvasBox;insertion:CanvasBox;insertionAvailable:boolean;terminal?:CanvasTerminal;unresolved?:boolean;
};
export type CanvasLayoutGroup={id:string;kind:'parallel'|'for_each';label:string;forkId:string;joinId:string;nodeIds:string[]};
export type CanvasLayout={key:string;width:number;height:number;nodes:CanvasLayoutNode[];edges:CanvasLayoutEdge[];groups:CanvasLayoutGroup[]};

const order=(a:string,b:string)=>a<b?-1:a>b?1:0;
const size=(value:CanvasSize|undefined,fallback:CanvasSize):CanvasSize=>value&&Number.isFinite(value.width)&&value.width>0&&Number.isFinite(value.height)&&value.height>0?{width:value.width,height:value.height}:fallback;
const nodeSize={width:320,height:128},terminalSize={width:200,height:64},labelSize={width:160,height:32};
const insertionSize=44;
const terminalId=(nodeId:string,on:WorkflowEdge['on'])=>`canvas:terminal:${encodeURIComponent(JSON.stringify([nodeId,on]))}`;

/** Display only outcomes that genuinely terminate; failure policies do not create routes. */
export function workflowTerminalOutcomes(definition:BranchDefinition):CanvasTerminal[]{
 return [...definition.steps,...definition.controls].flatMap(node=>{
  const outcomes:WorkflowEdge['on'][]=node.kind==='human_gate'?['approved','rejected']:['condition','route','fork','map'].includes(node.kind)?[]:['success'];
  if(node.kind==='branch_call'&&node.canceled==='terminate')outcomes.push('canceled');
  return outcomes.filter(on=>!definition.edges.some(edge=>edge.from===node.id&&edge.on===on)).map(on=>({from:node.id,on}));
 });
}

export function workflowConnectionLabel(definition:BranchDefinition,edge:Pick<WorkflowEdge,'from'|'on'|'choice'|'loop'>):string{
 const source=definition.controls.find(node=>node.id===edge.from),hasFailureRoute=definition.edges.some(item=>item.from===edge.from&&item.on==='failure');
 const outcome=edge.choice??((source?.kind==='condition'||source?.kind==='route')&&edge.on==='failure'?'Otherwise':source?.kind==='condition'&&edge.on==='selected'?'Matches':source?.kind==='fork'&&edge.on==='selected'?'Parallel Path':source?.kind==='map'&&edge.on==='selected'?'Each Item':({success:hasFailureRoute?'Success Path':'Success',failure:hasFailureRoute?'Failure Path':'Failure',approved:'Approved',rejected:'Rejected',selected:'Selected',canceled:'Canceled'}[edge.on]));
 return edge.loop?`Return — ${outcome}`:outcome;
}

function nodeContext(node:WorkflowNode,definition:BranchDefinition,bindings:BranchBindings,context:Record<string,string>):string|undefined{
 if(context[node.id]!==undefined)return context[node.id];
 if(node.kind==='agent'){
  if('ref'in node.target)return bindings.agents[node.target.ref]??'Select Agent';
  const template=definition.templates?.[node.target.templateRef];
  return template?.agents.find(member=>member.ref===template.rootRef)?.title??(node.target.kind==='ephemeral_organization'?'Temporary Organization':'Temporary Agent');
 }
 if(node.kind==='fork')return 'All Paths Run';
 if(node.kind==='map')return 'Each Item';
 if(node.kind==='join')return node.mode==='all'?'Wait for All':node.mode==='any'?'Wait for Any':`Wait for ${node.quorum??'Quorum'}`;
 return undefined;
}

/** Instruction text and viewport/selection are deliberately outside the layout projection. */
export function workflowCanvasKey(definition:BranchDefinition,bindings:BranchBindings,measurements:CanvasMeasurements={},context:Record<string,string>={}):string{
 const nodes=[...definition.steps,...definition.controls].sort((a,b)=>order(a.id,b.id));
 return JSON.stringify({entry:definition.entry,nodes:nodes.map(node=>({id:node.id,kind:node.kind,...(node.kind==='agent'?{targetKind:node.target.kind}:{}),label:node.label??node.id,context:nodeContext(node,definition,bindings,context),size:size(measurements.nodes?.[node.id],nodeSize),...('joinId'in node?{joinId:node.joinId}:{}),...('workerId'in node?{workerId:node.workerId}:{}),...(node.kind==='join'?{forkId:node.forkId,inputOrder:node.inputOrder}:{}),...('otherwise'in node?{otherwise:node.otherwise}:{})})),edges:definition.edges.slice().sort((a,b)=>order(a.id,b.id)).map(edge=>({id:edge.id,from:edge.from,to:edge.to,on:edge.on,choice:edge.choice,loop:edge.loop,label:workflowConnectionLabel(definition,edge),size:size(measurements.labels?.[edge.id],labelSize)})),terminals:workflowTerminalOutcomes(definition).sort((a,b)=>order(a.from,b.from)||order(a.on,b.on)).map(terminal=>({terminal,size:size(measurements.nodes?.[terminalId(terminal.from,terminal.on)],terminalSize),labelSize:size(measurements.labels?.[terminalId(terminal.from,terminal.on)],labelSize)}))});
}

/** Membership is a graph projection, not ownership: a shared card can belong to nested groups once. */
function groups(definition:BranchDefinition):CanvasLayoutGroup[]{
 const ids=new Set([...definition.steps,...definition.controls].map(node=>node.id));
 return definition.controls.flatMap(control=>{
  if(control.kind!=='fork'&&control.kind!=='map')return [];
  const members=new Set([control.id]),pending=[control.id];
  for(let i=0;i<pending.length;i++)for(const edge of definition.edges){
   if(edge.from!==pending[i]||edge.loop||!ids.has(edge.to)||members.has(edge.to))continue;
   members.add(edge.to);if(edge.to!==control.joinId)pending.push(edge.to);
  }
  if(ids.has(control.joinId))members.add(control.joinId);
  return [{id:`canvas:group:${control.id}`,kind:control.kind==='fork'?'parallel' as const:'for_each' as const,label:control.kind==='fork'?'Parallel Paths — All Paths Run':'For Each — Each Item',forkId:control.id,joinId:control.joinId,nodeIds:[...members].sort(order)}];
 });
}

/** ELK owns positions, orthogonal routing and text-label clearance; canonical objects never enter it. */
export async function layoutWorkflowCanvas(definition:BranchDefinition,bindings:BranchBindings,measurements:CanvasMeasurements={},context:Record<string,string>={},engine:Pick<import('elkjs/lib/elk-api.js').ELK,'layout'>):Promise<CanvasLayout>{
 const key=workflowCanvasKey(definition,bindings,measurements,context),canonicalNodes=[...definition.steps,...definition.controls].sort((a,b)=>Number(b.id===definition.entry)-Number(a.id===definition.entry)||order(a.id,b.id));
 const nodes:CanvasLayoutNode[]=canonicalNodes.map(node=>({id:node.id,kind:'workflow',workflowNodeId:node.id,x:0,y:0,...size(measurements.nodes?.[node.id],nodeSize),context:nodeContext(node,definition,bindings,context),ports:[]}));
 const edges:CanvasLayoutEdge[]=definition.edges.slice().sort((a,b)=>{
  const source=definition.controls.find(control=>control.id===a.from),join=source?.kind==='fork'?definition.controls.find(control=>control.id===source.joinId):undefined;
  return order(a.from,b.from)||(join?.kind==='join'?join.inputOrder.indexOf(a.id)-join.inputOrder.indexOf(b.id):0)||order(a.id,b.id);
 }).map(edge=>({id:edge.id,canonicalEdgeId:edge.id,source:edge.from,target:edge.to,sourcePort:`canvas:out:${edge.id}`,targetPort:`canvas:in:${edge.id}`,on:edge.on,choice:edge.choice,loop:Boolean(edge.loop),label:workflowConnectionLabel(definition,edge),sections:[],labelBox:{x:0,y:0,...size(measurements.labels?.[edge.id],labelSize)},insertion:{x:0,y:0,width:insertionSize,height:insertionSize},insertionAvailable:false}));
 for(const terminal of workflowTerminalOutcomes(definition).sort((a,b)=>order(a.from,b.from)||order(a.on,b.on))){
  const id=terminalId(terminal.from,terminal.on);
  nodes.push({id,kind:'terminal',terminal,x:0,y:0,...size(measurements.nodes?.[id],terminalSize),ports:[]});
  edges.push({id,source:terminal.from,target:id,sourcePort:`canvas:out:${id}`,targetPort:`canvas:in:${id}`,on:terminal.on,loop:false,label:workflowConnectionLabel(definition,{from:terminal.from,on:terminal.on}),sections:[],labelBox:{x:0,y:0,...size(measurements.labels?.[id],labelSize)},insertion:{x:0,y:0,width:insertionSize,height:insertionSize},insertionAvailable:false,terminal});
 }
 if(!nodes.length)return {key,width:0,height:0,nodes,edges,groups:[]};
 const byId=new Map(nodes.map(node=>[node.id,node]));
 const elkNodes:ElkNode[]=nodes.map(node=>({id:node.id,width:node.width,height:node.height,ports:[],layoutOptions:{'elk.portConstraints':'FIXED_SIDE'}}));
 const elkById=new Map(elkNodes.map(node=>[node.id,node]));
 const elkEdges:ElkExtendedEdge[]=[];
 for(const edge of edges){
  const source=elkById.get(edge.source),target=elkById.get(edge.target);
  if(!source||!target){edge.unresolved=true;continue;}
  const side=edge.loop?'EAST':'SOUTH';
  source.ports!.push({id:edge.sourcePort,width:0,height:0,layoutOptions:{'elk.port.side':side}});
  target.ports!.push({id:edge.targetPort,width:0,height:0,layoutOptions:{'elk.port.side':edge.loop?'EAST':'NORTH'}});
  // Let ELK break declared return edges before ordinary top-to-bottom routes.
  elkEdges.push({id:edge.id,sources:[edge.sourcePort],targets:[edge.targetPort],layoutOptions:{'elk.layered.priority.direction':edge.loop?'0':String(edges.length+1)},labels:[{id:`canvas:label:${edge.id}`,text:edge.label,width:edge.labelBox.width,height:edge.labelBox.height,layoutOptions:{'elk.edgeLabels.placement':'CENTER','elk.edgeLabels.inline':'false'}}]});
 }
 // Fix only branching origins' output order; ordinary destinations remain free to avoid crossings.
 const edgeByPort=new Map(edges.flatMap(edge=>[[edge.sourcePort,edge] as const,[edge.targetPort,edge] as const]));
 for(const node of elkNodes){
  const outgoing=edges.filter(edge=>edge.source===node.id&&!edge.loop);
  if(outgoing.length<2)continue;
  const control=definition.controls.find(item=>item.id===node.id),join=control?.kind==='fork'?definition.controls.find(item=>item.id===control.joinId):undefined;
  const rank=(edge:CanvasLayoutEdge)=>join?.kind==='join'?join.inputOrder.indexOf(edge.id):edge.on==='failure'||edge.on==='rejected'?1:edge.on==='canceled'?2:0;
  const south=node.ports!.filter(port=>port.layoutOptions?.['elk.port.side']==='SOUTH').sort((a,b)=>{const ea=edgeByPort.get(a.id)!,eb=edgeByPort.get(b.id)!;return rank(ea)-rank(eb)||order(ea.choice??ea.id,eb.choice??eb.id)});
  // ELK indexes clockwise: SOUTH is right-to-left, so reverse the requested reading order.
  node.ports=[...node.ports!.filter(port=>port.layoutOptions?.['elk.port.side']==='NORTH'),...node.ports!.filter(port=>port.layoutOptions?.['elk.port.side']==='EAST'),...south.reverse()];
  node.layoutOptions!['elk.portConstraints']='FIXED_ORDER';
  node.ports.forEach((port,index)=>{port.layoutOptions!['elk.port.index']=String(index)});
 }
 const graph:ElkNode=await engine.layout({id:'canvas:root',children:elkNodes,edges:elkEdges,layoutOptions:{'elk.algorithm':'layered','elk.direction':'DOWN','elk.edgeRouting':'ORTHOGONAL','elk.layered.nodePlacement.favorStraightEdges':'false','elk.layered.nodePlacement.bk.fixedAlignment':'BALANCED','elk.randomSeed':'1','elk.padding':'[top=28,left=28,bottom=28,right=28]','elk.spacing.nodeNode':'100','elk.spacing.nodeSelfLoop':'64','elk.spacing.edgeNode':'28','elk.spacing.edgeEdge':'60','elk.spacing.edgeLabel':'40','elk.spacing.labelLabel':'16','elk.spacing.labelNode':'24','elk.layered.spacing.nodeNodeBetweenLayers':'48','elk.layered.spacing.edgeNodeBetweenLayers':'32','elk.layered.spacing.edgeEdgeBetweenLayers':'60','elk.layered.considerModelOrder.strategy':'NODES_AND_EDGES','elk.layered.feedbackEdges':'true','elk.layered.mergeEdges':'false','elk.layered.mergeHierarchyEdges':'false'}});
 for(const child of graph.children??[]){
  const node=byId.get(child.id)!;node.x=child.x??0;node.y=child.y??0;
  node.ports=(child.ports??[]).map(port=>({id:port.id,x:port.x??0,y:port.y??0,side:(port.layoutOptions?.['elk.port.side']??'NORTH') as CanvasPort['side']}));
 }
 const edgeById=new Map(edges.map(edge=>[edge.id,edge]));
 for(const result of graph.edges??[]){
  const edge=edgeById.get(result.id)!;
  edge.sections=(result.sections??[]).map(section=>[section.startPoint,...(section.bendPoints??[]),section.endPoint].map(point=>({x:point.x,y:point.y})));
  const box=result.labels?.find(label=>label.id===`canvas:label:${edge.id}`);
  edge.labelBox.x=box?.x??0;edge.labelBox.y=box?.y??0;
 }
 placeInsertionControls(nodes,edges);
 return {key,width:graph.width??0,height:graph.height??0,nodes,edges,groups:groups(definition)};
}

const overlaps=(a:CanvasBox,b:CanvasBox,gap=0)=>a.x<b.x+b.width+gap-.01&&a.x+a.width>b.x-gap+.01&&a.y<b.y+b.height+gap-.01&&a.y+a.height>b.y-gap+.01;
const crosses=(a:CanvasPoint,b:CanvasPoint,box:CanvasBox)=>Math.abs(a.x-b.x)<.01?a.x>box.x+.01&&a.x<box.x+box.width-.01&&Math.max(a.y,b.y)>box.y+.01&&Math.min(a.y,b.y)<box.y+box.height-.01:Math.abs(a.y-b.y)<.01?a.y>box.y+.01&&a.y<box.y+box.height-.01&&Math.max(a.x,b.x)>box.x+.01&&Math.min(a.x,b.x)<box.x+box.width-.01:false;

/** Query a fixed four points per existing ELK segment; never move a route, label or card.
 * If none is safe, the selected-connection action remains available outside the graph. */
function placeInsertionControls(nodes:CanvasLayoutNode[],edges:CanvasLayoutEdge[]):void{
 const placed:CanvasBox[]=[];
 for(const edge of edges){
  if(edge.unresolved)continue;
  const center={x:edge.labelBox.x+edge.labelBox.width/2,y:edge.labelBox.y+edge.labelBox.height/2};
  const candidates:CanvasPoint[]=[];
  for(const section of edge.sections)for(let i=1;i<section.length;i++){
   const a=section[i-1]!,b=section[i]!,vertical=Math.abs(a.x-b.x)<.01,horizontal=Math.abs(a.y-b.y)<.01;
   if(!vertical&&!horizontal)continue;
   const start=vertical?a.y:a.x,end=vertical?b.y:b.x,lo=Math.min(start,end),hi=Math.max(start,end);
   if(hi-lo<24)continue;
   // Keep the center on a straight leg after the renderer rounds up to 12px at each corner.
   const clamp=(value:number)=>Math.max(lo+12,Math.min(hi-12,value));
   for(const value of [clamp(vertical?center.y:center.x),(lo+hi)/2,clamp(lo+insertionSize/2),clamp(hi-insertionSize/2)])candidates.push(vertical?{x:a.x,y:value}:{x:value,y:a.y});
  }
  candidates.sort((a,b)=>Math.hypot(a.x-center.x,a.y-center.y)-Math.hypot(b.x-center.x,b.y-center.y)||a.y-b.y||a.x-b.x);
  for(const point of candidates){
   const box={x:point.x-insertionSize/2,y:point.y-insertionSize/2,width:insertionSize,height:insertionSize};
   if(nodes.some(node=>overlaps(box,node,16))||edges.some(other=>!other.unresolved&&overlaps(box,other.labelBox,16))||placed.some(other=>overlaps(box,other,12)))continue;
   if(edges.some(other=>other!==edge&&other.sections.some(section=>section.some((end,i)=>i>0&&crosses(section[i-1]!,end,box)))))continue;
   edge.insertion=box;edge.insertionAvailable=true;placed.push(box);break;
  }
 }
}

/** Round only existing ELK orthogonal corners; keep every section and the obstacle-avoiding route. */
export function roundedWorkflowPath(sections:CanvasPoint[][]):string{
 const paths:string[]=[];
 for(const section of sections){
  const points=section.filter((point,i)=>i===0||Math.hypot(point.x-section[i-1]!.x,point.y-section[i-1]!.y)>.001);
  if(!points.length)continue;
  let path=`M ${points[0]!.x} ${points[0]!.y}`;
  for(let i=1;i<points.length-1;i++){
   const a=points[i-1]!,b=points[i]!,c=points[i+1]!,incoming=Math.hypot(b.x-a.x,b.y-a.y),outgoing=Math.hypot(c.x-b.x,c.y-b.y);
   if(Math.abs((b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x))<.001){path+=` L ${b.x} ${b.y}`;continue;}
   const radius=Math.min(12,incoming/2,outgoing/2),enter={x:b.x+(a.x-b.x)*radius/incoming,y:b.y+(a.y-b.y)*radius/incoming},leave={x:b.x+(c.x-b.x)*radius/outgoing,y:b.y+(c.y-b.y)*radius/outgoing};
   path+=` L ${enter.x} ${enter.y} Q ${b.x} ${b.y} ${leave.x} ${leave.y}`;
  }
  if(points.length>1)path+=` L ${points.at(-1)!.x} ${points.at(-1)!.y}`;
  paths.push(path);
 }
 return paths.join(' ');
}
