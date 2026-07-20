import AddIcon from "@mui/icons-material/Add";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import CloseIcon from "@mui/icons-material/Close";
import DifferenceOutlinedIcon from "@mui/icons-material/DifferenceOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Box, Button, ButtonBase, Dialog, DialogActions, DialogContent, DialogTitle,
  IconButton, Menu, MenuItem, Stack, TextField, Tooltip, Typography,
} from "@mui/material";
import type { ProjectDto } from "@ponderosa/core";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { routeProjectId } from "../routing";
import type { WorkspaceTabState } from "../workspaceTabs";
import { TokenUsageButton } from "./TokenUsageButton";

function TabIcon({ kind }: { kind: WorkspaceTabState["route"]["kind"] }): JSX.Element {
  if (kind === "conversation" || kind === "allChat") return <ChatBubbleOutlineIcon fontSize="small" />;
  if (kind === "agent") return <SmartToyOutlinedIcon fontSize="small" />;
  if (kind === "agents" || kind === "allAgents") return <GroupsOutlinedIcon fontSize="small" />;
  if (kind === "review") return <DifferenceOutlinedIcon fontSize="small" />;
  if (kind === "project") return <FolderOutlinedIcon fontSize="small" />;
  if (kind === "wiki") return <MenuBookOutlinedIcon fontSize="small" />;
  return <HomeOutlinedIcon fontSize="small" />;
}

export function WorkspaceTabs({
  tabs, projects, activeKey, onActivate, onCreate, onClose, onCloseOthers, onRename, onReorder,
}: {
  tabs: WorkspaceTabState[];
  projects: ProjectDto[];
  activeKey: string;
  onActivate(key: string): void;
  onCreate(): void;
  onClose(key: string): void;
  onCloseOthers(key: string): void;
  onRename(key: string, title: string): void;
  onReorder(draggedKey: string, targetKey: string): void;
}): JSX.Element {
  const [contextMenu, setContextMenu] = useState<{ anchor: HTMLElement; key: string; label: string }>();
  const [renameTarget, setRenameTarget] = useState<{ key: string; label: string }>();
  const [renameDraft, setRenameDraft] = useState("");
  const [draggedKey, setDraggedKey] = useState<string>();
  const [dragTargetKey, setDragTargetKey] = useState<string>();
  const projectIds = [...new Set(tabs.flatMap((tab) => "projectId" in tab.route ? [tab.route.projectId] : []))];
  const conversationQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["conversations", projectId], queryFn: () => api.listConversations(projectId), staleTime: 10_000,
    })),
  });
  const agentQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["agents", projectId], queryFn: () => api.listAgents(projectId), staleTime: 10_000,
    })),
  });
  const resourcesByProject = new Map(projectIds.map((projectId, index) => [projectId, {
    conversations: conversationQueries[index]?.data ?? [], agents: agentQueries[index]?.data ?? [],
  }]));
  const activeRoute = tabs.find((tab) => tab.key === activeKey)?.route ?? { kind: "home" as const };
  const activeProjectId = routeProjectId(activeRoute);

  const beginRename = (key: string, label: string) => {
    setRenameTarget({ key, label });
    setRenameDraft(label);
    setContextMenu(undefined);
  };

  return <Stack component="nav" aria-label="Open workspace tabs" direction="row" sx={{
    display: { xs: "none", md: "flex" }, minWidth: 0, height: { md: 52 }, px: 1, py: 0.75,
    bgcolor: "background.paper", alignItems: "center", overflow: "hidden", borderBottom: 1, borderColor: "divider",
  }}>
    <Stack direction="row" spacing={0.5} sx={{ minWidth: 0, flex: 1, height: 38, overflow: "hidden", alignItems: "stretch" }}>
      {tabs.map((tab) => {
        const tabRoute = tab.route;
        const projectId = "projectId" in tabRoute ? tabRoute.projectId : undefined;
        const project = projectId ? projects.find((candidate) => candidate.id === projectId) : undefined;
        const resources = projectId ? resourcesByProject.get(projectId) : undefined;
        const generatedLabel = tabRoute.kind === "conversation"
          ? resources?.conversations.find((conversation) => conversation.id === tabRoute.conversationId)?.title ?? "Project Chat"
          : tabRoute.kind === "agent"
            ? resources?.agents.find((agent) => agent.id === tabRoute.agentId)?.title ?? "Agent"
            : tabRoute.kind === "review"
              ? tabRoute.path?.split(/[\\/]/u).at(-1) ?? `${resources?.agents.find((agent) => agent.id === tabRoute.agentId)?.title ?? "Agent"} review`
              : tabRoute.kind === "agents" ? "Agents"
                : tabRoute.kind === "allAgents" ? "All Agents"
                  : tabRoute.kind === "allChat" ? "All Chat"
                  : tabRoute.kind === "project" ? "Project overview"
                    : tabRoute.kind === "wiki" ? "Wiki"
                    : "Projects";
        const label = tab.title ?? generatedLabel;
        const selected = tab.key === activeKey;
        const projectLabel = project?.label ?? (projectId ? "Unavailable project" : "Ponderosa");
        return <Box
          key={tab.key}
          data-tab-key={tab.key}
          data-tab-dragging={draggedKey === tab.key ? "true" : undefined}
          draggable
          onDragStart={(event) => {
            setDraggedKey(tab.key); setDragTargetKey(undefined);
            event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", tab.key);
          }}
          onDragOver={(event) => {
            if (!draggedKey || draggedKey === tab.key) return;
            event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragTargetKey(tab.key);
          }}
          onDragLeave={() => setDragTargetKey((current) => current === tab.key ? undefined : current)}
          onDrop={(event) => {
            event.preventDefault();
            const sourceKey = draggedKey ?? event.dataTransfer.getData("text/plain");
            if (sourceKey && sourceKey !== tab.key) onReorder(sourceKey, tab.key);
            setDraggedKey(undefined); setDragTargetKey(undefined);
          }}
          onDragEnd={() => { setDraggedKey(undefined); setDragTargetKey(undefined); }}
          onContextMenu={(event) => { event.preventDefault(); setContextMenu({ anchor: event.currentTarget, key: tab.key, label }); }}
          onDoubleClick={() => beginRename(tab.key, label)}
          sx={{
            position: "relative", containerType: "inline-size", minWidth: 38, maxWidth: 240, flex: "1 1 200px",
            height: 38, display: "flex", alignItems: "stretch", overflow: "hidden", borderRadius: 2,
            border: 1, borderColor: dragTargetKey === tab.key ? "primary.main" : selected ? "divider" : "transparent",
            color: selected ? "text.primary" : "text.secondary", bgcolor: selected ? "action.selected" : "transparent",
            boxShadow: dragTargetKey === tab.key ? (theme) => `inset 3px 0 0 ${theme.palette.primary.main}` : "none",
            opacity: draggedKey === tab.key ? 0.55 : 1, cursor: draggedKey === tab.key ? "grabbing" : "grab",
            "&:hover": { bgcolor: "action.hover", color: "text.primary" },
          }}
        >
          <Tooltip title={`${label} · ${projectLabel}`} enterDelay={500}>
            <ButtonBase onClick={() => onActivate(tab.key)} aria-label={`Open ${label} in ${projectLabel}`} aria-current={selected ? "page" : undefined} sx={{
              minWidth: 0, flex: 1, px: 1, gap: 0.75, justifyContent: "flex-start", overflow: "hidden",
              "& > svg": { flex: "0 0 auto", fontSize: 18 },
            }}>
              <TabIcon kind={tabRoute.kind} />
              <Typography className="workspace-tab-label" variant="body2" fontWeight={selected ? 750 : 600} noWrap sx={{ minWidth: 0 }}>
                {label}
              </Typography>
            </ButtonBase>
          </Tooltip>
          <IconButton
            size="small" aria-label={`Close ${label}`} disabled={tabs.length === 1}
            onClick={(event) => { event.stopPropagation(); onClose(tab.key); }}
            sx={{
              width: 28, minWidth: 28, height: 28, alignSelf: "center", mr: 0.25, color: "text.secondary",
              opacity: selected ? 0.75 : 0, "&:hover": { color: "text.primary", opacity: 1 },
              "@container (max-width: 86px)": { display: "none" },
            }}
          ><CloseIcon sx={{ fontSize: 14 }} /></IconButton>
        </Box>;
      })}
    </Stack>
    <Tooltip title="New tab (⌘T)"><IconButton aria-label="New tab" onClick={onCreate} sx={{ ml: 0.5, width: 36, height: 36, flexShrink: 0 }}><AddIcon fontSize="small" /></IconButton></Tooltip>
    <Box sx={{ ml: 0.75, pl: 1, pr: 0.25, height: 34, display: "flex", alignItems: "center", borderLeft: 1, borderColor: "divider", flexShrink: 0 }}>
      {activeProjectId ? <TokenUsageButton scope="project" scopeId={activeProjectId} label="Project" /> : <TokenUsageButton scope="overall" label="Overall" />}
    </Box>
    {contextMenu ? <Menu anchorEl={contextMenu.anchor} open onClose={() => setContextMenu(undefined)}>
      <MenuItem onClick={() => beginRename(contextMenu.key, contextMenu.label)}>Rename tab</MenuItem>
      <MenuItem disabled={tabs.length === 1} onClick={() => { onClose(contextMenu.key); setContextMenu(undefined); }}>Close tab</MenuItem>
      <MenuItem disabled={tabs.length === 1} onClick={() => { onCloseOthers(contextMenu.key); setContextMenu(undefined); }}>Close other tabs</MenuItem>
    </Menu> : null}
    <Dialog open={Boolean(renameTarget)} onClose={() => setRenameTarget(undefined)} fullWidth maxWidth="xs">
      <DialogTitle>Rename tab</DialogTitle>
      <DialogContent><TextField
        autoFocus fullWidth label="Tab name" value={renameDraft} sx={{ mt: 1 }}
        inputProps={{ maxLength: 80 }} onChange={(event) => setRenameDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && renameTarget) {
            event.preventDefault(); onRename(renameTarget.key, renameDraft); setRenameTarget(undefined);
          }
        }}
      /></DialogContent>
      <DialogActions>
        <Button onClick={() => setRenameTarget(undefined)}>Cancel</Button>
        <Button variant="contained" onClick={() => {
          if (renameTarget) onRename(renameTarget.key, renameDraft);
          setRenameTarget(undefined);
        }}>Save</Button>
      </DialogActions>
    </Dialog>
  </Stack>;
}
