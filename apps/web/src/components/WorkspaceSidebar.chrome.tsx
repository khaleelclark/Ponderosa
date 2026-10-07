import {ButtonBase,IconButton,Tooltip,Menu,MenuItem} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import type {OperatorProfileDto} from '@ponderosa/core';
import {useState} from 'react';
import {OperatorAvatar} from './OperatorAvatar';
import {useWorkspaceSidebarResize} from './useWorkspaceSidebarState';
import {clampWorkspaceSidebarWidth} from '../workspaceSidebarState';
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import NotificationsNoneOutlinedIcon from "@mui/icons-material/NotificationsNoneOutlined";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Typography,
} from "@mui/material";
import type { ReactNode } from "react";
import type { Route } from "../routing";
import { IconTitle } from "./IconTitle";
import { sidebarSurface } from "./WorkspaceSidebar.helpers";

export type SettingsNavigationItem<Id extends string> = {
  id: Id;
  label: string;
  description: string;
  icon: ReactNode;
};

/** Shared settings navigation used by every Ponderosa product surface. */
export function SettingsNavigationPanel<Id extends string>({
  title,
  icon,
  items,
  selected,
  onSelect,
  footer,
}: {
  title: string;
  icon: ReactNode;
  items: readonly SettingsNavigationItem<Id>[];
  selected: Id;
  onSelect(id: Id): void;
  footer?: ReactNode;
}): JSX.Element {
  return (
    <Box
      sx={{
        minHeight: 0,
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr) auto",
        bgcolor: sidebarSurface,
      }}
    >
      <Stack direction="row" sx={{ alignItems: "center", px: 2.25, pt: 2, pb: 1.25 }}>
        <IconTitle icon={icon} title={title} />
      </Stack>
      <List sx={{ px: 1.25, py: 0.5 }}>
        {items.map(item => (
          <ListItemButton key={item.id} selected={selected === item.id}
            aria-current={selected === item.id ? "page" : undefined}
            onClick={() => onSelect(item.id)} sx={{ borderRadius: 1.25 }}>
            <ListItemIcon>{item.icon}</ListItemIcon>
            <ListItemText primary={item.label} secondary={item.description} />
          </ListItemButton>
        ))}
      </List>
      {footer}
    </Box>
  );
}

export function SettingsSidebarPanel({
  route,
  version,
  onNavigate,
}: {
  route: Route;
  version?: string;
  onNavigate(route: Route): void;
}): JSX.Element {
  const selected = route.kind === "usage"
    ? "activity"
    : route.kind === "settings"
      ? route.section ?? "general"
      : "general";
  const items = [
    { id: "general", label: "General", description: "Appearance and Agent defaults", icon: <SettingsOutlinedIcon /> },
    { id: "providers", label: "AI Providers", description: "Availability, models, and reasoning", icon: <SmartToyOutlinedIcon /> },
    { id: "notifications", label: "Notifications", description: "In-app and browser attention", icon: <NotificationsNoneOutlinedIcon /> },
    { id: "activity", label: "Provider Activity", description: "Tokens and Run telemetry", icon: <DataUsageOutlinedIcon /> },
  ] as const;
  return <SettingsNavigationPanel
    title="Settings"
    icon={<SettingsOutlinedIcon />}
    items={items}
    selected={selected}
    onSelect={section => onNavigate({ kind: "settings", section })}
    footer={<Typography variant="caption" color="text.disabled" sx={{ px: 2.25, pb: 2 }}>
      Ponderosa{version ? ` v${version}` : ""}
    </Typography>}
  />;
}

/** Product-neutral horizontal chrome; directory contents remain product-owned. */
export function SidebarHeader({title='Ponderosa',drawer,onHome,onCollapse,actions}:{title?:string;drawer?:boolean;onHome():void;onCollapse?():void;actions?:ReactNode}):JSX.Element {
 return <Stack direction="row" alignItems="center" gap={.25} sx={{gridRow:1,p:.75,minWidth:0}}>
  <ButtonBase aria-label={`${title} home`} onClick={onHome} sx={{flex:1,minWidth:0,justifyContent:'flex-start',gap:1,borderRadius:1,minHeight:36,px:.5}}><Box component="img" src="/icons/app-icon.png" alt="" sx={{width:28,height:28}}/><Typography noWrap sx={{fontSize:16,fontWeight:750}}>{title}</Typography></ButtonBase>
  {onCollapse&&<Tooltip title={drawer?'Close navigation':'Collapse navigation'}><IconButton aria-label={drawer?'Close workspace navigation':'Collapse workspace navigation'} onClick={onCollapse}>{drawer?<CloseIcon/>:<ChevronLeftIcon/>}</IconButton></Tooltip>}{actions}
 </Stack>;
}

export function SidebarOperatorFooter({profile,onProfile,onSettings,onActivity,onStatus,onUsage}:{profile:OperatorProfileDto;onProfile():void;onSettings():void;onActivity():void;onStatus():void;onUsage?():void}):JSX.Element {
 const [anchor,setAnchor]=useState<HTMLElement>();
 const close=(action?:()=>void)=>{const trigger=anchor;setAnchor(undefined);requestAnimationFrame(()=>{if(trigger?.isConnected)trigger.focus();action?.()})};
 return <Box sx={{gridRow:4,p:1,pb:'max(6px, env(safe-area-inset-bottom))',borderTop:1,borderColor:'divider',minWidth:0}}>
  <ButtonBase aria-label="Open operator menu" aria-haspopup="menu" aria-expanded={Boolean(anchor)} onClick={e=>setAnchor(e.currentTarget)} sx={{minHeight:48,width:'100%',px:1,gap:1,borderRadius:1,justifyContent:'flex-start'}}><OperatorAvatar profile={profile} size={32}/><Box sx={{minWidth:0,textAlign:'left'}}><Typography noWrap fontSize={14}>{profile.displayName}</Typography><Typography noWrap variant="caption" color="text.secondary">#{profile.handle}</Typography></Box></ButtonBase>
  <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={()=>close()} anchorOrigin={{vertical:'top',horizontal:'left'}} transformOrigin={{vertical:'bottom',horizontal:'left'}}>
   <MenuItem onClick={()=>close(onProfile)}>Operator Profile</MenuItem><MenuItem onClick={()=>close(onSettings)}>Ponderosa Settings</MenuItem><MenuItem onClick={()=>close(onStatus)}>Provider Status</MenuItem>{onUsage&&<MenuItem onClick={()=>close(onUsage)}>Provider Usage</MenuItem>}<MenuItem onClick={()=>close(onActivity)}>Provider Activity</MenuItem>
  </Menu>
 </Box>;
}

export function SharedSidebarFrame({children,drawer=false,collapsed=false,width=390,onWidthChange,label='Workspace navigation'}:{children:ReactNode;drawer?:boolean;collapsed?:boolean;width?:number;onWidthChange?(width:number):void;label?:string}):JSX.Element|null {
 const {resizing,resizeStart}=useWorkspaceSidebarResize(width,onWidthChange);
 if(collapsed&&!drawer)return null;
 return <Box component="aside" aria-label={label} sx={{position:'relative',width:drawer?'min(92vw, 390px)':width,maxWidth:'100vw',height:'100%',minWidth:0,minHeight:0,borderRight:1,borderColor:'divider',display:'grid',gridTemplateColumns:'minmax(0,1fr)',gridTemplateRows:'auto auto minmax(0,1fr) auto',bgcolor:sidebarSurface,overflow:'hidden',transition:resizing?'none':'width 180ms cubic-bezier(0.2, 0, 0, 1)','@media (prefers-reduced-motion: reduce)':{transition:'none'}}}>
  {children}
  {!drawer&&onWidthChange&&<Box role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuenow={width} tabIndex={0} onPointerDown={resizeStart} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();onWidthChange(clampWorkspaceSidebarWidth(width+(e.key==='ArrowRight'?16:-16)))}}} sx={{position:'absolute',zIndex:2,insetBlock:0,right:0,width:12,cursor:'col-resize',touchAction:'none','&::after':{content:'""',position:'absolute',insetBlock:0,left:5,width:2},'&:hover::after,&:focus-visible::after':{bgcolor:'primary.main'}}}/>}
 </Box>;
}
