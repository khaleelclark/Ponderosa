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
 labelBox:CanvasBox;insertion:CanvasBox;terminal?:CanvasTerminal;unresolved?:boolean;
};
export type CanvasLayoutGroup={id:string;kind:'parallel'|'for_each';label:string;forkId:string;joinId:string;nodeIds:string[]};
export type CanvasLayout={key:string;width:number;height:number;nodes:CanvasLayoutNode[];edges:CanvasLayoutEdge[];groups:CanvasLayoutGroup[]};

const order=(a:string,b:string)=>a<b?-1:a>b?1:0;
const size=(value:CanvasSize|undefined,fallback:CanvasSize):CanvasSize=>value&&Number.isFinite(value.width)&&value.width>0&&Number.isFinite(value.height)&&value.height>0?{width:value.width,height:value.height}:fallback;
const nodeSize={width:240,height:112},terminalSize={width:190,height:60},labelSize={width:160,height:32};
const insertionSize=44,insertionGap=12;
const terminalId=(nodeId:string,on:WorkflowEdge['on'])=>`canvas:terminal:${JSON.stringify([nodeId,on])}`;

/** Display only outcomes that genuinely terminate; failure policies do not create routes. */
export function workflowTerminalOutcomes(definition:BranchDefinition):CanvasTerminal[]{
 return [...definition.steps,...definition.controls].flatMap(node=>{
  const outcomes:WorkflowEdge['on'][]=node.kind==='human_gate'?['approved','rejected']:['condition','route','fork','map'].includes(node.kind)?[]:['success'];
  if(node.kind==='branch_call'&&node.canceled==='terminate')outcomes.push('canceled');
  return outcomes.filter(on=>!definition.edges.some(edge=>edge.from===node.id&&edge.on===on)).map(on=>({from:node.id,on}));
 });
}

export function workflowConnectionLabel(definition:BranchDefinition,edge:Pick<WorkflowEdge,'from'|'on'|'choice'|'loop'>):string{
 const source=definition.controls.find(node=>node.id===edge.from);
 const outcome=edge.choice??((source?.kind==='condition'||source?.kind==='route')&&edge.on==='failure'?'Otherwise':source?.kind==='condition'&&edge.on==='selected'?'Matches':source?.kind==='fork'&&edge.on==='selected'?'Parallel Path':source?.kind==='map'&&edge.on==='selected'?'Each Item':({success:'Success',failure:'Failure',approved:'Approved',rejected:'Rejected',selected:'Selected',canceled:'Canceled'}[edge.on]));
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

/** ELK owns positions, orthogonal routing and label clearance; no canonical object is passed to it. */
export async function layoutWorkflowCanvas(definition:BranchDefinition,bindings:BranchBindings,measurements:CanvasMeasurements={},context:Record<string,string>={}):Promise<CanvasLayout>{
 const key=workflowCanvasKey(definition,bindings,measurements,context),canonicalNodes=[...definition.steps,...definition.controls].sort((a,b)=>Number(b.id===definition.entry)-Number(a.id===definition.entry)||order(a.id,b.id));
 const nodes:CanvasLayoutNode[]=canonicalNodes.map(node=>({id:node.id,kind:'workflow',workflowNodeId:node.id,x:0,y:0,...size(measurements.nodes?.[node.id],nodeSize),context:nodeContext(node,definition,bindings,context),ports:[]}));
 const edges:CanvasLayoutEdge[]=definition.edges.slice().sort((a,b)=>{
  const source=definition.controls.find(control=>control.id===a.from),join=source?.kind==='fork'?definition.controls.find(control=>control.id===source.joinId):undefined;
  return order(a.from,b.from)||(join?.kind==='join'?join.inputOrder.indexOf(a.id)-join.inputOrder.indexOf(b.id):0)||order(a.id,b.id);
 }).map(edge=>({id:edge.id,canonicalEdgeId:edge.id,source:edge.from,target:edge.to,sourcePort:`canvas:out:${edge.id}`,targetPort:`canvas:in:${edge.id}`,on:edge.on,choice:edge.choice,loop:Boolean(edge.loop),label:workflowConnectionLabel(definition,edge),sections:[],labelBox:{x:0,y:0,...size(measurements.labels?.[edge.id],labelSize)},insertion:{x:0,y:0,width:insertionSize,height:insertionSize}}));
 for(const terminal of workflowTerminalOutcomes(definition).sort((a,b)=>order(a.from,b.from)||order(a.on,b.on))){
  const id=terminalId(terminal.from,terminal.on);
  nodes.push({id,kind:'terminal',terminal,x:0,y:0,...size(measurements.nodes?.[id],terminalSize),ports:[]});
  edges.push({id,source:terminal.from,target:id,sourcePort:`canvas:out:${id}`,targetPort:`canvas:in:${id}`,on:terminal.on,loop:false,label:workflowConnectionLabel(definition,{from:terminal.from,on:terminal.on}),sections:[],labelBox:{x:0,y:0,...size(measurements.labels?.[id],labelSize)},insertion:{x:0,y:0,width:insertionSize,height:insertionSize},terminal});
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
  elkEdges.push({id:edge.id,sources:[edge.sourcePort],targets:[edge.targetPort],layoutOptions:{'elk.layered.priority.direction':edge.loop?'0':String(edges.length+1)},labels:[{id:`canvas:label:${edge.id}`,text:edge.label,width:edge.labelBox.width+insertionGap+insertionSize,height:Math.max(edge.labelBox.height,insertionSize),layoutOptions:{'elk.edgeLabels.placement':'CENTER','elk.edgeLabels.inline':'false'}}]});
 }
 const {default:ELK}=await import('elkjs/lib/elk.bundled.js');
 const elk=new ELK();
 const graph:ElkNode=await elk.layout({id:'canvas:root',children:elkNodes,edges:elkEdges,layoutOptions:{'elk.algorithm':'layered','elk.direction':'DOWN','elk.edgeRouting':'ORTHOGONAL','elk.randomSeed':'1','elk.padding':'[top=28,left=28,bottom=28,right=28]','elk.spacing.nodeNode':'72','elk.spacing.edgeNode':'28','elk.spacing.edgeEdge':'24','elk.spacing.edgeLabel':'12','elk.spacing.labelNode':'24','elk.layered.spacing.nodeNodeBetweenLayers':'48','elk.layered.spacing.edgeNodeBetweenLayers':'32','elk.layered.spacing.edgeEdgeBetweenLayers':'24','elk.layered.considerModelOrder.strategy':'NODES_AND_EDGES','elk.layered.feedbackEdges':'true','elk.layered.mergeEdges':'false','elk.layered.mergeHierarchyEdges':'false'}});
 for(const child of graph.children??[]){
  const node=byId.get(child.id)!;node.x=child.x??0;node.y=child.y??0;
  node.ports=(child.ports??[]).map(port=>({id:port.id,x:port.x??0,y:port.y??0,side:(port.layoutOptions?.['elk.port.side']??'NORTH') as CanvasPort['side']}));
 }
 const edgeById=new Map(edges.map(edge=>[edge.id,edge]));
 for(const result of graph.edges??[]){
  const edge=edgeById.get(result.id)!;
  edge.sections=(result.sections??[]).map(section=>[section.startPoint,...(section.bendPoints??[]),section.endPoint].map(point=>({x:point.x,y:point.y})));
  const box=result.labels?.[0];
  edge.labelBox.x=box?.x??0;edge.labelBox.y=(box?.y??0)+((box?.height??edge.labelBox.height)-edge.labelBox.height)/2;
  edge.insertion.x=edge.labelBox.x+edge.labelBox.width+insertionGap;edge.insertion.y=(box?.y??0)+((box?.height??insertionSize)-insertionSize)/2;
 }
 return {key,width:graph.width??0,height:graph.height??0,nodes,edges,groups:groups(definition)};
}
