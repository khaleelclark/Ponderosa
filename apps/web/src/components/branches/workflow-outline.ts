import type {BranchDefinition} from '@ponderosa/core';
import {workflowTerminalOutcomes} from './canvas-layout.js';
import {nodeName,workflowGraphLevels,type WorkflowNode} from './model.js';
import type {GuidedInsertionTarget} from './guided-operations.js';

type Connection = BranchDefinition['edges'][number];
type Path = {
 key:string;
 label:string;
 to?:string;
 loop?:boolean;
 secondary:boolean;
 target:GuidedInsertionTarget;
};
export type OutlineItem =
 | {kind:'step';node:WorkflowNode;paths:Path[]}
 | {kind:'path';path:Path;items:OutlineItem[]}
 | {kind:'link';id:string;label:string}
 | {kind:'missing'}
 | {kind:'unconnected';items:OutlineItem[]};

export function workflowPaths(definition:BranchDefinition):Map<string,Path[]> {
 const nodes=new Map([...definition.steps,...definition.controls].map(node=>[node.id,node]));
 const terminals=workflowTerminalOutcomes(definition);
 return new Map([...nodes.values()].map(node=>{
  const join='joinId' in node?nodes.get(node.joinId):undefined;
  const edges=definition.edges.filter(edge=>edge.from===node.id);
  if(node.kind==='fork'&&join?.kind==='join'){
   const order=new Map(join.inputOrder.map((id,index)=>[id,index]));
   edges.sort((a,b)=>(order.get(a.id)??Infinity)-(order.get(b.id)??Infinity));
  }
  const label=(on:Connection['on'],index:number,choice?:string)=>{
   if(node.kind==='fork')return `Path ${index+1}`;
   if(node.kind==='map')return 'Each item';
   if(node.kind==='route')return on==='failure'?'Otherwise':choice||'Unnamed route';
   if(node.kind==='condition')return on==='failure'?'Otherwise':'If it matches';
   return {success:'On success',failure:'On failure',selected:'Selected',approved:'If approved',rejected:'If rejected',canceled:'If canceled'}[on];
  };
  const paths:Path[]=[
   ...edges.map((edge,index):Path=>({key:edge.id,label:label(edge.on,index,edge.choice),to:edge.to,loop:edge.loop,secondary:['failure','rejected','canceled'].includes(edge.on),target:{kind:'edge',edgeId:edge.id}})),
   ...terminals.filter(terminal=>terminal.from===node.id).map(({on}):Path=>({key:`end:${node.id}:${on}`,label:label(on,0),secondary:on!=='success'&&on!=='approved',target:{kind:'terminal',nodeId:node.id,on}}))
  ];
  paths.sort((a,b)=>Number(a.secondary)-Number(b.secondary));
  return [node.id,paths];
 }));
}

export function workflowOutline(definition:BranchDefinition):OutlineItem[] {
 const nodes=new Map([...definition.steps,...definition.controls].map(node=>[node.id,node]));
 const pathsByNode=workflowPaths(definition);
 const rendered=new Set<string>(),levels=workflowGraphLevels(definition);
 const link=(id:string,prefix:string):OutlineItem=>({kind:'link',id,label:`${prefix} ${nodeName(nodes.get(id)!)}`});
 const visitPath=(path:Path,stops:Map<string,string>):OutlineItem[]=>{
  if(path.target.kind==='terminal')return [];
  if(!path.to||!nodes.has(path.to))return [{kind:'missing'}];
  if(path.loop)return [link(path.to,'Loop to')];
  return visit(path.to,stops);
 };
 const reachable=(path:Path,stops:Map<string,string>):Set<string>=>{
  const seen=new Set<string>(),pending=path.loop?[]:[path.to];
  while(pending.length){
   const id=pending.pop();
   if(!id||!nodes.has(id)||seen.has(id)||stops.has(id))continue;
   seen.add(id);
   for(const next of pathsByNode.get(id)!)if(!next.loop)pending.push(next.to);
  }
  return seen;
 };
 function visit(id:string,stops:Map<string,string>):OutlineItem[]{
  if(stops.has(id)||rendered.has(id))return [link(id,stops.get(id)??'Continue at')];
  const node=nodes.get(id)!,paths=pathsByNode.get(id)!;
  rendered.add(id);
  const items:OutlineItem[]=[{kind:'step',node,paths}];
  const joinId='joinId' in node&&nodes.has(node.joinId)?node.joinId:undefined;
  const grouped=paths.length>1||joinId||node.kind==='condition'||node.kind==='route';
  if(!grouped){
   if(paths[0])items.push(...visitPath(paths[0],stops));
   return items;
  }

  // Emit converging steps after the paths that reach them so each step has one row.
  const boundaries=new Map(stops);
  if(joinId)boundaries.set(joinId,'Rejoin at');
  const continuation=new Map(boundaries);
  const reached=new Set<string>(),shared=new Set<string>();
  for(const path of paths)for(const target of reachable(path,boundaries)){
   if(reached.has(target))shared.add(target);
   reached.add(target);
  }
  for(const target of shared)boundaries.set(target,'Continue at');
  const branches=paths.map(path=>({kind:'path' as const,path,items:visitPath(path,boundaries)}));
  const straight=!joinId&&node.kind!=='condition'&&node.kind!=='route'&&branches.find(({path,items})=>items[0]?.kind==='step'&&(
   path.label==='On success'||(path.label==='If approved'&&paths.every(other=>other===path||other.target.kind==='terminal'))
  ));
  for(const branch of branches)if(branch!==straight)items.push(branch);
  if(straight)items.push(...straight.items);
  const incoming=new Map([...shared].map(target=>[target,0]));
  for(const target of shared)for(const path of pathsByNode.get(target)!){
   if(path.to&&!path.loop&&shared.has(path.to))incoming.set(path.to,incoming.get(path.to)!+1);
  }
  for(const [target,count] of incoming){
   const node=nodes.get(target);
   if(count>1&&!(node?.kind==='join'&&shared.has(node.forkId)))continuation.set(target,'Continue at');
  }
  for(const target of [...shared].sort((a,b)=>(levels.get(a)??0)-(levels.get(b)??0))){
   continuation.delete(target);
   if(!rendered.has(target))items.push(...visit(target,continuation));
  }
  if(joinId)items.push(...visit(joinId,stops));
  return items;
 }
 const items=nodes.has(definition.entry)?visit(definition.entry,new Map()):[];
 const unconnected:OutlineItem[]=[];
 for(const id of nodes.keys())if(!rendered.has(id))unconnected.push(...visit(id,new Map()));
 if(unconnected.length)items.push({kind:'unconnected',items:unconnected});
 return items;
}
