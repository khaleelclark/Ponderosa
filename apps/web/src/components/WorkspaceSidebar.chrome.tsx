import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
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
import type { Route } from "../routing";
import { IconTitle } from "./IconTitle";
import { sidebarSurface } from "./WorkspaceSidebar.helpers";

const createOptions = [
  {
    kind: "project",
    label: "Project",
    description: "A workspace with its own folder and runtime defaults.",
    icon: <FolderOutlinedIcon />,
  },
  {
    kind: "chat",
    label: "Chat",
    description: "A shared Project conversation for people and Agents.",
    icon: <ChatBubbleOutlineIcon />,
  },
  {
    kind: "agent",
    label: "Agent",
    description: "A managed worker with its own role and provider session.",
    icon: <SmartToyOutlinedIcon />,
  },
  {
    kind: "trigger",
    label: "Automation",
    description: "Automation that starts Agent work from an event.",
    icon: <BoltOutlinedIcon />,
  },
] as const;

export function CreateSidebarPanel({
  selected,
  drawer,
  onCreate,
}: {
  selected?: "project" | "chat" | "agent" | "trigger";
  drawer: boolean;
  onCreate(kind: "project" | "chat" | "agent" | "trigger"): void;
}): JSX.Element {
  return (
    <Box
      sx={{
        minHeight: 0,
        minWidth: 0,
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        bgcolor: sidebarSurface,
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          pl: 2.25,
          pr: drawer ? 7 : 2.25,
          pt: 2,
          pb: 1.25,
        }}
      >
        <IconTitle icon={<AddIcon />} title="Create" />
      </Stack>
      <List
        component="nav"
        aria-label="Choose what to create"
        sx={{ px: 1.25, pb: 2 }}
      >
        {createOptions.map(option => (
          <ListItemButton
            key={option.kind}
            selected={selected === option.kind}
            onClick={() => onCreate(option.kind)}
            sx={{
              borderRadius: 1.25,
              alignItems: "flex-start",
              px: 1.25,
              py: 1.15,
              mb: 0.5,
            }}
          >
            <ListItemIcon sx={{ minWidth: 38, mt: 0.1 }}>
              {option.icon}
            </ListItemIcon>
            <ListItemText
              primary={option.label}
              secondary={option.description}
              primaryTypographyProps={{ fontWeight: 750, fontSize: 14 }}
              secondaryTypographyProps={{
                fontSize: 11.5,
                lineHeight: 1.35,
                sx: { mt: 0.25 },
              }}
            />
          </ListItemButton>
        ))}
      </List>
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
          selected={route.kind === "settings" && (route.section ?? "general") === "general"}
          onClick={() => onNavigate({ kind: "settings", section: "general" })}
          sx={{ borderRadius: 1.25 }}
        >
          <ListItemIcon>
            <SettingsOutlinedIcon />
          </ListItemIcon>
          <ListItemText primary="General" secondary="Appearance and Agent defaults" />
        </ListItemButton>
        <ListItemButton
          selected={route.kind === "settings" && route.section === "providers"}
          onClick={() => onNavigate({ kind: "settings", section: "providers" })}
          sx={{ borderRadius: 1.25 }}
        >
          <ListItemIcon>
            <SmartToyOutlinedIcon />
          </ListItemIcon>
          <ListItemText primary="AI Providers" secondary="Availability, models, and reasoning" />
        </ListItemButton>
        <ListItemButton
          selected={route.kind === "settings" && route.section === "notifications"}
          onClick={() => onNavigate({ kind: "settings", section: "notifications" })}
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
          onClick={() =>
            onNavigate({ kind: "settings", section: "activity" })
          }
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
