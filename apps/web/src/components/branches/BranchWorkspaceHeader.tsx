import {useCallback,type ReactNode} from 'react';
import DataUsageOutlined from '@mui/icons-material/DataUsageOutlined';
import {PrimaryHeaderActionsOutlet} from '../PrimaryHeaderActions';
import AccountTreeOutlined from '@mui/icons-material/AccountTreeOutlined';
import ChatBubbleOutline from '@mui/icons-material/ChatBubbleOutline';
import PlayCircleOutline from '@mui/icons-material/PlayCircleOutline';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import SaveOutlined from '@mui/icons-material/SaveOutlined';
import {Box,IconButton,Tooltip} from '@mui/material';
import type {BranchTab} from '../../branchesRouting';
import {TabbedWorkspaceFrame} from '../WorkspaceFrame';
import {SemanticStatus,SemanticStatusCircle,semanticStatusColorToken} from '../SemanticStatus';
import {ChatOverflowMenu} from '../ChatOverflowMenu';

/** Branch actions adapt the shared workspace chrome; publication stays with its owner. */
export function BranchWorkspaceHeader({name,tab,published,dirty,executionCount,executionsUnavailable=false,saving,saveDisabled,onTab,onSave,onExport,onUpdate,onRename,onHistory,onEditJson,onDiscard,discardDisabled=true}:{
 name:string;tab:BranchTab;published:boolean;dirty:boolean;executionCount?:number;executionsUnavailable?:boolean;saving:boolean;saveDisabled:boolean;
 onTab(tab:BranchTab):void;onSave():void;onExport(mode:'template'|'full'):void;onUpdate():void;onRename():void;onHistory?():void;onEditJson?():void;onDiscard?():void;discardDisabled?:boolean;
}):JSX.Element{
 const tabs={idPrefix:'branch',value:tab,label:'Branch views',onChange:onTab,items:[
  {value:'workflow' as const,label:'Workflow',icon:<AccountTreeOutlined/>},
  {value:'chats' as const,label:'Chats',icon:<ChatBubbleOutline/>},
  {value:'executions' as const,label:'Executions',icon:<PlayCircleOutline/>,disabled:!published},
  {value:'settings' as const,label:'Settings',icon:<SettingsOutlined/>},
 ]};
 const executionStatus=executionsUnavailable?'needs_attention':executionCount===undefined?'waiting':executionCount>0?'running':'idle';
 const executionLabel=executionsUnavailable?'Executions unavailable':executionCount===undefined?'Executions loading…':`${executionCount} active executions`;
 return <Box sx={{flexShrink:0,minWidth:0}}><TabbedWorkspaceFrame icon={<AccountTreeOutlined/>} title={name} compactMobile collapsedIconTabs retainCollapsedActions statusBeforePrimaryActions
  status={<Box sx={{display:'flex',gap:.5,alignItems:'center',flexShrink:0,minWidth:0,maxWidth:{xs:104,sm:'none'},'& .MuiChip-root':{maxWidth:'100%',height:'auto',minHeight:24},'& .MuiChip-label':{whiteSpace:'normal',lineHeight:1.2,py:.5,px:1}}}><Box sx={{display:'flex','@container (max-width: 40rem)':{display:'none'}}}><SemanticStatus status={executionStatus} label={executionLabel}/></Box><Tooltip describeChild title={executionLabel}><Box component="span" role="img" tabIndex={0} aria-label={executionLabel} sx={{display:'none',alignItems:'center',gap:.5,px:.5,minHeight:24,whiteSpace:'nowrap',fontSize:12,borderRadius:.5,'@container (max-width: 40rem)':{display:'inline-flex'},'&:focus-visible':{outline:'2px solid',outlineColor:'primary.main',outlineOffset:-2}}}><Box component="span" aria-hidden sx={theme=>({color:semanticStatusColorToken(executionStatus,theme.palette.mode)})}><SemanticStatusCircle/></Box>{executionsUnavailable?'!':executionCount??'…'}</Box></Tooltip>{dirty&&<Tooltip describeChild title="Unpublished workflow changes. Use Review & publish, or Discard changes."><Box component="span" role="img" tabIndex={0} aria-label="Unpublished changes" sx={{color:'warning.main',display:'inline-flex',alignItems:'center',flexShrink:0,lineHeight:1,px:'3px',py:.5,borderRadius:.5,'&:focus-visible':{outline:'2px solid',outlineColor:'primary.main',outlineOffset:-2}}}><SemanticStatusCircle/></Box></Tooltip>}</Box>}
  primaryActions={<BranchHeaderActions onRename={onRename} onDiscard={onDiscard} discardDisabled={discardDisabled} onExport={onExport} onUpdate={onUpdate} onHistory={onHistory} onEditJson={onEditJson}/>}
  actions={<Tooltip title="Review & publish"><span><IconButton aria-label="Review & publish" aria-description="Review changes before publishing" disabled={saveDisabled} aria-busy={saving||undefined} onClick={onSave}><SaveOutlined/></IconButton></span></Tooltip>} tabs={tabs}/></Box>;
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
