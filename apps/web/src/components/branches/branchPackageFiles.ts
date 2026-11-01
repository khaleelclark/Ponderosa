import type {BranchImportFileSelections,InstalledBranchPackage} from '@ponderosa/core';
import {validWorkingRootDestinations} from '../workingRootDestinations';
export const branchPackageTarget=(chatRef:string,agentRef:string)=>JSON.stringify([chatRef,agentRef]);
export function branchPackageFileTargets(pkg:InstalledBranchPackage){
 return pkg.chats.flatMap(chat=>chat.agents.map(agent=>({chat,agent,key:branchPackageTarget(chat.ref,agent.ref),roots:[...new Set(agent.definition.agents.flatMap(node=>node.workingRootRef?[node.workingRootRef]:[]))],hasFiles:agent.definition.agents.some(node=>Boolean(node.workingFolder)||Boolean(node.workingFiles?.length))})));
}
export type BranchRootInventory=Record<string,string[]>;
export function branchPackageFileError(pkg:InstalledBranchPackage,files:BranchImportFileSelections,retained:Set<string>,inventory:BranchRootInventory={}):string|undefined{
 const destinations:Record<string,string>={};
 for(const target of branchPackageFileTargets(pkg)){
  const selection=files[target.key];
  if(retained.has(target.key)){if(selection)return 'Existing Agents keep their folders; remove their import folder choices.';continue;}
  const groupRoot=target.chat.agents.find(agent=>!agent.managerRef);
  const groupKey=groupRoot&&branchPackageTarget(target.chat.ref,groupRoot.ref);
  const grouped=groupKey&&files[groupKey]?.newManagedChatFolderName!==undefined&&target.chat.agents.length>1;
  if(grouped&&target.key!==groupKey){if(selection)return 'Grouped children use the first reporting root folder choices only.';continue;}
  if(!target.hasFiles&&!grouped)continue;
  const roots=grouped?inventory[target.key]??[]:target.roots;
  if(grouped&&inventory[target.key]&&(selection?.workingFilesDestination!==undefined||Object.keys(selection?.workingRootDestinations??{}).some(ref=>!roots.includes(ref))))return 'Review canonical grouped roots again; discard previous root mappings.';
  if(roots.length){for(const ref of roots)destinations[JSON.stringify([target.key,ref])]=selection?.workingRootDestinations?.[ref]??'';}
  else destinations[target.key]=selection?.workingFilesDestination??'';
  if(selection?.newManagedChatFolderName!==undefined){
   if(!selection.workingFilesActivation||selection.workingFilesActivation.sharedRoot!==undefined)return 'Confirm the actual new working root only after managed Chat creation.';
   if(!/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,79}$/u.test(selection.newManagedChatFolderName))return 'Choose a safe new managed folder name.';
   if(target.chat.agents.length>1&&target.key!==groupKey)return 'Choose grouped activation on the first authored reporting root only.';
   if(target.chat.agents.some(agent=>retained.has(branchPackageTarget(target.chat.ref,agent.ref))))return 'Existing Agents cannot move into a grouped managed Chat.';
  }else if(selection?.workingFilesActivation&&target.agent.definition.agents.some(node=>node.workingCopyMode!=='separate_git'))return 'Shared live activation requires a new managed Chat; existing workspaces support Separate Git copies only.';
 }
 if(!validWorkingRootDestinations(Object.keys(destinations),destinations))return 'Choose new absolute recovery folders for every included working root; folders must be distinct and cannot nest.';
}

export function mergeBranchImportResults(results:Record<string,import('../PostImportAccessReview').ImportSettingsResult>):import('../PostImportAccessReview').ImportSettingsResult {
 const suggestions=new Map<string,NonNullable<import('../PostImportAccessReview').ImportSettingsResult['accessSettingsToReview']>[number]>();
 const roots=new Map<string,NonNullable<import('../PostImportAccessReview').ImportSettingsResult['workingRoots']>[number]>(),live=new Map<string,NonNullable<import('../PostImportAccessReview').ImportSettingsResult['liveWorkingRoots']>[number]>();
 for(const result of Object.values(results)){
  for(const suggestion of result.accessSettingsToReview??[]){const prior=suggestions.get(suggestion.agentId);if(prior&&JSON.stringify(prior)!==JSON.stringify(suggestion))throw new Error('Conflicting imported Settings receipts. Reload workflow installation status.');suggestions.set(suggestion.agentId,suggestion);}
  for(const root of result.workingRoots??[])roots.set(JSON.stringify(root),root);
  for(const root of result.liveWorkingRoots??[])live.set(JSON.stringify(root),root);
 }
 return {accessSettingsToReview:[...suggestions.values()],workingRoots:[...roots.values()],liveWorkingRoots:[...live.values()]};
}
