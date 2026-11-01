import {createHash} from 'node:crypto';
import type {AgentPortablePackageDto,BranchPackageChat,PortableAgentNodeDto,PortablePackageMemoryDto} from '@ponderosa/core';
import {stableJson} from '@ponderosa/agents';
import {rewritePortableArtifactReferences} from './artifact-refs.js';
import {validatePortableAgentPackage} from './portable-agent-package-validation.js';
const identity=(...parts:string[])=>'branch-'+createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Compose authored topology and data; no new manager, permission or native identity. */
export function composeBranchChat(chat:BranchPackageChat):AgentPortablePackageDto {
 const roots=chat.agents.filter(a=>!a.managerRef);
 if(roots.length!==1)throw new Error('Grouped import requires one connected authored organization root');
 const nodes:PortableAgentNodeDto[]=[],memories:PortablePackageMemoryDto[]=[];
 const folders=new Map<string,PortableAgentNodeDto>();
 for(const entry of chat.agents){
  const pkg=entry.definition;validatePortableAgentPackage(pkg);
  const node=structuredClone(pkg.agents[0]!);node.managerRef=entry.managerRef;
  const refs=new Map((node.artifacts??[]).map(a=>[a.ref,identity(chat.ref,node.ref,a.ref)]));
  const mapped=(ref:string)=>{const value=refs.get(ref);if(!value)throw new Error('Grouped artifact reference is unavailable');return value;};
  for(const artifact of node.artifacts??[])artifact.ref=mapped(artifact.ref);
  if(node.initialInstructions!==undefined)node.initialInstructions=rewritePortableArtifactReferences(node.initialInstructions,refs);
  for(const message of node.history??[]){
   message.text=rewritePortableArtifactReferences(message.text,refs);
   if(message.attachmentRefs)message.attachmentRefs=message.attachmentRefs.map(mapped);
   if(message.artifactRefs)message.artifactRefs=Object.fromEntries(Object.entries(message.artifactRefs).map(([source,ref])=>[source,mapped(ref)]));
  }
  for(const file of node.workingFiles??[])file.artifactRef=mapped(file.artifactRef);
  if(node.workingRootRef){
   const root=node.workingCopyMode==='separate_git'?identity(chat.ref,node.ref,'separate'):identity(chat.ref,'shared',node.sourceChat?.ref??chat.ref);
   node.workingRootRef=root;
   const owner=folders.get(root);
   if(!owner)folders.set(root,node);
   else {
    if(!owner.workingFolder||!node.workingFolder||stableJson(owner.workingFolder)!==stableJson(node.workingFolder))throw new Error('Shared folder manifests changed between Agent exports; export again');
    const files=new Map((owner.workingFiles??[]).map(file=>[file.path,file]));
    for(const file of node.workingFiles??[]){
     const original=node.artifacts?.find(a=>a.ref===file.artifactRef);if(!original)throw new Error('Shared working original unavailable');
     const prior=files.get(file.path);
     if(prior){
      const bytes=owner.artifacts?.find(a=>a.ref===prior.artifactRef);
      if(bytes?.dataBase64!==original.dataBase64||prior.mode!==file.mode||prior.mtime!==file.mtime)throw new Error('Shared working files changed between Agent exports; export again');
     }else {
      // Keep the node's historical original; the folder owner needs its own ref.
      const ref=identity(root,file.path,'original');owner.artifacts??=[];owner.artifacts.push({...original,ref});
      const copy={...file,artifactRef:ref};owner.workingFiles??=[];owner.workingFiles.push(copy);files.set(copy.path,copy);
     }
    }
    delete node.workingFolder;delete node.workingFiles;
   }
  }
  nodes.push(node);memories.push(...structuredClone(pkg.memory??[]));
 }
 let memory:PortablePackageMemoryDto[]|undefined;
 if(memories.length){
  const first=memories[0]!,snapshot=structuredClone(first.snapshot),agentRefs:Record<string,string>={};
  const chunks=new Map<string,typeof snapshot.chunks[number]>(),conflicts=new Map<string,typeof snapshot.conflicts[number]>();
  for(const entry of memories){
   if(entry.snapshot.sourceChatId!==snapshot.sourceChatId||entry.snapshot.signature!==snapshot.signature)throw new Error('Grouped memory requires one compatible source Chat');
   for(const [id,ref] of Object.entries(entry.agentRefs)){if(agentRefs[id]&&agentRefs[id]!==ref)throw new Error('Conflicting grouped memory identity');agentRefs[id]=ref;}
   for(const [rows,target] of [[entry.snapshot.chunks,chunks],[entry.snapshot.conflicts,conflicts]] as const)for(const row of rows){const prior=target.get(row.id);if(prior&&stableJson(prior)!==stableJson(row))throw new Error('Grouped memory changed between exports');target.set(row.id,row);}
  }
  snapshot.agentIds=Object.keys(agentRefs).sort();snapshot.chunks=[...chunks.values()];snapshot.conflicts=[...conflicts.values()];memory=[{snapshot,agentRefs}];
 }
 const result:AgentPortablePackageDto={schema:'ponderosa.agent-package.v1',kind:nodes.length===1?'agent':'organization',mode:chat.agents.some(a=>a.definition.mode==='full')?'full':'template',exportedAt:chat.agents[0]!.definition.exportedAt,sourceLabel:chat.title,rootRef:roots[0]!.ref,agents:nodes,...(memory?{memory}:{})};
 validatePortableAgentPackage(result);return result;
}
