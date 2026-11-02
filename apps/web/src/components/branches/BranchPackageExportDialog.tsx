import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert,Button,Checkbox,FormControlLabel,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {BranchExportFileSelections,ReviewedUserDataSelection} from '@ponderosa/core';
import {realApi} from '../../api/real';
import {FullPackageExportDialog} from '../PackageExportDisclosure';

export function BranchPackageExportDialog({source,pending,error,onCancel,onConfirm}:{source:{branchId:string;name:string};pending:boolean;error?:string;onCancel():void;onConfirm(files:BranchExportFileSelections):Promise<void>}):JSX.Element {
 const [allFolders,setAllFolders]=useState(false),[choices,setChoices]=useState<BranchExportFileSelections>({});
 const [includeGit,setIncludeGit]=useState(false),[includeHarness,setIncludeHarness]=useState(false);
 const reviewAvailable=allFolders||Object.values(choices).some(choice=>choice.wholeWorkingFolder);
 const reviewedUserData:ReviewedUserDataSelection|undefined=reviewAvailable&&(includeGit||includeHarness)?{git:includeGit,harness:includeHarness}:undefined;
 const agents=useQuery({queryKey:['branch-export-agents',source.branchId],queryFn:()=>realApi.listBranchAgents(source.branchId),retry:false});
 const files=allFolders?Object.fromEntries((agents.data??[]).map(agent=>[agent.id,{wholeWorkingFolder:true,...(reviewedUserData?{reviewedUserData}:{})}])):Object.fromEntries(Object.entries(choices).map(([id,choice])=>[id,choice.selectedWorkingFiles?{selectedWorkingFiles:choice.selectedWorkingFiles.filter(path=>path.trim())}: {...choice,...(choice.wholeWorkingFolder&&reviewedUserData?{reviewedUserData}:{})}]));
 return <FullPackageExportDialog name={source.name} pending={pending} confirmDisabled={agents.isFetching||!agents.data||agents.isError} error={error??agents.error?.message} onCancel={onCancel} onConfirm={async()=>{if(!agents.data||agents.isError)return;await onConfirm(files);}}>
  <Stack spacing={1} sx={{mt:2}}>
   <Alert severity="info">Full package includes supported private runtime facts and execution-owned Chats · new installation recreates held data · no native authority</Alert>
   <Typography>Working files optional · credentials, native ownership and sessions excluded</Typography>
   {agents.isError&&<Alert severity="error" action={<Button onClick={()=>void agents.refetch()}>Retry</Button>}>Could not load Agents.</Alert>}
   <FormControlLabel control={<Checkbox disabled={pending||!agents.data} checked={allFolders} onChange={event=>setAllFolders(event.target.checked)}/>} label="Include all workflow Agent working folders"/>
   <FormControlLabel control={<Checkbox disabled={pending||!reviewAvailable} checked={reviewAvailable&&includeGit} onChange={event=>setIncludeGit(event.target.checked)}/>} label="Include Git history, refs and staged files for review in selected whole folders"/>
   <FormControlLabel control={<Checkbox disabled={pending||!reviewAvailable} checked={reviewAvailable&&includeHarness} onChange={event=>setIncludeHarness(event.target.checked)}/>} label="Include supported Claude/Codex project settings for review in selected whole folders"/>
   <Typography variant="caption" color="text.secondary">Applies only to whole working folders below. Import creates separate inactive review copies. Settings and hooks are not activated. Unsupported or unsafe data stops export; review the package before importing.</Typography>
   {!allFolders&&agents.data?.map(agent=><Stack key={agent.id} spacing={1}>
    <TextField select disabled={pending} label={`Working files: ${agent.chatTitle} · ${agent.title}`} value={choices[agent.id]?.wholeWorkingFolder?'whole':choices[agent.id]?.selectedWorkingFiles?'selected':''} onChange={event=>setChoices(current=>{const next={...current};if(!event.target.value)delete next[agent.id];else next[agent.id]=event.target.value==='whole'?{wholeWorkingFolder:true}:{selectedWorkingFiles:[]};return next;})}><MenuItem value="">No working files</MenuItem><MenuItem value="whole">Whole working folder</MenuItem><MenuItem value="selected">Select relative files</MenuItem></TextField>
    {choices[agent.id]?.selectedWorkingFiles&&<TextField multiline minRows={2} disabled={pending} label={`Relative file paths: ${agent.title}`} value={choices[agent.id]?.selectedWorkingFiles?.join('\n')} onChange={event=>setChoices(current=>({...current,[agent.id]:{selectedWorkingFiles:event.target.value.split('\n')}}))} helperText="One relative path per line · server path/credential checks required"/>}
   </Stack>)}
  </Stack>
 </FullPackageExportDialog>;
}
