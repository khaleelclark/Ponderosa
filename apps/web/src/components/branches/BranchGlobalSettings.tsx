import {useWorkspacePreferencesWriter} from '../../hooks/queries';
import {useState,type ReactNode} from 'react';
import {Alert,Stack} from '@mui/material';
import type {EngineDto,WorkspacePreferencesDto} from '@ponderosa/core';
import {useQuery} from '@tanstack/react-query';
import {realApi} from '../../api/real';
import type {ColorMode} from '../../theme';
import {branchSettingsSection,type BranchGlobalView} from '../../branchesRouting';
import {WorkspaceSettingsView} from '../WorkspaceSettingsView';
import {PrimaryHeaderActionsProvider} from '../PrimaryHeaderActions';

export function BranchGlobalSettings({view,preferences,engines,colorMode,onToggleColorMode,onSelect,onClose,notificationAction}:{view:BranchGlobalView;preferences:WorkspacePreferencesDto;engines:EngineDto[];colorMode:ColorMode;onToggleColorMode():void;onSelect(view:BranchGlobalView):void;onClose():void;notificationAction?:ReactNode}):JSX.Element {
 const [error,setError]=useState('');
 const projects=useQuery({queryKey:['branch-global-projects'],queryFn:()=>realApi.listProjects()});
 const preferenceWriter=useWorkspacePreferencesWriter();
 const save=async(patch:Partial<WorkspacePreferencesDto>)=>{setError('');try{return await preferenceWriter.enqueueAndWait(patch)}catch(e){setError((e as Error).message);throw e}};
 return <Stack sx={{flex:1,minHeight:0,minWidth:0}}>
  {error&&<Alert severity="error" onClose={()=>setError('')}>{error} Retry saving your changes.</Alert>}
  <PrimaryHeaderActionsProvider onOpenProviderSettings={()=>onSelect('providers')} workspaceStatus={notificationAction}>
   <WorkspaceSettingsView preferences={preferences} engines={engines} projects={projects.data??[]} colorMode={colorMode} onToggleColorMode={onToggleColorMode} onPreferences={patch=>void save(patch).catch(()=>{})} onSavePreferences={save} section={branchSettingsSection(view)} onReturn={onClose} returnLabel="Back to Branches"/>
  </PrimaryHeaderActionsProvider>
 </Stack>;
}
