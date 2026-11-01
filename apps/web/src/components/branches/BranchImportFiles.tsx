import {Alert,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {BranchImportFileSelection,BranchImportFileSelections,InstalledBranchPackage} from '@ponderosa/core';
import {branchPackageFileTargets} from './branchPackageFiles';
export function BranchImportFiles({pkg,value,onChange,retained,disabled}:{pkg:InstalledBranchPackage;value:BranchImportFileSelections;onChange(value:BranchImportFileSelections):void;retained:Set<string>;disabled:boolean}):JSX.Element {
 return <Stack spacing={2}><Typography variant="h6">Included working folders</Typography>
  <Typography>Recovery copies always use new folders. Live activation is optional; source native ownership, sessions and credentials are excluded.</Typography>
  {branchPackageFileTargets(pkg).filter(target=>target.hasFiles).map(target=>{
   if(retained.has(target.key))return <Typography key={target.key}>{target.chat.title} · {target.agent.definition.agents[0]?.title}: existing Agent keeps its working files.</Typography>;
   const selection=value[target.key]??{},mode=selection.newManagedChatFolderName!==undefined?'new':selection.workingFilesActivation?'existing':'content';
   const update=(next:BranchImportFileSelection)=>onChange({...value,[target.key]:next});
   return <Stack key={target.key} spacing={1}>
    <Typography variant="subtitle1">{target.chat.title} · {target.agent.definition.agents[0]?.title}</Typography>
    {target.roots.length?target.roots.map(ref=><TextField key={ref} disabled={disabled} label={`New recovery folder: ${ref}`} value={selection.workingRootDestinations?.[ref]??''} onChange={event=>update({...selection,workingRootDestinations:{...selection.workingRootDestinations,[ref]:event.target.value}})} helperText="New absolute host path; outside and distinct from all other recovery and live folders."/>):<TextField disabled={disabled} label="New recovery folder" value={selection.workingFilesDestination??''} onChange={event=>update({...selection,workingFilesDestination:event.target.value})} helperText="New absolute host path. Existing content is never overwritten."/>}
    <TextField select disabled={disabled} label="Restored working files" value={mode} onChange={event=>{const {workingFilesActivation,newManagedChatFolderName,...recovery}=selection;update({...recovery,...(event.target.value==='content'?{}:{workingFilesActivation:{}}),...(event.target.value==='new'?{newManagedChatFolderName:''}:{})});}}><MenuItem value="content">Recovery copies only</MenuItem><MenuItem value="existing">Activate fresh Separate Git copies in destination Git workspace</MenuItem><MenuItem value="new" disabled={target.chat.agents.length>1}>Create new managed Chat and activate files</MenuItem></TextField>
    {mode==='new'&&<TextField disabled={disabled} label="New managed Chat folder name" value={selection.newManagedChatFolderName??''} onChange={event=>update({...selection,newManagedChatFolderName:event.target.value})} helperText="The installer creates the folder, then asks you to confirm its actual path before import."/>}
    {mode==='existing'&&target.agent.definition.agents.some(node=>node.workingCopyMode!=='separate_git')&&<Alert severity="warning">This package includes Shared files. Select a new managed Chat for live activation.</Alert>}
   </Stack>;
  })}
 </Stack>;
}
