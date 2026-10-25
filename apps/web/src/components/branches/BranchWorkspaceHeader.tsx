import AccountTreeOutlined from '@mui/icons-material/AccountTreeOutlined';
import ChatBubbleOutline from '@mui/icons-material/ChatBubbleOutline';
import PlayCircleOutline from '@mui/icons-material/PlayCircleOutline';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import SaveOutlined from '@mui/icons-material/SaveOutlined';
import {Box,IconButton,Tooltip} from '@mui/material';
import type {BranchTab} from '../../branchesRouting';
import {TabbedWorkspaceFrame} from '../WorkspaceFrame';
import {SemanticStatus} from '../SemanticStatus';
import {ChatOverflowMenu} from '../ChatOverflowMenu';

/** Branch actions adapt the shared workspace chrome; publication stays with its owner. */
export function BranchWorkspaceHeader({name,tab,published,dirty,executionCount,executionsUnavailable=false,saving,saveDisabled,onTab,onSave,onExport,onUpdate,onRename,onDiscard,discardDisabled=true}:{
 name:string;tab:BranchTab;published:boolean;dirty:boolean;executionCount?:number;executionsUnavailable?:boolean;saving:boolean;saveDisabled:boolean;
 onTab(tab:BranchTab):void;onSave():void;onExport(mode:'template'|'full'):void;onUpdate():void;onRename():void;onDiscard?():void;discardDisabled?:boolean;
}):JSX.Element{
 const tabs={idPrefix:'branch',value:tab,label:'Branch views',onChange:onTab,items:[
  {value:'workflow' as const,label:'Workflow',icon:<AccountTreeOutlined/>},
  {value:'chats' as const,label:'Chats',icon:<ChatBubbleOutline/>},
  {value:'executions' as const,label:'Executions',icon:<PlayCircleOutline/>,disabled:!published},
  {value:'settings' as const,label:'Settings',icon:<SettingsOutlined/>},
 ]};
 return <Box sx={{flexShrink:0,minWidth:0}}><TabbedWorkspaceFrame icon={<AccountTreeOutlined/>} title={name} compactMobile retainCollapsedActions statusBeforePrimaryActions
  status={<Box sx={{display:'flex',gap:.5,alignItems:'center',flexShrink:0,minWidth:0,maxWidth:{xs:104,sm:'none'},'& .MuiChip-root':{maxWidth:'100%',height:'auto',minHeight:24},'& .MuiChip-label':{whiteSpace:'normal',lineHeight:1.2,py:.5,px:1}}}><SemanticStatus status={executionsUnavailable?'needs_attention':executionCount===undefined?'waiting':executionCount>0?'running':'idle'} label={executionsUnavailable?'Executions unavailable':executionCount===undefined?'Executions loading…':`${executionCount} active executions`}/>{(dirty||!published)&&<Tooltip describeChild title={dirty?'Unpublished workflow changes. Use Save to review and publish, or Discard changes.':'Unpublished workflow — review and publish to run'}><Box component="span" role="img" tabIndex={0} aria-label={dirty?'Unpublished changes':'Unpublished workflow'} sx={{color:'warning.main',flexShrink:0,lineHeight:1,px:.25,py:.5,borderRadius:.5,'&:focus-visible':{outline:'2px solid',outlineColor:'primary.main',outlineOffset:2}}}>●</Box></Tooltip>}</Box>}
  actions={<>
   <Tooltip title="Save changes…"><span><IconButton aria-label="Save changes…" aria-description="Review changes before publishing" disabled={saveDisabled} aria-busy={saving||undefined} onClick={onSave}><SaveOutlined/></IconButton></span></Tooltip>
   <ChatOverflowMenu label="Branch actions" showExports={false} transcriptMarkdown="" transcriptFileName="" actions={[
    {label:'Rename…',onSelect:onRename},
    {label:'Discard changes',onSelect:()=>onDiscard?.(),disabled:discardDisabled},
    {label:'Export template',onSelect:()=>onExport('template')},
    {label:'Export full',onSelect:()=>onExport('full')},
    {label:'Apply package update…',onSelect:onUpdate},
   ]}/>
  </>} tabs={tabs}/></Box>;
}
