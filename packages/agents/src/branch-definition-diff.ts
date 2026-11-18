import type {BranchDefinition,BranchDeploymentPreviewDto} from '@ponderosa/core';
import {stableJson} from './coordination-v3-canonical-json.js';
/** Review the desired definition, without changing live runtime or organization state. */
export function branchDefinitionChanges(before:BranchDefinition|undefined,after:BranchDefinition):BranchDeploymentPreviewDto['operations'] {
 const changes:BranchDeploymentPreviewDto['operations']=[];
 const compare=(resource:string,ref:string,a:unknown,b:unknown)=>{
  if(stableJson(a??null)===stableJson(b??null))return;
  changes.push({resource,ref,kind:a===undefined?'create':b===undefined?'detach':'update',...(a!==undefined?{before:typeof a==='string'?a:JSON.stringify(a,null,2)}:{}),...(b!==undefined?{after:typeof b==='string'?b:JSON.stringify(b,null,2)}:{})});
 };
 const oldNodes=[...(before?.steps??[]),...(before?.controls??[])],newNodes=[...after.steps,...after.controls];
 for(const id of new Set([...oldNodes,...newNodes].map(n=>n.id))){
  const a=oldNodes.find(n=>n.id===id),b=newNodes.find(n=>n.id===id),name=b?.label??a?.label??id;
  if(!a||!b)compare('Step',name,a,b);
  else for(const key of new Set([...Object.keys(a),...Object.keys(b)]))if(key!=='id'){
   const labels:Record<string,string>={source:'Script',instructions:'Agent instructions',predicate:'Condition',target:'Agent target',failure:'Failure policy',branchRef:'Branch dependency',joinId:'Parallel join',inputOrder:'Join input order',label:'Step name'};
   compare(labels[key]??`Step ${key}`,name,(a as unknown as Record<string,unknown>)[key],(b as unknown as Record<string,unknown>)[key]);
  }
 }
 const nodeName=(id:string)=>newNodes.find(n=>n.id===id)?.label??oldNodes.find(n=>n.id===id)?.label??id;
 for(const id of new Set([...(before?.edges??[]),...after.edges].map(e=>e.id))){const a=before?.edges.find(e=>e.id===id),b=after.edges.find(e=>e.id===id),edge=b??a!;compare('Path',`${nodeName(edge.from)} → ${nodeName(edge.to)}`,a,b);}
 compare('Workflow name',after.name,before?.name,after.name);
 compare('Entry Step',nodeName(after.entry),before?.entry,after.entry);
 compare('Trigger','Primary trigger',before?.trigger,after.trigger);
 compare('Parameters','Parameter definitions',before?.parameters,after.parameters);
 compare('Execution settings','Concurrency, limits and failure policy',before?.policy,after.policy);
 compare('Agent templates','Temporary organization definitions',before?.templates,after.templates);
 return changes;
}
