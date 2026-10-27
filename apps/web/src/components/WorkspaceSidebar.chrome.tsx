import {ButtonBase,IconButton,Tooltip} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import MenuIcon from '@mui/icons-material/Menu';
import type {OperatorProfileDto} from '@ponderosa/core';
import {OperatorAvatar} from './OperatorAvatar';
import {useWorkspaceSidebarResize} from './useWorkspaceSidebarState';
import {clampWorkspaceSidebarWidth} from '../workspaceSidebarState';
import type {ReactNode} from "react";
import { routeToPath } from "../routeRegistry";
import { isUnmodifiedPrimaryClick } from "../nativeNavigation";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import NotificationsNoneOutlinedIcon from "@mui/icons-material/NotificationsNoneOutlined";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
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
import type { Route } from "../routing";
import { IconTitle } from "./IconTitle";
import { sidebarSurface } from "./WorkspaceSidebar.helpers";

export function SettingsSidebarPanel({
  route,
  version,
  onNavigate,
  hrefForRoute = routeToPath,
}: {
  route: Route;
  version?: string;
  onNavigate(route: Route): void;
  hrefForRoute?(route: Route): string;
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
      <Stack
        direction="row"
        sx={{ alignItems: "center", px: 2.25, pt: 2, pb: 1.25 }}
      >
        <IconTitle icon={<SettingsOutlinedIcon />} title="Settings" />
      </Stack>
      <List sx={{ px: 1.25, minHeight: 0, overflowY: "auto" }}>
        <ListItemButton
          selected={(route.kind === "settings" && route.section === "profile")}
          component="a" href={hrefForRoute({ kind: "settings", section: "profile" })}
          onClick={event => { if (isUnmodifiedPrimaryClick(event)) { event.preventDefault(); onNavigate({ kind: "settings", section: "profile" }); } }}
          sx={{ borderRadius: 1.25 }}
        >
          <ListItemIcon>
            <PersonOutlineIcon />
          </ListItemIcon>
          <ListItemText primary="Operator Profile" secondary="Name, handle, and picture" />
        </ListItemButton>
        <ListItemButton
          selected={route.kind === "settings" && (route.section ?? "general") === "general"}
          component="a" href={hrefForRoute({ kind: "settings", section: "general" })}
          onClick={event => { if (isUnmodifiedPrimaryClick(event)) { event.preventDefault(); onNavigate({ kind: "settings", section: "general" }); } }}
          sx={{ borderRadius: 1.25 }}
        >
          <ListItemIcon>
            <SettingsOutlinedIcon />
          </ListItemIcon>
          <ListItemText primary="General" secondary="Appearance and Agent defaults" />
        </ListItemButton>
        <ListItemButton
          selected={route.kind === "settings" && route.section === "providers"}
          component="a" href={hrefForRoute({ kind: "settings", section: "providers" })}
          onClick={event => { if (isUnmodifiedPrimaryClick(event)) { event.preventDefault(); onNavigate({ kind: "settings", section: "providers" }); } }}
          sx={{ borderRadius: 1.25 }}
        >
          <ListItemIcon>
            <SmartToyOutlinedIcon />
          </ListItemIcon>
          <ListItemText primary="AI Providers" secondary="Availability, models, and reasoning" />
        </ListItemButton>
        <ListItemButton
          selected={route.kind === "settings" && route.section === "notifications"}
          component="a" href={hrefForRoute({ kind: "settings", section: "notifications" })}
          onClick={event => { if (isUnmodifiedPrimaryClick(event)) { event.preventDefault(); onNavigate({ kind: "settings", section: "notifications" }); } }}
          sx={{ borderRadius: 1.25 }}
        >
          <ListItemIcon>
            <NotificationsNoneOutlinedIcon />
          </ListItemIcon>
          <ListItemText primary="Notifications" secondary="In-app and browser attention" />
        </ListItemButton>
        <ListItemButton
          selected={
            (route.kind === "settings" && route.section === "activity") ||
            route.kind === "usage"
          }
          component="a" href={hrefForRoute({ kind: "settings", section: "activity" })}
          onClick={event => { if (isUnmodifiedPrimaryClick(event)) { event.preventDefault(); onNavigate({ kind: "settings", section: "activity" }); } }}
          sx={{ borderRadius: 1.25 }}
        >
          <ListItemIcon>
            <DataUsageOutlinedIcon />
          </ListItemIcon>
          <ListItemText primary="Provider Activity" secondary="Tokens and Run telemetry" />
        </ListItemButton>
      </List>
      <Typography
        variant="caption"
        color="text.disabled"
        sx={{ px: 2.25, pb: 2 }}
      >
        Ponderosa{version ? ` v${version}` : ""}
      </Typography>
    </Box>
  );
}

/** Product-neutral horizontal chrome; directory contents remain product-owned. */
export function SidebarHeader({title='Ponderosa',drawer=false,homeLabel=`${title} home`,selected=false,hideTitle=false,onHome,onCollapse,actions}:{title?:string;drawer?:boolean;homeLabel?:string;selected?:boolean;hideTitle?:boolean;onHome():void;onCollapse?():void;actions?:ReactNode}):JSX.Element {
 return <Stack component="nav" aria-label="Workspace navigation" data-workspace-sidebar-header direction="row" alignItems="center" gap={.25} sx={{gridRow:1,px:1.25,py:.75,minWidth:0,borderBottom:1,borderColor:'divider','& > .MuiIconButton-root':{flexShrink:0}}}>
  <ButtonBase aria-label={homeLabel} aria-current={selected?'page':undefined} onClick={onHome} sx={{flex:hideTitle?'0 0 44px':1,minWidth:0,minHeight:44,justifyContent:hideTitle?'center':'flex-start',gap:.75,borderRadius:1.5,px:.5,py:.25,bgcolor:selected?'action.selected':'transparent','&:hover':{bgcolor:'action.hover'}}}>
   <Box component="img" src="/icons/app-icon.png" alt="" sx={{width:32,height:32,flex:'0 0 32px',borderRadius:1,objectFit:'cover'}}/>
   {!hideTitle&&<Typography noWrap sx={{minWidth:0,fontSize:16,fontWeight:750}}>{title}</Typography>}
  </ButtonBase>
  {actions}
  {onCollapse&&<Tooltip title={drawer?'Close navigation':'Collapse sidebar'}><IconButton aria-label={drawer?'Close workspace navigation':'Collapse sidebar'} onClick={onCollapse}>{drawer?<CloseIcon fontSize="small"/>:<MenuIcon/>}</IconButton></Tooltip>}
 </Stack>;
}

export function SidebarOperatorFooter({profile,onSettings,drawer=false}:{profile:OperatorProfileDto;onSettings():void;drawer?:boolean}):JSX.Element {
 return (
      <Box
        data-workspace-sidebar-profile
        sx={{
          gridRow: 4,
          minWidth: 0,
          borderTop: 1,
          borderColor: "divider",
          px: 1,
          pt: 0.75,
          pb: drawer ? "max(6px, env(safe-area-inset-bottom))" : 0.75,
        }}
      >
        <ButtonBase
          aria-label="Open settings"
          onClick={onSettings}
          sx={{
            width: "100%",
            minWidth: 0,
            minHeight: 48,
            justifyContent: "flex-start",
            gap: 1,
            px: 0.75,
            borderRadius: 1.5,
            textAlign: "left",
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <OperatorAvatar profile={profile} size={34} />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography noWrap sx={{ fontSize: 14, fontWeight: 700 }}>
              {profile.displayName || "Operator"}
            </Typography>
            {profile.handle ? (
              <Typography noWrap variant="caption" color="text.secondary">
                #{profile.handle.replace(/^[@#]/, "")}
              </Typography>
            ) : null}
          </Box>
        </ButtonBase>
      </Box>
 );
}

export function SharedSidebarFrame({children,drawer=false,collapsed=false,width=390,onWidthChange,label='Workspace navigation'}:{children:ReactNode;drawer?:boolean;collapsed?:boolean;width?:number;onWidthChange?(width:number):void;label?:string}):JSX.Element|null {
 const {resizing,resizeStart}=useWorkspaceSidebarResize(width,onWidthChange);
 if(collapsed&&!drawer)return null;
 return <Box component="aside" aria-label={label} sx={{position:'relative',width:drawer?'min(92vw, 390px)':width,maxWidth:'100vw',height:'100%',minWidth:0,minHeight:0,borderRight:1,borderColor:'divider',display:'grid',gridTemplateColumns:'minmax(0,1fr)',gridTemplateRows:'auto auto minmax(0,1fr) auto',bgcolor:sidebarSurface,overflow:'hidden',transition:resizing?'none':'width 180ms cubic-bezier(0.2, 0, 0, 1)','@media (prefers-reduced-motion: reduce)':{transition:'none'}}}>
  {children}
  {!drawer&&onWidthChange&&<Box role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuenow={width} tabIndex={0} onPointerDown={resizeStart} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();onWidthChange(clampWorkspaceSidebarWidth(width+(e.key==='ArrowRight'?16:-16)))}}} sx={{position:'absolute',zIndex:2,insetBlock:0,right:0,width:12,cursor:'col-resize',touchAction:'none','&::after':{content:'""',position:'absolute',insetBlock:0,left:5,width:2},'&:hover::after,&:focus-visible::after':{bgcolor:'primary.main'}}}/>}
 </Box>;
}
