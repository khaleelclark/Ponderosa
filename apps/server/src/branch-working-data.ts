import {createHash} from 'node:crypto';
import {stableJsonParts} from '@ponderosa/agents/canonical-json';
import {AGENT_PACKAGE_MAX_BYTES,workingFileArtifactRefs,type AgentPortablePackageDto,type BranchPackageChat,type BranchPortableWorkingData} from '@ponderosa/core';
import {validatePortableAgentPackage} from './portable-agent-package-validation.js';

export function branchWorkingDataHash(value:Omit<BranchPortableWorkingData,'sha256'>):string{
 const hash=createHash('sha256');for(const part of stableJsonParts(value,{maxDepth:64,maxNodes:AGENT_PACKAGE_MAX_BYTES}))hash.update(part);return hash.digest('hex');
}
export function createBranchWorkingData(pkg:AgentPortablePackageDto,owners:BranchPortableWorkingData['owners']):BranchPortableWorkingData{
 const value={schema:'ponderosa.branch-working-data.v1' as const,package:pkg,owners};return {...value,sha256:branchWorkingDataHash(value)};
}
/** One complete physical graph, with no cross-Chat history, memory or imported grants. */
export function validateBranchWorkingData(value:unknown,chats:readonly BranchPackageChat[],mode:'template'|'full'):asserts value is BranchPortableWorkingData{
 const data=value as BranchPortableWorkingData;
 if(mode!=='full'||!data||data.schema!=='ponderosa.branch-working-data.v1'||Object.keys(data).some(key=>!['schema','package','owners','sha256'].includes(key))||!data.owners||typeof data.owners!=='object'||Array.isArray(data.owners)||!data.package||data.package.mode!=='full')throw Error('Invalid closed Branch working data');
 const pkg=validatePortableAgentPackage(data.package).package;
 if(pkg.memory!==undefined||pkg.outputRoles!==undefined||pkg.sourceProjectInstructions!==undefined||Object.keys(data.owners).length!==pkg.agents.length||branchWorkingDataHash({schema:data.schema,package:pkg,owners:data.owners})!==data.sha256)throw Error('Branch working data bytes or owner closure differ');
 const logical=new Set<string>();
 for(const node of pkg.agents){
  const owner=data.owners[node.ref];
  if(!owner||Object.keys(owner).some(key=>!['chatRef','agentRef'].includes(key))||typeof owner.chatRef!=='string'||typeof owner.agentRef!=='string'||!chats.find(chat=>chat.ref===owner.chatRef)?.agents.some(agent=>agent.ref===owner.agentRef)||logical.has(JSON.stringify([owner.chatRef,owner.agentRef])))throw Error('Branch working root owner is absent or duplicated');
  logical.add(JSON.stringify([owner.chatRef,owner.agentRef]));
  if(!node.workingRootRef||node.history!==undefined||node.initialInstructions!==undefined||node.role!==undefined||node.presetSnapshot!==undefined||node.accessSettings!==undefined||node.sourceChat!==undefined||node.managerRef!==undefined||node.managementPermissions.allowAutomaticDescendantDeletion||node.managementPermissions.allowAutomaticDescendantReorganization)throw Error('Working data cannot carry Agent context, relationships or grants');
  const originals=new Set((node.workingFiles??[]).flatMap(file=>workingFileArtifactRefs(file)));
  if((node.artifacts??[]).some(artifact=>!originals.has(artifact.ref))||originals.size!==(node.artifacts??[]).length)throw Error('Working data artifacts must be exactly the selected physical originals');
  const agent=chats.find(chat=>chat.ref===owner.chatRef)!.agents.find(agent=>agent.ref===owner.agentRef)!;
  if(agent.definition.agents.some(item=>item.workingFolder||item.workingFiles?.length||item.workingRootRef)||agent.definition.gitStorageBindings!==undefined)throw Error('Physical originals cannot be duplicated in a Branch Agent definition');
 }
}
