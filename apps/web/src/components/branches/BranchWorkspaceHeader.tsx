import {useCallback,type ReactNode} from 'react';
import DataUsageOutlined from '@mui/icons-material/DataUsageOutlined';
import {PrimaryHeaderActionsOutlet} from '../PrimaryHeaderActions';
import AccountTreeOutlined from '@mui/icons-material/AccountTreeOutlined';
import ChatBubbleOutline from '@mui/icons-material/ChatBubbleOutline';
import PlayCircleOutline from '@mui/icons-material/PlayCircleOutline';
import PlayArrowOutlined from '@mui/icons-material/PlayArrowOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import {Box,Button,Tooltip} from '@mui/material';
import {branchTabs,type BranchTab} from '../../branchesRouting';
import {TabbedWorkspaceFrame} from '../WorkspaceFrame';
import {SemanticStatus,SemanticStatusCircle,semanticStatusColorToken} from '../SemanticStatus';
import {ChatOverflowMenu} from '../ChatOverflowMenu';

/** Branch actions adapt the shared workspace chrome; publication stays with its owner. */
export function BranchWorkspaceHeader({name,tab,published,dirty,executionCount,executionsUnavailable=false,onRun,runPending=false,onTab,onExport,onUpdate,onRename,onHistory,onEditJson,onDiscard,discardDisabled=true}:{
 name:string;tab:BranchTab;published:boolean;dirty:boolean;executionCount?:number;executionsUnavailable?:boolean;
 onRun?():void;runPending?:boolean;
 onTab(tab:BranchTab):void;onExport(mode:'template'|'full'):void;onUpdate():void;onRename():void;onHistory?():void;onEditJson?():void;onDiscard?():void;discardDisabled?:boolean;
}):JSX.Element{
 const tabItems={workflow:{label:'Workflow',icon:<AccountTreeOutlined/>},executions:{label:'Executions',icon:<PlayCircleOutline/>,disabled:!published},chats:{label:'Chats',icon:<ChatBubbleOutline/>},settings:{label:'Settings',icon:<SettingsOutlined/>}};
 const tabs={idPrefix:'branch',value:tab,label:'Branch views',onChange:onTab,items:branchTabs.map(value=>({value,...tabItems[value]}))};
 const executionStatus=executionsUnavailable?'needs_attention':executionCount===undefined?'waiting':executionCount>0?'running':'idle';
 const executionLabel=executionsUnavailable?'Executions unavailable':executionCount===undefined?'Executions loading…':`${executionCount} active executions`;
 const runLabel=dirty&&published?'Run Published Workflow':'Run Workflow';
 return <Box sx={{flexShrink:0,minWidth:0}}><TabbedWorkspaceFrame icon={<AccountTreeOutlined/>} title={name} compactMobile collapsedIconTabs collapsedSingleRow retainCollapsedActions statusBeforePrimaryActions
  status={<Box sx={{display:'flex',gap:.5,alignItems:'center',flexShrink:0,minWidth:0,'@container (max-width: 27.5rem)':{gap:.25},'& .MuiChip-root':{maxWidth:'100%',height:'auto',minHeight:24},'& .MuiChip-label':{whiteSpace:'nowrap',lineHeight:1.2,py:.5,px:1}}}><Box sx={{display:'flex','@container (max-width: 40rem)':{display:'none'}}}><SemanticStatus status={executionStatus} label={executionLabel}/></Box><Tooltip describeChild title={executionLabel}><Box component="span" role="img" tabIndex={0} aria-label={executionLabel} sx={{display:'none',alignItems:'center',gap:.5,px:.5,minHeight:24,whiteSpace:'nowrap',fontSize:12,'@container (max-width: 27.5rem)':{px:0},borderRadius:.5,'@container (max-width: 40rem)':{display:'inline-flex'},'&:focus-visible':{outline:'2px solid',outlineColor:'primary.main',outlineOffset:-2}}}><Box component="span" aria-hidden sx={theme=>({color:semanticStatusColorToken(executionStatus,theme.palette.mode)})}><SemanticStatusCircle/></Box>{executionsUnavailable?'!':executionCount??'…'}</Box></Tooltip>{dirty&&<Tooltip describeChild title="Unpublished Changes"><Box component="span" tabIndex={0} aria-label="Editing" sx={{color:'warning.main',display:'inline-flex',alignItems:'center',flexShrink:0,minHeight:24,fontSize:12,fontWeight:600,lineHeight:1,whiteSpace:'nowrap',px:.75,borderRadius:.5,'&:focus-visible':{outline:'2px solid',outlineColor:'primary.main',outlineOffset:-2},'@container (max-width: 27.5rem)':{px:0,fontSize:11}}}>Editing</Box></Tooltip>}{onRun&&<Tooltip title={runLabel}><span><Button aria-label={runLabel} variant="outlined" disabled={runPending} onClick={onRun} startIcon={<PlayArrowOutlined/>} sx={{minWidth:44,minHeight:44,whiteSpace:'nowrap',flexShrink:0,'@container (max-width: 40rem)':{width:44,p:0,'& .MuiButton-startIcon':{m:0}},'& .branch-run-label':{'@container (max-width: 40rem)':{display:'none'}}}}><Box component="span" className="branch-run-label">{runLabel}</Box></Button></span></Tooltip>}</Box>}
  primaryActions={<BranchHeaderActions onRename={onRename} onDiscard={onDiscard} discardDisabled={discardDisabled} onExport={onExport} onUpdate={onUpdate} onHistory={onHistory} onEditJson={onEditJson}/>}
  tabs={tabs}/></Box>;
}

/** The existing global usage observer renders into the Branch's own menu. */
function BranchHeaderActions({onRename,onDiscard,discardDisabled,onExport,onUpdate,onHistory,onEditJson}:Pick<Parameters<typeof BranchWorkspaceHeader>[0],'onRename'|'onDiscard'|'discardDisabled'|'onExport'|'onUpdate'|'onHistory'|'onEditJson'>):JSX.Element{
 const renderMenu=useCallback((openUsage?: (anchor:HTMLElement)=>void,fullTrigger?:ReactNode)=><Box sx={{display:"flex",alignItems:"center",gap:.5}}>{fullTrigger}<ChatOverflowMenu label="Branch actions" showExports={false} transcriptMarkdown="" transcriptFileName="" actions={[
  ...(openUsage&&!fullTrigger?[{label:'Provider usage',icon:<DataUsageOutlined fontSize="small"/>,onSelect:openUsage}]:[]),
  {label:'Rename…',onSelect:onRename},
  ...(onHistory?[{label:'Version history',onSelect:onHistory}]:[]),
  ...(onEditJson?[{label:'Edit workflow JSON…',onSelect:onEditJson}]:[]),
  {label:'Discard changes',onSelect:()=>onDiscard?.(),disabled:discardDisabled},
  {label:'Export template',onSelect:()=>onExport('template')},
  {label:'Export full',onSelect:()=>onExport('full')},
  {label:'Apply package update…',onSelect:onUpdate},
 ]}/></Box>,[onRename,onDiscard,discardDisabled,onExport,onUpdate,onHistory,onEditJson]);
 return <PrimaryHeaderActionsOutlet renderTrigger={renderMenu} fallback={renderMenu()}/>;
}
