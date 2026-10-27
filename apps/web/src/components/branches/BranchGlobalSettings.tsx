import {useWorkspacePreferencesWriter} from '../../hooks/queries';
import {useState} from 'react';
import {Alert,Stack} from '@mui/material';
import type {EngineDto,WorkspacePreferencesDto} from '@ponderosa/core';
import {useQuery} from '@tanstack/react-query';
import {realApi} from '../../api/real';
import type {ColorMode} from '../../theme';
import {branchSettingsSection,type BranchGlobalView} from '../../branchesRouting';
import {WorkspaceSettingsView} from '../WorkspaceSettingsView';

export function BranchGlobalSettings({view,preferences,engines,colorMode,onToggleColorMode,onClose}:{view:BranchGlobalView;preferences:WorkspacePreferencesDto;engines:EngineDto[];colorMode:ColorMode;onToggleColorMode():void;onClose():void}):JSX.Element {
 const [error,setError]=useState('');
 const projects=useQuery({queryKey:['branch-global-projects'],queryFn:()=>realApi.listProjects()});
 const preferenceWriter=useWorkspacePreferencesWriter();
 const save=async(patch:Partial<WorkspacePreferencesDto>)=>{setError('');try{return await preferenceWriter.enqueueAndWait(patch)}catch(e){setError((e as Error).message);throw e}};
 return <Stack sx={{flex:1,minHeight:0,minWidth:0}}>
  {error&&<Alert severity="error" onClose={()=>setError('')}>{error} Retry saving your changes.</Alert>}
   <WorkspaceSettingsView activityWorkflows preferences={preferences} engines={engines} projects={projects.data??[]} colorMode={colorMode} onToggleColorMode={onToggleColorMode} onPreferences={patch=>void save(patch).catch(()=>{})} onSavePreferences={save} section={branchSettingsSection(view)} onReturn={onClose} returnLabel="Back to Branches"/>
 </Stack>;
}
