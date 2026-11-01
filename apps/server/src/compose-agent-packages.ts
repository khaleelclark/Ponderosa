import {createHash} from 'node:crypto';
import type {AgentPortablePackageDto,PortableAgentNodeDto,PortableArtifactDto,PortablePackageMemoryDto} from '@ponderosa/core';
import {stableJson} from '@ponderosa/agents';
import {validatePortableAgentPackage} from './portable-agent-package-validation.js';
import {rewritePortableArtifactReferences} from './artifact-refs.js';
import {decodePortableArtifact} from './agent-package-codec.js';

export interface AgentPackageCompositionInput {ref:string;managerRef?:string;package:AgentPortablePackageDto}
export interface AgentPackageComposition {
  package:AgentPortablePackageDto;
  orderedRefs:string[];
  artifactRefs:Record<string,Record<string,string>>;
  workingRootRefs:Record<string,string>;
}
const identity=(kind:string,...parts:string[])=>`composed-${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;

/** Pure deterministic composition. Conflicting independently captured snapshots refuse, never win by order. */
export async function composeAgentPackages(inputs:readonly AgentPackageCompositionInput[]):Promise<AgentPackageComposition>{
  if(!inputs.length||new Set(inputs.map(input=>input.ref)).size!==inputs.length)throw new Error('Compose distinct nonempty Agent identities');
  const nodes:PortableAgentNodeDto[]=[],artifactRefs:AgentPackageComposition['artifactRefs']=Object.fromEntries(inputs.map(input=>[input.ref,{}])),workingRootRefs:Record<string,string>=Object.fromEntries(inputs.map(input=>[input.ref,'']));
  const memories=new Map<string,PortablePackageMemoryDto>();
  const sourceChats=new Set<string>();
  const folders=new Map<string,{owner:PortableAgentNodeDto;files:Map<string,{file:NonNullable<PortableAgentNodeDto['workingFiles']>[number];sha256:string}>}>();
  const mode=inputs[0]!.package.mode;
  const instructions=inputs[0]!.package.sourceProjectInstructions;
  for(const input of inputs){
    const pkg=validatePortableAgentPackage(input.package).package;
    if(!input.ref?.trim()||pkg.agents.length!==1||pkg.mode!==mode||pkg.sourceProjectInstructions!==instructions)throw new Error('Compose requires compatible single-Agent packages and Chat instructions');
    const node=structuredClone(pkg.agents[0]!);
    if(node.sourceChat)sourceChats.add(node.sourceChat.ref);
    if(sourceChats.size>1)throw new Error('Compose requires one source Chat');
    const oldRef=node.ref;
    const refs=new Map((node.artifacts??[]).map(artifact=>[artifact.ref,identity('artifact',input.ref,artifact.ref)]));
    artifactRefs[input.ref]=Object.fromEntries(refs);
    for(const artifact of node.artifacts??[])artifact.ref=refs.get(artifact.ref)!;
    const rewrite=(text:string)=>rewritePortableArtifactReferences(text,refs);
    if(node.initialInstructions!==undefined)node.initialInstructions=rewrite(node.initialInstructions);
    if(node.role!==undefined)node.role=rewrite(node.role);
    if(node.presetSnapshot)node.presetSnapshot.guidance=rewrite(node.presetSnapshot.guidance);
    for(const message of node.history??[]){
      message.text=rewrite(message.text);
      if(message.attachmentRefs)message.attachmentRefs=message.attachmentRefs.map(ref=>refs.get(ref)!);
      if(message.artifactRefs)message.artifactRefs=Object.fromEntries(Object.entries(message.artifactRefs).map(([id,ref])=>[id,refs.get(ref)!]));
      // Authored Communication identities remain historical evidence; only portable bindings change.
    }
    for(const file of node.workingFiles??[])file.artifactRef=refs.get(file.artifactRef)!;
    node.ref=input.ref;
    delete node.managerRef;
    if(input.managerRef)node.managerRef=input.managerRef;
    nodes.push(node);
    for(const entry of pkg.memory??[]){
      const incoming=structuredClone(entry);
      incoming.agentRefs=Object.fromEntries(Object.entries(incoming.agentRefs).map(([id,ref])=>{if(ref!==oldRef)throw new Error('Foreign memory Agent binding');return [id,input.ref];}));
      const existing=memories.get(incoming.snapshot.sourceChatId);
      if(!existing){memories.set(incoming.snapshot.sourceChatId,incoming);continue;}
      if(existing.snapshot.signature!==incoming.snapshot.signature)throw new Error('Conflicting memory embedding signatures');
      for(const [id,ref] of Object.entries(incoming.agentRefs)){
        if(Object.hasOwn(existing.agentRefs,id)&&existing.agentRefs[id]!==ref)throw new Error('Conflicting source memory Agent identity');
        Object.defineProperty(existing.agentRefs,id,{value:ref,enumerable:true,writable:true,configurable:true});
      }
      existing.snapshot.agentIds=Object.keys(existing.agentRefs);
      for(const field of ['chunks','conflicts'] as const){
        const rows=new Map(existing.snapshot[field].map(row=>[row.id,row]));
        for(const row of incoming.snapshot[field]){const prior=rows.get(row.id);if(prior&&stableJson(prior)!==stableJson(row))throw new Error('Conflicting captured memory rows; re-export a coherent snapshot');if(!prior){existing.snapshot[field].push(row);rows.set(row.id,row);}}
      }
    }
    const rootKey=node.workingCopyMode==='shared'&&node.sourceChat?identity('root','shared',node.sourceChat.ref):identity('root',input.ref,node.workingRootRef??oldRef);
    workingRootRefs[input.ref]=rootKey;
    if(!node.workingFolder&&!node.workingFiles?.length)continue;
    const previous=folders.get(rootKey);
    const group=previous??{owner:node,files:new Map()};
    if(!previous){folders.set(rootKey,group);node.workingFolder??={directories:[],excludedPaths:[]};}
    else if(node.workingFolder){
      const folder=group.owner.workingFolder!;
      for(const key of ['mode','mtime'] as const){if(folder[key]!==undefined&&node.workingFolder[key]!==undefined&&folder[key]!==node.workingFolder[key])throw new Error('Conflicting captured Shared root metadata');}
      folder.mode??=node.workingFolder.mode;folder.mtime??=node.workingFolder.mtime;
      const directories=new Map(folder.directories.map(dir=>[dir.path,dir]));
      for(const dir of node.workingFolder.directories){const prior=directories.get(dir.path);if(prior&&stableJson(prior)!==stableJson(dir))throw new Error('Conflicting captured Shared directory metadata');if(!prior){folder.directories.push(dir);directories.set(dir.path,dir);}}
      const links=new Map((folder.links??[]).map(link=>[link.path,link]));
      for(const link of node.workingFolder.links??[]){const prior=links.get(link.path);if(prior&&stableJson(prior)!==stableJson(link))throw new Error('Conflicting captured Shared link topology');links.set(link.path,link);}
      if(links.size)folder.links=[...links.values()];
      folder.excludedPaths=[...new Set([...folder.excludedPaths,...node.workingFolder.excludedPaths])];
    }
    for(const file of node.workingFiles??[]){
      const artifact=node.artifacts!.find(candidate=>candidate.ref===file.artifactRef)!;
      const {sha256}=await decodePortableArtifact(artifact.dataBase64);
      const prior=group.files.get(file.path);
      if(prior){if(prior.sha256!==sha256||prior.file.mode!==file.mode||prior.file.mtime!==file.mtime)throw new Error('Conflicting Shared working originals; re-export a coherent snapshot');continue;}
      let merged={...file};
      if(group.owner!==node){
        const copy:PortableArtifactDto={...artifact,ref:identity('working',rootKey,file.path)};
        (group.owner.artifacts??=[]).push(copy);merged={...file,artifactRef:copy.ref};
      }
      group.files.set(file.path,{file:merged,sha256});
    }
    if(group.owner!==node){delete node.workingFolder;delete node.workingFiles;}
  }
  if(folders.size){
    // Every member needs a root manifest, even an otherwise empty distinct root.
    for(const node of nodes){const key=workingRootRefs[node.ref]!;node.workingRootRef=key;if(!folders.has(key)){node.workingFolder={directories:[],excludedPaths:[]};folders.set(key,{owner:node,files:new Map()});}}
    for(const group of folders.values())group.owner.workingFiles=[...group.files.values()].map(value=>value.file);
  }
  const roots=nodes.filter(node=>!node.managerRef).map(node=>node.ref);
  if(!roots.length)throw new Error('Composed Agents need a reporting root');
  const result:AgentPortablePackageDto={schema:'ponderosa.agent-package.v1',mode,kind:nodes.length===1?'agent':'organization',exportedAt:inputs.map(input=>input.package.exportedAt).sort().at(-1)!,sourceLabel:inputs[0]!.package.sourceLabel,rootRef:roots[0]!,...(roots.length>1?{rootRefs:roots}:{}),agents:nodes,...(instructions!==undefined?{sourceProjectInstructions:instructions}:{}),...(memories.size?{memory:[...memories.values()]}:{})};
  const roles=inputs.flatMap(input=>(input.package.outputRoles??[]).map(role=>({...role,ref:input.ref})));
  if(roles.length)result.outputRoles=roles;
  validatePortableAgentPackage(result);
  return {package:result,orderedRefs:nodes.map(node=>node.ref),artifactRefs,workingRootRefs};
}
