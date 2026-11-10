import {BranchWorkingDataFiles} from './BranchWorkingDataFiles';
import {useEffect,useState} from 'react';
import {NativePortableImportChoices,type NativeImportChoices} from '../NativePortableDataChoices';
import {nativeDataPreview,nativePreviewForGroupedRoots,type NativeDataPreview} from '../nativeDataPreview';
import {Alert,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {BranchImportFileSelection,BranchImportFileSelections,InstalledBranchPackage} from '@ponderosa/core';
import {branchPackageTarget,type BranchRootInventory,branchPackageFileTargets} from './branchPackageFiles';
export function BranchImportFiles({pkg,value,onChange,retained,disabled,inventory,metadataInventory={}}:{pkg:InstalledBranchPackage;value:BranchImportFileSelections;onChange(value:BranchImportFileSelections):void;retained:Set<string>;disabled:boolean;inventory:BranchRootInventory;metadataInventory?:BranchRootInventory}):JSX.Element {
 if(pkg.workingData)return <BranchWorkingDataFiles pkg={pkg} value={value} onChange={onChange} disabled={disabled}/>;
 return <Stack spacing={2}><Typography variant="h6">Included Working Folders</Typography>
  <Typography>Recovery · new folders · live activation optional · native ownership, sessions and credentials excluded</Typography>
  {branchPackageFileTargets(pkg).filter(target=>target.hasFiles||target.chat.agents.some(agent=>agent.definition.agents.some(node=>Boolean(node.workingFolder)||Boolean(node.workingFiles?.length)))).map(target=>{
   if(retained.has(target.key))return <Typography key={target.key}>{target.chat.title} · {target.agent.definition.agents[0]?.title}: existing Agent keeps its working files.</Typography>;
   const root=target.chat.agents.find(agent=>!agent.managerRef),rootKey=root&&branchPackageTarget(target.chat.ref,root.ref);
   const grouped=rootKey&&value[rootKey]?.newManagedChatFolderName!==undefined&&target.chat.agents.length>1;
   if(grouped&&rootKey!==target.key)return <Typography key={target.key}>{target.agent.definition.agents[0]?.title}: uses the grouped Chat recovery and live folder choices.</Typography>;
   if(!target.hasFiles&&rootKey!==target.key)return <Typography key={target.key}>{target.agent.definition.agents[0]?.title}: no included working originals.</Typography>;
   const roots=grouped?inventory[target.key]??[]:target.roots;
   const selection=value[target.key]??{},mode=selection.newManagedChatFolderName!==undefined?'new':selection.workingFilesActivation?'existing':'content';
   const update=(next:BranchImportFileSelection)=>onChange({...Object.fromEntries(Object.entries(value).filter(([key])=>!(next.newManagedChatFolderName!==undefined&&JSON.parse(key)[0]===target.chat.ref))),[target.key]:next});
   return <Stack key={target.key} spacing={1}>
    <Typography variant="subtitle1">{target.chat.title} · {target.agent.definition.agents[0]?.title}</Typography>
    {roots.length?roots.map(ref=><TextField key={ref} disabled={disabled} label={`New Recovery Folder: ${ref}`} value={selection.workingRootDestinations?.[ref]??''} onChange={event=>update({...selection,workingRootDestinations:{...selection.workingRootDestinations,[ref]:event.target.value}})} helperText="New absolute host path; outside and distinct from all other recovery and live folders."/>):<TextField disabled={disabled} label="New Recovery Folder" value={selection.workingFilesDestination??''} onChange={event=>{const {workingRootDestinations,...rest}=selection;update({...rest,workingFilesDestination:event.target.value});}} helperText="New absolute host path. Existing content is never overwritten."/>}
    <TextField select disabled={disabled} label="Restored Working Files" value={mode} onChange={event=>{const {workingFilesActivation,newManagedChatFolderName,...priorRecovery}=selection;const recovery=event.target.value==='new'||grouped?{}:priorRecovery;update({...recovery,...(event.target.value==='content'?{}:{workingFilesActivation:{}}),...(event.target.value==='new'?{newManagedChatFolderName:''}:{})});}}><MenuItem value="content">Recovery Copies Only</MenuItem><MenuItem value="existing">Activate Fresh Separate Git Copies In Destination Git Workspace</MenuItem><MenuItem value="new" disabled={rootKey!==target.key||target.chat.agents.some(agent=>retained.has(branchPackageTarget(target.chat.ref,agent.ref)))}>Create New Managed Chat And Activate Files</MenuItem></TextField>
    {grouped&&!inventory[target.key]&&<Alert severity="info">Grouped roots · enter new recovery folder → review changes → assign every root folder → review again</Alert>}
    {mode==='new'&&<TextField disabled={disabled} label="New Managed Chat Folder Name" value={selection.newManagedChatFolderName??''} onChange={event=>update({...selection,newManagedChatFolderName:event.target.value})} helperText="The installer creates the folder, then asks you to confirm its actual path before import."/>}
    <BranchNativeData key={target.key+(grouped?':group':'')} sourceIdentity={pkg} packages={grouped?target.chat.agents.map(agent=>agent.definition):[target.agent.definition]} grouped={Boolean(grouped)} metadataRoots={grouped?metadataInventory[target.key]:undefined} value={selection} onChange={next=>update({...selection,...next})} disabled={disabled} destinations={selection.workingRootDestinations}/>
    {mode==='existing'&&target.agent.definition.agents.some(node=>node.workingCopyMode!=='separate_git')&&<Alert severity="warning">Shared files · live activation requires a new managed Chat</Alert>}
   </Stack>;
  })}
 </Stack>;
}

function BranchNativeData({packages,sourceIdentity,grouped,metadataRoots,value,onChange,disabled,destinations}:{packages:import('@ponderosa/core').AgentPortablePackageDto[];sourceIdentity:object;grouped:boolean;metadataRoots?:string[];value:NativeImportChoices;onChange(value:NativeImportChoices):void;disabled:boolean;destinations?:Record<string,string>}):JSX.Element {
 const [loaded,setLoaded]=useState<{source:object;summary:NativeDataPreview}>();
 useEffect(()=>{let active=true;setLoaded(undefined);void nativeDataPreview(packages.flatMap(pkg=>pkg.agents)).then(summary=>{if(active)setLoaded({source:sourceIdentity,summary})});return()=>{active=false};},[sourceIdentity]);
 const summary=loaded?.source===sourceIdentity?loaded.summary:undefined;
 const actual=grouped?nativePreviewForGroupedRoots(summary,metadataRoots):summary;
 return <NativePortableImportChoices summary={actual} value={value} onChange={onChange} disabled={disabled||!summary} destinations={destinations}/>;
}
