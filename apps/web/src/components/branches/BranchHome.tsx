import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import AddIcon from '@mui/icons-material/Add';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import {Alert, Box, Button, Paper, Stack, Typography} from '@mui/material';
import type {BranchHomeExecutionDto, EngineDto} from '@ponderosa/core';
import {useRef} from 'react';
import {attentionPresentation, isOpenAttention} from '../../attention';
import type {BranchRoute} from '../../branchesRouting';
import {engineAvailabilityPresentation} from '../../conversationEngine';
import {branchHomeItems, useBranchHome} from '../../hooks/useBranchHome';
import {HomeFirstItem, HomeItemCard, HomeLayout, HomeSection, HomeSummaryCard, homeItemsGridSx, homeSummaryGridSx} from '../HomeView.parts';
import type {SemanticStatusKind} from '../SemanticStatus';
import {BranchNotifications} from './BranchNotifications';

// Color only: the canonical operational projection supplies every status label.
const statusKinds: Record<BranchHomeExecutionDto['operational']['state'], SemanticStatusKind> = {
 queued:'waiting', running:'running', waiting_agent:'waiting', waiting_human:'needs_decision',
 retrying:'waiting', provider_unavailable:'waiting', provider_attention:'needs_attention',
 needs_reconciliation:'needs_attention', blocked:'blocked', completed:'completed', failed:'failed',
 canceled:'idle', skipped:'idle', merged:'idle',
};

export function BranchHome({engines, enginesLoaded, enginesError, onRetryEngines, onNavigate, onCreate, onImport, creating}: {
 engines: EngineDto[]; enginesLoaded: boolean; enginesError?: string; onRetryEngines():void;
 onNavigate(route:BranchRoute):void; onCreate():void; onImport():void; creating:boolean;
}):JSX.Element {
 const {data, active, outcomes}=useBranchHome();
 const working=useRef<HTMLDivElement>(null);
 const provider=engineAvailabilityPresentation(engines);
 const initialError=!data&&(active.isError||outcomes.isError);
 const refreshError=Boolean(data&&((active.isRefetchError&&!active.isFetchNextPageError)||(outcomes.isRefetchError&&!outcomes.isFetchNextPageError)));
 const loading=(!data&&!initialError)||(!active.data&&active.isPending)||(!outcomes.data&&outcomes.isPending);
 const partialError=(!active.data&&active.isError)||(!outcomes.data&&outcomes.isError);
 const retry=()=>{void active.refetch({cancelRefetch:false});void outcomes.refetch({cancelRefetch:false})};
 const executionSection=(section:'activeExecutions'|'recentOutcomes')=>{
  const query=section==='activeExecutions'?active:outcomes;
  const rows=branchHomeItems(query.data?.pages,section);
  return <Stack spacing={1}>
   {rows.length?<Box sx={homeItemsGridSx}>{rows.map(item=><HomeItemCard key={item.id}
    icon={<AccountTreeOutlinedIcon/>} title={item.branchName}
    detail={`Execution ${item.id.slice(0,8)} · ${new Date(section==='activeExecutions'?item.createdAt:item.updatedAt).toLocaleString()}${item.parentExecutionId?` · Child of ${item.parentExecutionId.slice(0,8)}`:''}`}
    status={statusKinds[item.operational.state]} statusLabel={item.operational.label} statusBelow multilineDetail
    onClick={()=>onNavigate({branchId:item.branchId,tab:'executions',executionId:item.id})}/>)}</Box>
    :!query.data&&query.isError?<Alert severity="error" action={<Button color="inherit" onClick={()=>void query.refetch({cancelRefetch:false})}>Retry</Button>}>{section==='activeExecutions'?'Active executions':'Recent outcomes'} could not be loaded.</Alert>
    :!query.data?<Typography color="text.secondary">Loading {section==='activeExecutions'?'active executions':'recent outcomes'}…</Typography>
    :<Paper variant="outlined" sx={{p:2}}><Typography color="text.secondary">{section==='activeExecutions'?'No executions are active right now.':'Finished workflow executions will appear here.'}</Typography></Paper>}
   {query.isFetchNextPageError?<Alert severity="warning">The next page could not be loaded. Current results are still available.</Alert>:null}
   {query.hasNextPage?<Button sx={{alignSelf:'flex-start'}} disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage({cancelRefetch:false})}>{query.isFetchingNextPage?'Loading…':query.isFetchNextPageError?'Retry next page':section==='activeExecutions'?'Load more active executions':'Load more outcomes'}</Button>:null}
  </Stack>;
 };
 return <BranchNotifications onNavigate={onNavigate}>{({openInbox,openNotification})=><HomeLayout fill context="Across your workflows" loading={loading} status={loading?'Loading Home summary':initialError?'Home summary unavailable':partialError?'Home summary could not be fully loaded':refreshError?'Home refresh failed. Last loaded results are still available.':'Home summary loaded'}>
   <Box sx={homeSummaryGridSx}>
    <HomeSummaryCard label="Active Executions" value={data?.activeExecutionCount??(initialError?'Unavailable':'Loading')} onClick={()=>{working.current?.scrollIntoView({block:'start'});working.current?.focus({preventScroll:true})}}/>
    <HomeSummaryCard label="Needs Attention" value={data?.openActionCount??(initialError?'Unavailable':'Loading')} onClick={openInbox}/>
    <HomeSummaryCard label="Provider Health" value={enginesLoaded?provider.label:enginesError?'Unavailable':'Loading'} compactValue={enginesLoaded&&provider.label==='Engine ready'?'Ready':undefined} onClick={()=>onNavigate({tab:'workflow',global:'providers'})}/>
   </Box>
   {initialError||refreshError?<Alert severity={initialError?'error':'warning'} action={<Button color="inherit" aria-label="Retry workflow Home" onClick={retry}>Retry</Button>}>{initialError?'Workflow Home could not be loaded.':'Home could not refresh. Last loaded counts and cards are still available.'}</Alert>:null}
   {enginesError?<Alert severity="warning" action={<Button color="inherit" onClick={onRetryEngines}>Retry</Button>}>Provider health could not refresh. {enginesLoaded?'Showing the last loaded provider state. ':''}Script-only workflows can still run.</Alert>
    :enginesLoaded&&provider.severity==='warning'?<Alert severity="warning" action={<Button color="inherit" onClick={()=>onNavigate({tab:'workflow',global:'providers'})}>Provider Settings</Button>}>Provider access for Agent steps needs attention. Script-only workflows can still run.</Alert>:null}
   {data?.workflowCount===0?<HomeFirstItem icon={<AccountTreeOutlinedIcon color="action" sx={{fontSize:42,mb:1}}/>} title="Start Your First Workflow" description="Build a repeatable workflow or import a Branch package.">
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" justifyContent="center"><Button variant="contained" startIcon={<AddIcon/>} disabled={creating} onClick={onCreate}>{creating?'Creating workflow…':'New workflow'}</Button><Button startIcon={<FileUploadOutlinedIcon/>} onClick={onImport}>Import workflow</Button></Stack>
   </HomeFirstItem>:null}
   <HomeSection title="Needs Attention" description="Decisions and blockers that still need you." action={data?.openActionCount?<Button onClick={openInbox}>View all</Button>:undefined}>
    {data?.attention.items.length?<Box sx={homeItemsGridSx}>{data.attention.items.filter(isOpenAttention).map(item=>{const presentation=attentionPresentation(item);return <HomeItemCard key={item.id} icon={<WarningAmberOutlinedIcon color="warning"/>} title={item.branchId?data.branchNames[item.branchId]??'Workflow unavailable':'Workflow attention'} detail={presentation.summary} status="needs_attention" statusLabel={item.severity==='urgent'?'Urgent':'Review'} statusBelow multilineDetail onClick={()=>openNotification(item)}/>})}</Box>
     :initialError?<Typography color="text.secondary">Notifications are unavailable.</Typography>:!data?<Typography color="text.secondary">Loading notifications…</Typography>:<Paper variant="outlined" sx={{p:2}}><Typography color="text.secondary">{data?.openActionCount?'Open Notifications to review the remaining attention items.':'Nothing currently needs your attention.'}</Typography></Paper>}
   </HomeSection>
   <Box ref={working} tabIndex={-1} sx={{outline:'none'}}><HomeSection title="Working Now" description="Queued, running, and waiting executions across workflows.">{executionSection('activeExecutions')}</HomeSection></Box>
   <HomeSection title="Recent Outcomes" description="Recently finished workflow executions.">{executionSection('recentOutcomes')}</HomeSection>
  </HomeLayout>}</BranchNotifications>;
}
