import {useCallback,type ReactNode,type RefObject} from 'react';
import DataUsageOutlined from '@mui/icons-material/DataUsageOutlined';
import {PrimaryHeaderActionsOutlet} from '../PrimaryHeaderActions';
import AccountTreeOutlined from '@mui/icons-material/AccountTreeOutlined';
import ChatBubbleOutline from '@mui/icons-material/ChatBubbleOutline';
import PlayCircleOutline from '@mui/icons-material/PlayCircleOutline';
import PlayArrowOutlined from '@mui/icons-material/PlayArrowOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import {Box,Button,Stack,Tooltip,Typography} from '@mui/material';
import {branchTabs,type BranchTab} from '../../branchesRouting';
import {TabbedWorkspaceFrame} from '../WorkspaceFrame';
import {SemanticStatusCircle,semanticStatusColorToken} from '../SemanticStatus';
import {ChatOverflowMenu} from '../ChatOverflowMenu';
import type {BranchRunCountsDto} from '@ponderosa/core';
import {branchRunStatus} from './branchRunStatus';

/** Branch actions adapt the shared workspace chrome; publication stays with its owner. */
export function BranchWorkspaceHeader({name,tab,published,dirty,runCounts,executionsUnavailable=false,onRun,runButton,runLabel='Run once',runPending=false,runDisabled=false,availability,onTab,onExport,onUpdate,onRename,onHistory,onEditJson,onVariables,onDiscard,discardDisabled=true}:{
 name:string;tab:BranchTab;published:boolean;dirty:boolean;runCounts?:BranchRunCountsDto;executionsUnavailable?:boolean;
 onRun?():void;runButton?:RefObject<HTMLButtonElement>;runLabel?:string;runPending?:boolean;runDisabled?:boolean;availability?:ReactNode;
 onTab(tab:BranchTab):void;onExport(mode:'template'|'full'):void;onUpdate():void;onRename():void;onHistory?():void;onEditJson?():void;onVariables?():void;onDiscard?():void;discardDisabled?:boolean;
}):JSX.Element{
 const activity=branchRunStatus(runCounts,executionsUnavailable);
 const executionTooltip=<>{activity.lines.map(line=><Box key={line}>{line}</Box>)}</>;
 const executionIcon=<Tooltip describeChild title={executionTooltip}><Box component="span" sx={{position:'relative',display:'inline-flex'}}><PlayCircleOutline/>
  <Box component="span" aria-hidden sx={theme=>({position:'absolute',top:-3,right:-4,color:semanticStatusColorToken(activity.status,theme.palette.mode)})}><SemanticStatusCircle/></Box>
 </Box></Tooltip>;
 const tabItems={workflow:{label:'Workflow',icon:<AccountTreeOutlined/>},executions:{label:'Executions',icon:executionIcon,description:activity.label,disabled:!published},chats:{label:'Chats',icon:<ChatBubbleOutline/>},settings:{label:'Settings',icon:<SettingsOutlined/>}};
 const tabs={idPrefix:'branch',value:tab,label:'Workflow Views',onChange:onTab,items:branchTabs.map(value=>({value,...tabItems[value]}))};
 const runAction=onRun&&<Button ref={runButton} variant="outlined" disabled={runPending||runDisabled} aria-describedby={runDisabled&&runLabel==='Run once'?'branch-availability-feedback':undefined}
  onClick={onRun} startIcon={runLabel==='Run once'?<PlayArrowOutlined/>:undefined} sx={{minHeight:44,whiteSpace:'nowrap',px:{xs:1,sm:1.5},'& .MuiButton-startIcon':{display:{xs:'none',sm:'inline-flex'}}}}>{runPending?'Submitting…':runLabel}</Button>;
 return <Box sx={{flexShrink:0,minWidth:0}}><TabbedWorkspaceFrame icon={<AccountTreeOutlined/>} title={name} compactMobile collapsedIconTabs retainCollapsedActions statusBeforePrimaryActions
  titleControl={<Stack sx={{minWidth:0}}><Typography component="h1" variant="body2" fontWeight={800} noWrap title={name}>{name}</Typography><Stack direction="row" useFlexGap flexWrap="wrap" alignItems="flex-start" gap={.5}>
   {availability}{dirty&&<Tooltip describeChild title="Unpublished Changes"><Typography component="span" tabIndex={0} aria-label="Editing" variant="caption" color="warning.main" sx={{alignSelf:'center'}}>Editing</Typography></Tooltip>}
  </Stack></Stack>}
  primaryActions={<Stack direction="row" spacing={.5} alignItems="center">{runAction}<BranchHeaderActions onRename={onRename} onDiscard={onDiscard} discardDisabled={discardDisabled} onExport={onExport} onUpdate={onUpdate} onHistory={onHistory} onEditJson={onEditJson} onVariables={onVariables}/></Stack>}
  tabs={tabs}/></Box>;

}

/** The existing global usage observer renders into the Branch's own menu. */
function BranchHeaderActions({onRename,onDiscard,discardDisabled,onExport,onUpdate,onHistory,onEditJson,onVariables}:Pick<Parameters<typeof BranchWorkspaceHeader>[0],'onRename'|'onDiscard'|'discardDisabled'|'onExport'|'onUpdate'|'onHistory'|'onEditJson'|'onVariables'>):JSX.Element{
 const renderMenu=useCallback((openUsage?: (anchor:HTMLElement)=>void,fullTrigger?:ReactNode)=><Box sx={{display:"flex",alignItems:"center",gap:.5}}>{fullTrigger}<ChatOverflowMenu label="Workflow Actions" showExports={false} transcriptMarkdown="" transcriptFileName="" actions={[
  ...(openUsage&&!fullTrigger?[{label:'Provider Usage',icon:<DataUsageOutlined fontSize="small"/>,onSelect:openUsage}]:[]),
  {label:'Rename…',onSelect:onRename},
  ...(onHistory?[{label:'Version History',onSelect:onHistory}]:[]),
  ...(onVariables?[{label:'Workflow variables',onSelect:onVariables}]:[]),
  ...(onEditJson?[{label:'Edit Workflow JSON…',onSelect:onEditJson}]:[]),
  {label:'Discard Changes',onSelect:()=>onDiscard?.(),disabled:discardDisabled},
  {label:'Export Template',onSelect:()=>onExport('template')},
  {label:'Export Full',onSelect:()=>onExport('full')},
  {label:'Apply Package Update…',onSelect:onUpdate},
 ]}/></Box>,[onRename,onDiscard,discardDisabled,onExport,onUpdate,onHistory,onEditJson,onVariables]);
 return <PrimaryHeaderActionsOutlet renderTrigger={renderMenu} fallback={renderMenu()}/>;
}
