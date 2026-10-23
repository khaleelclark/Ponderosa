import SearchIcon from '@mui/icons-material/Search';
import {Box,IconButton,Tooltip} from '@mui/material';
import type {ReactNode} from 'react';
import type {OperatorProfileDto} from '@ponderosa/core';
import type {BranchGlobalView} from '../../branchesRouting';
import {SharedSidebarFrame,SidebarHeader,SidebarOperatorFooter} from '../WorkspaceSidebar.chrome';
export function BranchesSidebar({panel,notifications,drawer=false,collapsed=false,width=390,onCollapsedChange,onWidthChange,onDismiss,onHome,onSearch,profile,onGlobal}:{panel:ReactNode;notifications?:ReactNode;drawer?:boolean;collapsed?:boolean;width?:number;onCollapsedChange?(value:boolean):void;onWidthChange?(value:number):void;onDismiss?():void;onHome():void;onSearch():void;profile?:OperatorProfileDto;onGlobal(view:BranchGlobalView):void}):JSX.Element|null {
 return <SharedSidebarFrame drawer={drawer} collapsed={collapsed} width={width} onWidthChange={onWidthChange} label="Branches navigation">
  <SidebarHeader title="Ponderosa Branches" drawer={drawer} onHome={onHome} onCollapse={drawer?onDismiss:()=>onCollapsedChange?.(true)} actions={<><Tooltip title="Search Branch Chats (Ctrl or Command + K)"><IconButton aria-label="Search Branch Chats" onClick={onSearch}><SearchIcon fontSize="small"/></IconButton></Tooltip>{notifications}</>}/>
  <Box sx={{gridRow:3,minHeight:0,minWidth:0,display:'flex','& > *':{flex:1,minWidth:0}}}>{panel}</Box>
  {profile&&<SidebarOperatorFooter profile={profile} drawer={drawer} onSettings={()=>onGlobal('general')}/>}
 </SharedSidebarFrame>;
}
