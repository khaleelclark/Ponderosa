import {useMutationNotification,MutationErrorDetails} from '../MutationNotifications';
import {createClientId} from '../../clientId';
import {productApiPath} from '../../api/productScope';
import {useWorkspacePreferencesWriter} from '../../hooks/queries';
import {useRef,useState} from 'react';
import {PreferenceSaveFeedback,preferenceSaveReporter} from '../../preferenceSaveFeedback';
import {Stack} from '@mui/material';
import type {EngineDto,WorkspacePreferencesDto} from '@ponderosa/core';
import {useQuery} from '@tanstack/react-query';
import {realApi} from '../../api/real';
import type {ColorMode} from '../../theme';
import {branchSettingsSection,type BranchGlobalView} from '../../branchesRouting';
import {WorkspaceSettingsView} from '../WorkspaceSettingsView';

export function BranchGlobalSettings({view,preferences,engines,colorMode,onToggleColorMode,onClose}:{view:BranchGlobalView;preferences:WorkspacePreferencesDto;engines:EngineDto[];colorMode:ColorMode;onToggleColorMode():void;onClose():void}):JSX.Element {
 const [errors,setErrors]=useState<Record<string,string>>({});
 const feedback=useRef(new PreferenceSaveFeedback());
 const report=(field:string,error?:string)=>setErrors(current=>{const next={...current};if(error)next[field]=error;else delete next[field];return next;});
 const projects=useQuery({queryKey:['branch-global-projects'],queryFn:()=>realApi.listProjects()});
 const preferenceWriter=useWorkspacePreferencesWriter();
 const notify=useMutationNotification();
 const save=(patch:Partial<WorkspacePreferencesDto>,immediate=false)=>{
  const reporter=preferenceSaveReporter({notify,namespace:productApiPath("/api/workspace/preferences"),incident:createClientId("preference-feedback-"),report});
  return feedback.current.track(patch,preferenceWriter.enqueueAndWait(patch),reporter,immediate,preferences);
 };
 return <Stack sx={{flex:1,minHeight:0,minWidth:0}}>
  {Object.entries(errors).map(([field,error])=><MutationErrorDetails key={field} title="Settings Need Review" error={error}/>)}
   <WorkspaceSettingsView activityWorkflows preferences={preferences} engines={engines} projects={projects.data??[]} colorMode={colorMode} onToggleColorMode={onToggleColorMode} onPreferences={patch=>void save(patch,true).catch(()=>{})} onSavePreferences={patch=>save(patch)} section={branchSettingsSection(view)} onReturn={onClose} returnLabel="Back To Branches"/>
 </Stack>;
}
