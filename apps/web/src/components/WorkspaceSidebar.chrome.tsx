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
}: {
  route: Route;
  version?: string;
  onNavigate(route: Route): void;
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
      <List sx={{ px: 1.25 }}>
        <ListItemButton
          selected={(route.kind === "settings" && route.section === "profile")}
          component="a" href={routeToPath({ kind: "settings", section: "profile" })}
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
          component="a" href={routeToPath({ kind: "settings", section: "general" })}
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
          component="a" href={routeToPath({ kind: "settings", section: "providers" })}
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
          component="a" href={routeToPath({ kind: "settings", section: "notifications" })}
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
          component="a" href={routeToPath({ kind: "settings", section: "activity" })}
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
