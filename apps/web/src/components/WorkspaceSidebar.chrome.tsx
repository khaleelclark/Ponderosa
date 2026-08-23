import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
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
  Typography,
} from "@mui/material";
import type { WikiIndexDto, WikiSearchResultDto } from "@ponderosa/core";
import type { Route } from "../routing";
import { IconTitle } from "./IconTitle";
import { sidebarSurface } from "./WorkspaceSidebar.helpers";
import { SidebarSectionHeading } from "./WorkspaceSidebar.parts";

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

export function WikiSidebarPanel({
  activeArticleId,
  drawer,
  filter,
  isError,
  isLoading,
  sections,
  searchError,
  searchLoading,
  searchResults,
  searchTotal,
  hasMoreSearchResults,
  loadingMoreSearchResults,
  onFilterChange,
  onLoadMoreSearchResults,
  onNavigateArticle,
  onOpenArticleMenu,
}: {
  activeArticleId?: string;
  drawer: boolean;
  filter: string;
  isError: boolean;
  isLoading: boolean;
  sections: WikiIndexDto["sections"];
  searchError: boolean;
  searchLoading: boolean;
  searchResults: WikiSearchResultDto[];
  searchTotal: number;
  hasMoreSearchResults: boolean;
  loadingMoreSearchResults: boolean;
  onFilterChange(value: string): void;
  onLoadMoreSearchResults(): void;
  onNavigateArticle(articleId: string): void;
  onOpenArticleMenu(anchor: HTMLElement, articleId: string): void;
}): JSX.Element {
  const searchText = filter.trim();
  const searching = Boolean(searchText);
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
        className="ponderosa-scroll"
        sx={{ minHeight: 0, overflowY: "auto", px: 1.25, pb: 2 }}
      >
        {!searching && isLoading ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            Loading Wiki…
          </Typography>
        ) : null}
        {!searching && isError ? (
          <Typography variant="body2" color="error" sx={{ p: 1 }}>
            Wiki navigation could not be loaded.
          </Typography>
        ) : null}
        {searching && searchText.length < 2 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            Type at least two characters to search article text.
          </Typography>
        ) : null}
        {searching && searchText.length >= 2 && searchLoading ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            Searching Wiki…
          </Typography>
        ) : null}
        {searching && searchText.length >= 2 && searchError &&
        searchResults.length === 0 ? (
          <Typography variant="body2" color="error" sx={{ p: 1 }}>
            Wiki search could not be loaded.
          </Typography>
        ) : null}
        {searching && !searchLoading && searchResults.length > 0 ? (
          <Box component="section" sx={{ mb: 2 }}>
            <SidebarSectionHeading>
              {searchTotal === 1 ? "1 Result" : `${searchTotal} Results`}
            </SidebarSectionHeading>
            <List dense disablePadding>
              {searchResults.map(result => (
                <ListItemButton
                  key={result.article.id}
                  selected={result.article.id === activeArticleId}
                  onClick={() => onNavigateArticle(result.article.id)}
                  onContextMenu={event => {
                    event.preventDefault();
                    onOpenArticleMenu(event.currentTarget, result.article.id);
                  }}
                  sx={{
                    borderRadius: 1.25,
                    alignItems: "flex-start",
                    py: 0.8,
                    mb: 0.35,
                  }}
                >
                  <ListItemText
                    primary={result.article.title}
                    secondary={result.snippet}
                    primaryTypographyProps={{
                      fontSize: 13,
                      fontWeight: result.article.id === activeArticleId ? 800 : 650,
                    }}
                    secondaryTypographyProps={{
                      fontSize: 11.5,
                      lineHeight: 1.4,
                      sx: {
                        mt: 0.25,
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 2,
                        overflow: "hidden",
                      },
                    }}
                  />
                </ListItemButton>
              ))}
              {hasMoreSearchResults ? (
                <ListItemButton
                  disabled={loadingMoreSearchResults}
                  onClick={onLoadMoreSearchResults}
                  sx={{ borderRadius: 1.25, mt: 0.5 }}
                >
                  <ListItemText
                    primary={loadingMoreSearchResults
                      ? "Loading more results…"
                      : searchError
                        ? "Retry loading results"
                        : "Load more results"}
                    primaryTypographyProps={{
                      color: "primary.main",
                      fontSize: 12.5,
                      fontWeight: 750,
                    }}
                  />
                </ListItemButton>
              ) : null}
              {searchError ? (
                <Typography color="error" variant="caption" sx={{ px: 1, py: 0.75 }}>
                  More Wiki results could not be loaded. The results above are still available.
                </Typography>
              ) : null}
            </List>
          </Box>
        ) : null}
        {!searching && sections.map(section => (
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
        {searching && searchText.length >= 2 && !searchLoading &&
        !searchError && searchResults.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            {`No Wiki articles match “${searchText}”.`}
          </Typography>
        ) : null}
        {!searching && !isLoading && !isError && sections.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            No Wiki articles are available.
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
