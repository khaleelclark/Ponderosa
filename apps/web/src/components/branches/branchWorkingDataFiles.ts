import type {BranchImportFileSelections,InstalledBranchPackage} from '@ponderosa/core';
import {portablePathChoice,destinationChoiceKey} from '../portablePathChoices';
export const workingOwnerKey=(chatRef:string,agentRef:string)=>JSON.stringify([chatRef,agentRef]);
export function branchWorkingDataRoots(pkg:InstalledBranchPackage){
 const data=pkg.workingData;if(!data)return [];
 return [...new Set(data.package.agents.map(node=>node.workingRootRef??node.ref))].map(ref=>{
  const members=data.package.agents.filter(node=>(node.workingRootRef??node.ref)===ref),node=members.find(member=>member.workingFolder)??members[0]!,owner=data.owners[node.ref]!;
  return {ref,node,members,owner,key:workingOwnerKey(owner.chatRef,owner.agentRef),boundary:data.package.workingRootNesting?.find(boundary=>boundary.childRootRef===ref)};
 });
}
export function branchWorkingDataDestinations(pkg:InstalledBranchPackage,choices:BranchImportFileSelections):Record<string,string>{
 const result:Record<string,string>={};for(const choice of Object.values(choices))Object.assign(result,choice.workingRootDestinations??{});return result;
}
export function branchWorkingDataDerivedChat(pkg:InstalledBranchPackage,chatRef:string):{kind:'shared'|'contained';sourceChatRef:string;path?:string}|undefined{
 const data=pkg.workingData;if(!data)return;
 const node=data.package.agents.find(node=>(node.workingCopyMode??'shared')==='shared'&&data.owners[node.ref]?.chatRef===chatRef);if(!node?.workingRootRef)return;
 const primary=pkg.chats.find(chat=>data.package.agents.some(member=>member.workingRootRef===node.workingRootRef&&(member.workingCopyMode??'shared')==='shared'&&data.owners[member.ref]?.chatRef===chat.ref));
 if(primary&&primary.ref!==chatRef)return {kind:'shared',sourceChatRef:primary.ref};
 const boundary=data.package.workingRootNesting?.find(item=>item.childRootRef===node.workingRootRef);
 if(boundary){const parent=data.package.agents.find(member=>member.workingRootRef===boundary.parentRootRef&&member.workingFolder)??data.package.agents.find(member=>member.workingRootRef===boundary.parentRootRef)!;return {kind:'contained',sourceChatRef:data.owners[parent.ref]!.chatRef,path:boundary.path};}
}
export function branchWorkingDataFileError(pkg:InstalledBranchPackage,choices:BranchImportFileSelections,retained:Set<string>):string|undefined{
 const roots=branchWorkingDataRoots(pkg),destinations=branchWorkingDataDestinations(pkg,choices),nesting=pkg.workingData?.package.workingRootNesting??[];
 if(roots.some(root=>root.members.some(member=>{const owner=pkg.workingData!.owners[member.ref]!;return retained.has(workingOwnerKey(owner.chatRef,owner.agentRef));})))return 'Working-folder imports require new Agents; existing folders stay unchanged.';
 for(const root of roots){const selected=portablePathChoice(destinations[root.ref]??'');if(!selected||selected.root)return 'Choose a new absolute recovery folder for every captured root.';}
 const parent=new Map(nesting.map(boundary=>[boundary.childRootRef,boundary.parentRootRef]));
 const ancestor=(child:string,wanted:string)=>{const seen=new Set<string>();while(parent.has(child)){if(seen.has(child))return false;seen.add(child);child=parent.get(child)!;if(child===wanted)return true;}return false;};
 for(const boundary of nesting)if(destinationChoiceKey(destinations[boundary.childRootRef]!)!==destinationChoiceKey(portablePathChoice(destinations[boundary.parentRootRef]!)!.path+'/'+boundary.path))return 'Keep nested working folders at their captured relative location.';
 for(const left of roots)for(const right of roots)if(left.ref!==right.ref){const a=destinationChoiceKey(destinations[left.ref]!)!,b=destinationChoiceKey(destinations[right.ref]!)!;if(a===b||a.startsWith(b+'/')&&!ancestor(left.ref,right.ref))return 'Only declared parent and child working folders may nest.';}
 const live=Object.values(choices).some(choice=>choice.workingFilesActivation);
 if(live)for(const chat of pkg.chats){const root=chat.agents.find(agent=>!agent.managerRef)??chat.agents[0];if(!root||!Object.values(pkg.workingData!.owners).some(owner=>owner.chatRef===chat.ref))continue;const choice=choices[workingOwnerKey(chat.ref,root.ref)];if(!choice?.workingFilesActivation||!branchWorkingDataDerivedChat(pkg,chat.ref)&&!choice.newManagedChatFolderName?.trim())return 'Choose a new managed working-folder name for every imported Chat.';}
}
