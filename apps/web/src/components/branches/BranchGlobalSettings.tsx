import {queryKeys} from '../../queryKeys';
import {providerUsageRefreshInterval,refreshLatestProviderUsage} from '../../providerUsageQuery';
import {useState,type ReactNode} from 'react';
import {Alert,Box,Button,Stack,Typography} from '@mui/material';
import type {EngineDto,WorkspacePreferencesDto} from '@ponderosa/core';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {realApi} from '../../api/real';
import type {ColorMode} from '../../theme';
import type {BranchGlobalView} from '../../branchesRouting';
import {WorkspaceSettingsView,OperatorProfileWorkspace} from '../WorkspaceSettingsView';
import {ProviderActivityCard} from '../ProviderActivityCard';
import {ProviderStatusFlow} from '../ProviderStatusFlow';
import {ProviderUsageCard} from '../ProviderUsageCenter';
import {SettingsNavigationPanel} from '../WorkspaceSidebar.chrome';
import {MobileNavigationButton} from '../MobileNavigationContext';
import {useBranchDraftGuard} from './BranchNavigation';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';

export function BranchGlobalSettings({view,preferences,engines,colorMode,onToggleColorMode,onSelect,onClose,notificationAction}:{view:BranchGlobalView;preferences:WorkspacePreferencesDto;engines:EngineDto[];colorMode:ColorMode;onToggleColorMode():void;onSelect(view:BranchGlobalView):void;onClose():void;notificationAction?:ReactNode}):JSX.Element {
 const client=useQueryClient(),[error,setError]=useState(''),[dirty,setDirty]=useState(false);
 useBranchDraftGuard('global-settings',dirty);
 const projects=useQuery({queryKey:['branch-global-projects'],queryFn:()=>realApi.listProjects()});
 const usage=useQuery({queryKey:queryKeys.providerUsage.all,queryFn:()=>realApi.getProviderUsage(),enabled:view==='usage',refetchInterval:query=>providerUsageRefreshInterval(query.state.data),staleTime:30000});
 const refresh=useMutation({mutationFn:(provider:string)=>refreshLatestProviderUsage(client,()=>realApi.refreshProviderUsage(provider))});
 const save=async(patch:Partial<WorkspacePreferencesDto>)=>{setError('');let next:WorkspacePreferencesDto;try{next=await realApi.updateWorkspacePreferences(patch)}catch(e){setError((e as Error).message);throw e}client.setQueryData(['preferences'],next);return next};
 const items=([['general','General'],['providers','AI Providers'],['notifications','Notifications'],['activity','Provider Activity'],['usage','Provider Usage'],['profile','Operator Profile']] as const).map(([id,label])=>({id,label,description:'',icon:<SettingsOutlinedIcon/>}));
 return <Stack sx={{flex:1,minHeight:0,overflow:'auto'}}>
  {refresh.error&&<Alert severity="error">{refresh.error.message}</Alert>}
  {error&&<Alert severity="error" onClose={()=>setError('')}>{error} Retry saving your changes.</Alert>}
  <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} sx={{p:2}}><Stack direction="row" alignItems="center" gap={1} sx={{minWidth:0,flex:1}}><MobileNavigationButton/><Typography variant="h6" noWrap>Ponderosa Settings</Typography></Stack><Stack direction="row" alignItems="center" flexShrink={0}>{notificationAction}<Button size="small" onClick={onClose}>Back to Branches</Button></Stack></Stack>
  <Stack direction={{xs:'column',md:'row'}} sx={{minHeight:{xs:'auto',md:0},flex:{xs:'0 0 auto',md:1},overflow:{xs:'visible',md:'hidden'}}}>
   <Box sx={{width:{xs:'100%',md:270},flexShrink:0}}><SettingsNavigationPanel<BranchGlobalView> title="Ponderosa Settings" icon={<SettingsOutlinedIcon/>} items={items} selected={view} onSelect={onSelect}/></Box>
   <Box sx={{flex:1,minWidth:0,minHeight:{xs:'auto',md:0},overflow:{xs:'visible',md:'auto'}}}>
    {view==='profile'?<OperatorProfileWorkspace showHeader={false} preferences={preferences} onSavePreferences={save}/>:view==='activity'?<Box sx={{p:2}}><ProviderActivityCard scopes={[{scope:'branches',label:'All Branches'}]}/></Box>:view==='usage'?<Stack spacing={2} sx={{p:2}}>{usage.error?<Alert severity="error" action={<Button onClick={()=>void usage.refetch()}>Retry</Button>}>{usage.error.message}</Alert>:usage.isPending?<Typography>Loading provider usage…</Typography>:usage.data.providers.map(state=><ProviderUsageCard key={state.provider} state={state} requestPending={refresh.isPending&&refresh.variables===state.provider} onRefresh={()=>refresh.mutate(state.provider)} onOpenProviderSettings={()=>onSelect('providers')}/>)}</Stack>:<WorkspaceSettingsView showHeader={false} preferences={preferences} engines={engines} projects={projects.data??[]} colorMode={colorMode} onToggleColorMode={onToggleColorMode} onPreferences={patch=>void save(patch).catch(()=>{})} onSavePreferences={save} onDirtyChange={setDirty} section={view==='status'?'providers':view}/>}
   </Box>
  </Stack>
  <ProviderStatusFlow open={view==='status'} engines={engines} networkSecurityLoading={false} onOpenSettings={()=>onSelect('providers')} onClose={onClose}/>
 </Stack>;
}
