import {AssistantIcon} from '../AssistantIcon';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import {Button} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import {Box,IconButton,Tooltip} from '@mui/material';
import type {ReactNode} from 'react';
import type {OperatorProfileDto} from '@ponderosa/core';
import type {BranchGlobalView} from '../../branchesRouting';
import {SharedSidebarFrame,SidebarHeader,SidebarOperatorFooter} from '../WorkspaceSidebar.chrome';
export function BranchesSidebar({panel,onAssistant,assistantSelected=false,notifications,drawer=false,collapsed=false,width=390,onCollapsedChange,onWidthChange,onDismiss,onHome,onSearch,profile,onGlobal}:{panel:ReactNode;onAssistant():void;assistantSelected?:boolean;notifications?:ReactNode;drawer?:boolean;collapsed?:boolean;width?:number;onCollapsedChange?(value:boolean):void;onWidthChange?(value:number):void;onDismiss?():void;onHome():void;onSearch():void;profile?:OperatorProfileDto;onGlobal(view:BranchGlobalView):void}):JSX.Element|null {
 return <SharedSidebarFrame drawer={drawer} collapsed={collapsed} width={width} onWidthChange={onWidthChange} label="Branches navigation">
  <SidebarHeader title="Ponderosa" drawer={drawer} onHome={onHome} onCollapse={drawer?onDismiss:()=>onCollapsedChange?.(true)} actions={<><Tooltip title="Search Branch Chats (Ctrl or Command + K)"><IconButton aria-label="Search Branch Chats" onClick={onSearch}><SearchIcon fontSize="small"/></IconButton></Tooltip>{notifications}</>}/>
  <Box component="nav" aria-label="Workspace sections" sx={{gridRow:2,px:1.25,py:.75,display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:.5,borderBottom:1,borderColor:'divider','& .MuiButton-root':{minWidth:0,minHeight:44,fontSize:'.8125rem',fontWeight:600,borderRadius:1.5,color:'text.secondary'},'& .MuiSvgIcon-root':{fontSize:19}}}>
   <Button color="inherit" startIcon={<AssistantIcon/>} onClick={onAssistant} aria-current={assistantSelected?'page':undefined} sx={{bgcolor:assistantSelected?'action.selected':'transparent',color:assistantSelected?'primary.main':undefined}}>Assistant</Button>
   <Button href="/messages" color="inherit" startIcon={<ForumOutlinedIcon/>}>Inbox</Button>
   {assistantSelected&&<><Button href="/home" color="inherit" startIcon={<ChatBubbleOutlineIcon/>}>Chats</Button><Button href="/manage/agents" color="inherit" startIcon={<SmartToyOutlinedIcon/>}>Agents</Button></>}
  </Box>
  <Box sx={{gridRow:3,minHeight:0,minWidth:0,display:'flex','& > *':{flex:1,minWidth:0}}}>{panel}</Box>
  {profile&&<SidebarOperatorFooter profile={profile} drawer={drawer} onSettings={()=>onGlobal('general')}/>}
 </SharedSidebarFrame>;
}
