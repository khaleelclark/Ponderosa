import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import NotificationsNoneOutlinedIcon from "@mui/icons-material/NotificationsNoneOutlined";
import SearchIcon from "@mui/icons-material/Search";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Box,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { WikiIndexDto } from "@ponderosa/core";
import type { Route } from "../routing";
import { IconTitle } from "./IconTitle";
import {
  SIDEBAR_RAIL_WIDTH,
  railSurface,
  sidebarSurface,
} from "./WorkspaceSidebar.helpers";
import { RailButton, SidebarSectionHeading } from "./WorkspaceSidebar.parts";

export function WorkspaceSidebarRail({
  drawer,
  runningCount,
  showingAgents,
  showingChats,
  showingHome,
  showingCreate,
  showingProjects,
  showingSettings,
  showingTriggers,
  showingWiki,
  onShowAgents,
  onShowChats,
  onShowHome,
  onShowCreate,
  onShowProjects,
  onShowSettings,
  onShowTriggers,
  onShowWiki,
}: {
  drawer: boolean;
  runningCount: number;
  showingAgents: boolean;
  showingChats: boolean;
  showingHome: boolean;
  showingCreate: boolean;
  showingProjects: boolean;
  showingSettings: boolean;
  showingTriggers: boolean;
  showingWiki: boolean;
  onShowAgents(): void;
  onShowChats(): void;
  onShowHome(): void;
  onShowCreate(): void;
  onShowProjects(): void;
  onShowSettings(): void;
  onShowTriggers(): void;
  onShowWiki(): void;
}): JSX.Element {
  return (
    <Box
      component="nav"
      aria-label={drawer ? "Primary navigation drawer" : "Primary navigation"}
      sx={{
        width: drawer ? 64 : SIDEBAR_RAIL_WIDTH,
        minWidth: drawer ? 64 : SIDEBAR_RAIL_WIDTH,
        minHeight: 0,
        borderRight: 1,
        borderColor: "var(--ponderosa-rail-border)",
        bgcolor: railSurface,
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr) auto",
        justifyItems: "center",
        py: 1.5,
      }}
    >
      <Stack spacing={0.4} sx={{ alignItems: "center" }}>
        <Tooltip title="Ponderosa" placement="right">
          <Box
            component="img"
            src="/icons/app-icon.png"
            alt="Ponderosa"
            sx={{
              width: 42,
              height: 42,
              mb: 3.25,
              p: 0.25,
              borderRadius: 1,
              objectFit: "cover",
            }}
          />
        </Tooltip>
        <RailButton label="Home" selected={showingHome} onClick={onShowHome}>
          <HomeOutlinedIcon />
        </RailButton>
        <Box
          aria-hidden
          sx={{
            width: 40,
            borderTop: 1,
            borderColor: "var(--ponderosa-rail-border)",
            my: 0.5,
          }}
        />
        <RailButton label="Projects" selected={showingProjects} onClick={onShowProjects}>
          <FolderOutlinedIcon />
        </RailButton>
        <RailButton label="Chats" selected={showingChats} onClick={onShowChats}>
          <ChatBubbleOutlineIcon />
        </RailButton>
        <RailButton
          label="Agents"
          selected={showingAgents}
          badge={runningCount || undefined}
          badgeColor="info"
          onClick={onShowAgents}
        >
          <SmartToyOutlinedIcon />
        </RailButton>
        <RailButton label="Triggers" selected={showingTriggers} onClick={onShowTriggers}>
          <BoltOutlinedIcon />
        </RailButton>
      </Stack>
      <Box />
      <Stack spacing={0.65} sx={{ alignItems: "center" }}>
        <RailButton label="Create" selected={showingCreate} onClick={onShowCreate}>
          <AddIcon />
        </RailButton>
        <Box
          aria-hidden
          sx={{
            width: 40,
            borderTop: 1,
            borderColor: "var(--ponderosa-rail-border)",
            mb: 0.25,
          }}
        />
        <RailButton label="Wiki" selected={showingWiki} onClick={onShowWiki}>
          <MenuBookOutlinedIcon />
        </RailButton>
        <RailButton label="Settings" selected={showingSettings} onClick={onShowSettings}>
          <SettingsOutlinedIcon />
        </RailButton>
      </Stack>
    </Box>
  );
}

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
    label: "Trigger",
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

export function WikiSidebarPanel({
  activeArticleId,
  drawer,
  filter,
  isError,
  isLoading,
  sections,
  onFilterChange,
  onNavigateArticle,
  onOpenArticleMenu,
}: {
  activeArticleId?: string;
  drawer: boolean;
  filter: string;
  isError: boolean;
  isLoading: boolean;
  sections: WikiIndexDto["sections"];
  onFilterChange(value: string): void;
  onNavigateArticle(articleId: string): void;
  onOpenArticleMenu(anchor: HTMLElement, articleId: string): void;
}): JSX.Element {
  return (
    <Box
      sx={{
        minHeight: 0,
        minWidth: 0,
        display: "grid",
        gridTemplateRows: "auto auto minmax(0, 1fr)",
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
        <IconTitle icon={<MenuBookOutlinedIcon />} title="Wiki" />
      </Stack>
      <Box sx={{ px: 1.75, pb: 1.5 }}>
        <TextField
          fullWidth
          size="small"
          value={filter}
          onChange={event => onFilterChange(event.target.value)}
          placeholder="Search Wiki"
          inputProps={{ "aria-label": "Search Wiki" }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          }}
        />
      </Box>
      <Box
        component="nav"
        aria-label="Wiki navigation"
        data-testid="workspace-navigation-scroll"
        className="ponderosa-scroll"
        sx={{ minHeight: 0, overflowY: "auto", px: 1.25, pb: 2 }}
      >
        {isLoading ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            Loading Wiki…
          </Typography>
        ) : null}
        {isError ? (
          <Typography variant="body2" color="error" sx={{ p: 1 }}>
            Wiki navigation could not be loaded.
          </Typography>
        ) : null}
        {sections.map(section => (
          <Box component="section" key={section.id} sx={{ mb: 2 }}>
            <SidebarSectionHeading>{section.title}</SidebarSectionHeading>
            <List dense disablePadding>
              {section.articles.map(article => (
                <ListItemButton
                  key={article.id}
                  selected={article.id === activeArticleId}
                  onClick={() => onNavigateArticle(article.id)}
                  onContextMenu={event => {
                    event.preventDefault();
                    onOpenArticleMenu(event.currentTarget, article.id);
                  }}
                  sx={{ borderRadius: 1.25, mb: 0.25 }}
                >
                  <ListItemText
                    primary={article.title}
                    primaryTypographyProps={{
                      fontSize: 13,
                      fontWeight: article.id === activeArticleId ? 800 : 600,
                    }}
                  />
                </ListItemButton>
              ))}
            </List>
          </Box>
        ))}
        {!isLoading && sections.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            {filter.trim()
              ? `No Wiki articles match “${filter.trim()}”.`
              : "No Wiki articles are available."}
          </Typography>
        ) : null}
      </Box>
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
