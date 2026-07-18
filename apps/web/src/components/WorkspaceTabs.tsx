import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import CloseIcon from "@mui/icons-material/Close";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import { Box, ButtonBase, IconButton, Menu, MenuItem, Stack, Tooltip, Typography } from "@mui/material";
import type { ProjectDto } from "@ponderosa/core";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import type { Route } from "../routing";
import { routeProjectId } from "../routing";
import type { WorkspaceTabState } from "../workspaceTabs";
import { workspaceTabKey } from "../workspaceTabs";
import { TokenUsageButton } from "./TokenUsageButton";

function TabIcon({ kind }: { kind: WorkspaceTabState["route"]["kind"] }): JSX.Element {
  if (kind === "conversation") return <ChatBubbleOutlineIcon fontSize="small" />;
  if (kind === "agent") return <SmartToyOutlinedIcon fontSize="small" />;
  if (kind === "agents") return <GroupsOutlinedIcon fontSize="small" />;
  return <FolderOutlinedIcon fontSize="small" />;
}

export function WorkspaceTabs({ tabs, projects, route, navigate, onClose, onCloseAll }: {
  tabs: WorkspaceTabState[];
  projects: ProjectDto[];
  route: Route;
  navigate(route: Route): void;
  onClose(key: string): void;
  onCloseAll(): void;
}): JSX.Element {
  const [contextMenu, setContextMenu] = useState<{ anchor: HTMLElement; key: string; label: string }>();
  const projectIds = [...new Set(tabs.map((tab) => tab.route.projectId))];
  const conversationQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["conversations", projectId],
      queryFn: () => api.listConversations(projectId),
      staleTime: 10_000,
    })),
  });
  const agentQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["agents", projectId],
      queryFn: () => api.listAgents(projectId),
      staleTime: 10_000,
    })),
  });
  const resourcesByProject = new Map(projectIds.map((projectId, index) => [projectId, {
    conversations: conversationQueries[index]?.data ?? [],
    agents: agentQueries[index]?.data ?? [],
  }]));
  const activeKey = workspaceTabKey(route);
  const activeProjectId = routeProjectId(route);

  return <Stack component="nav" aria-label="Open workspace views" direction="row" sx={{ display: { xs: "none", md: "flex" }, minWidth: 0, minHeight: { md: 58 }, px: 1, bgcolor: "background.paper", alignItems: "stretch", boxShadow: (theme) => `inset 0 -1px 0 ${theme.palette.divider}` }}>
    <Stack direction="row" className="ponderosa-scroll" sx={{ minWidth: 0, flex: 1, overflowX: "auto", alignItems: "stretch" }}>
      <ButtonBase onClick={() => navigate({ kind: "home" })} aria-current={route.kind === "home" ? "page" : undefined} sx={{ position: "relative", minWidth: 112, height: 58, px: 1.5, gap: 1, color: route.kind === "home" ? "text.primary" : "text.secondary", justifyContent: "flex-start", "&:hover": { bgcolor: "action.hover", color: "text.primary" }, "&::after": route.kind === "home" ? { content: '""', position: "absolute", left: 12, right: 12, bottom: 0, height: 2, bgcolor: "primary.light" } : undefined }}>
        <HomeOutlinedIcon fontSize="small" />
        <Typography variant="body2" fontWeight={route.kind === "home" ? 750 : 500}>Home</Typography>
      </ButtonBase>
      {tabs.map((tab) => {
        const project = projects.find((candidate) => candidate.id === tab.route.projectId);
        const resources = resourcesByProject.get(tab.route.projectId);
        const conversationId = tab.route.kind === "conversation" ? tab.route.conversationId : undefined;
        const agentId = tab.route.kind === "agent" ? tab.route.agentId : undefined;
        const label = tab.route.kind === "conversation"
          ? resources?.conversations.find((conversation) => conversation.id === conversationId)?.title ?? "Project Chat"
          : tab.route.kind === "agent"
            ? resources?.agents.find((agent) => agent.id === agentId)?.title ?? "Agent"
            : tab.route.kind === "agents" ? "Agents" : "Project files";
        const selected = tab.key === activeKey;
        const projectLabel = project?.label ?? "Unavailable project";
        return <Box key={tab.key} data-tab-key={tab.key} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ anchor: event.currentTarget, key: tab.key, label }); }} sx={{ position: "relative", minWidth: 168, maxWidth: 240, height: 58, display: "flex", alignItems: "stretch", overflow: "hidden", color: selected ? "text.primary" : "text.secondary", bgcolor: selected ? "action.selected" : "transparent", "&:hover": { bgcolor: "action.hover", color: "text.primary" }, "&::after": selected ? { content: '""', position: "absolute", left: 12, right: 12, bottom: 0, height: 2, bgcolor: "primary.light" } : undefined }}>
          <Tooltip title={`${label} · ${projectLabel}`} enterDelay={600}>
            <ButtonBase onClick={() => navigate(tab.route)} aria-label={`Open ${label} in ${projectLabel}`} aria-current={selected ? "page" : undefined} sx={{ minWidth: 0, flex: 1, px: 1.25, gap: 1, justifyContent: "flex-start" }}>
              <TabIcon kind={tab.route.kind} />
              <Box sx={{ minWidth: 0, flex: 1, textAlign: "left" }}>
                <Typography variant="body2" fontWeight={selected ? 750 : 600} noWrap>{label}</Typography>
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block", lineHeight: 1.2 }}>{projectLabel}</Typography>
              </Box>
            </ButtonBase>
          </Tooltip>
          <IconButton size="small" aria-label={`Close ${label}`} onClick={() => onClose(tab.key)} sx={{ width: 32, minWidth: 32, minHeight: 32, alignSelf: "center", color: "text.secondary", opacity: selected ? .8 : .45, "&:hover": { color: "text.primary", bgcolor: "transparent", opacity: 1 } }}><CloseIcon sx={{ fontSize: 14 }} /></IconButton>
        </Box>;
      })}
    </Stack>
    <Box sx={{ pl: 1.25, display: "flex", alignItems: "center" }}>
      {activeProjectId ? <TokenUsageButton scope="project" scopeId={activeProjectId} label="Project" /> : <TokenUsageButton scope="overall" label="Overall" />}
    </Box>
    {contextMenu ? <Menu anchorEl={contextMenu.anchor} open onClose={() => setContextMenu(undefined)}>
      <MenuItem onClick={() => { onClose(contextMenu.key); setContextMenu(undefined); }}>Close {contextMenu.label}</MenuItem>
      <MenuItem onClick={() => { onCloseAll(); setContextMenu(undefined); }}>Close all tabs</MenuItem>
    </Menu> : null}
  </Stack>;
}
