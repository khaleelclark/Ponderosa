import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import { Box, Button, ButtonBase, Chip, Menu, MenuItem, Paper, Stack, Typography } from "@mui/material";
import type { EngineDto, ProjectDto, WorkspaceNotificationDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { engineAvailabilityPresentation } from "../conversationEngine";
import type { Route } from "../routing";
import { sortWorkspaceResources, starredWorkspaceResources, toggleWorkspaceResourceStar, workspaceResourceSort } from "../resourcePreferences";

type RecentResource = { id: string; title: string; detail: string; updatedAt: string; route: Route; icon: JSX.Element };

export function orderHomeResources<T extends { id: string }>(items: T[], order: string[] = []): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = order.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []);
  const retained = new Set(ordered.map((item) => item.id));
  return [...ordered, ...items.filter((item) => !retained.has(item.id))];
}

export function reorderHomeResources(order: string[] = [], available: string[], sourceId: string, targetId: string): string[] {
  const normalized = [...order.filter((id) => available.includes(id)), ...available.filter((id) => !order.includes(id))];
  const from = normalized.indexOf(sourceId);
  const to = normalized.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return normalized;
  const [moved] = normalized.splice(from, 1);
  normalized.splice(to, 0, moved!);
  return normalized;
}

function Stat({ label, value, onClick }: { label: string; value: string | number; onClick?(): void }): JSX.Element {
  const content = <Stack spacing={0.25} sx={{ p: 1.5, minWidth: 0, textAlign: "left" }}><Typography variant="h5" fontWeight={800}>{value}</Typography><Typography variant="body2" color="text.secondary">{label}</Typography></Stack>;
  return <Paper variant="outlined" sx={{ minWidth: 0, overflow: "hidden" }}>{onClick ? <ButtonBase onClick={onClick} sx={{ display: "block", width: "100%" }}>{content}</ButtonBase> : content}</Paper>;
}

export function HomeView({ projects, engines, notifications, preferences, onNavigate, onOpenInNewTab, onPreferences, onCreateProject, onCreateChat, onCreateAgent, onCreateTrigger, onOpenInbox }: {
  projects: ProjectDto[];
  engines: EngineDto[];
  notifications: WorkspaceNotificationDto[];
  preferences: WorkspacePreferencesDto;
  onNavigate(route: Route): void;
  onOpenInNewTab(route: Route): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onCreateProject(): void;
  onCreateChat(): void;
  onCreateAgent(): void;
  onCreateTrigger(): void;
  onOpenInbox(): void;
}): JSX.Element {
  const [draggedResourceId, setDraggedResourceId] = useState<string>();
  const [tabMenu, setTabMenu] = useState<{ anchor: HTMLElement; route: Route }>();
  const conversationQueries = useQueries({ queries: projects.map((project) => ({ queryKey: ["conversations", project.id], queryFn: () => api.listConversations(project.id), staleTime: 10_000 })) });
  const agentQueries = useQueries({ queries: projects.map((project) => ({ queryKey: ["agents", project.id], queryFn: () => api.listAgents(project.id), staleTime: 5_000 })) });
  const healthQueries = useQueries({ queries: projects.map((project) => ({ queryKey: ["agent-health", project.id], queryFn: () => api.getAgentHealth(project.id), staleTime: 5_000 })) });
  const triggersQuery = useQuery({ queryKey: ["triggers"], queryFn: () => api.listAllTriggers(), staleTime: 5_000 });
  const conversations = conversationQueries.flatMap((query, index) => (query.data ?? []).map((conversation) => ({ conversation, project: projects[index]! })));
  const agents = agentQueries.flatMap((query, index) => (query.data ?? []).map((agent) => ({ agent, project: projects[index]! })));
  const agentDestinations = new Map(agents.map(({ agent, project }) => [agent.id, { agent, project }] as const));
  const activeAgents = healthQueries.reduce((count, query) => count + (query.data?.agents ?? []).filter((item) => item.status === "running" || item.status === "compacting").length, 0);
  const needsAttention = notifications.filter((item) => !item.readAt && (item.severity === "urgent" || item.severity === "attention")).length;
  const unread = notifications.filter((item) => !item.readAt).length;
  const provider = engineAvailabilityPresentation(engines);
  const allResources: RecentResource[] = [
    ...projects.map((project) => ({ id: `project:${project.id}`, title: project.label, detail: "Project", updatedAt: project.lastUsedAt ?? project.createdAt, route: { kind: "project", projectId: project.id } as Route, icon: <FolderOutlinedIcon fontSize="small" /> })),
    ...conversations.filter(({ conversation }) => !conversation.archived).map(({ conversation, project }) => ({ id: `conversation:${conversation.id}`, title: conversation.title, detail: `${project.label} · Chat`, updatedAt: conversation.updatedAt, route: { kind: "conversation", projectId: project.id, conversationId: conversation.id } as Route, icon: <ChatBubbleOutlineIcon fontSize="small" /> })),
    ...agents.filter(({ agent }) => !agent.archived).map(({ agent, project }) => ({ id: `agent:${agent.id}`, title: agent.title, detail: `${project.label} · Agent`, updatedAt: agent.updatedAt, route: { kind: "agent", projectId: project.id, agentId: agent.id } as Route, icon: <PersonOutlineIcon fontSize="small" /> })),
    ...(triggersQuery.data ?? []).flatMap((trigger) => { const destination = agentDestinations.get(trigger.agentId); return destination ? [{ id: `trigger:${trigger.id}`, title: trigger.name, detail: `${destination.project.label} · Trigger`, updatedAt: trigger.updatedAt, route: { kind: "agent", projectId: destination.project.id, agentId: destination.agent.id, view: "triggers" } as Route, icon: <BoltOutlinedIcon fontSize="small" /> }] : []; }),
  ];
  const starredIds = starredWorkspaceResources(preferences);
  const homeSort = workspaceResourceSort(preferences, "home");
  const orderedResources = sortWorkspaceResources(allResources, homeSort, preferences.homeOrder, (item) => item.id, (item) => item.title, (item) => item.updatedAt);
  const starred = orderedResources.filter((item) => starredIds.has(item.id));
  const recent = orderedResources.filter((item) => !starredIds.has(item.id)).slice(0, 10);
  const unstar = (item: RecentResource) => {
    const [kind, id] = item.id.split(":", 2) as ["project" | "conversation" | "agent" | "trigger", string];
    onPreferences(toggleWorkspaceResourceStar(preferences, kind, id));
  };

  return <Box className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", p: { xs: 2, sm: 3, lg: 4 } }}>
    <Stack spacing={3} sx={{ width: "100%", maxWidth: 1320, mx: "auto" }}>
      <Box><Typography variant="h4" component="h1" fontWeight={850}>Home</Typography><Typography color="text.secondary">A calm overview of your organization and its recent work.</Typography></Box>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" }, gap: 1.25 }}>
        <Stat label="Active Agents" value={activeAgents} />
        <Stat label="Needs Attention" value={needsAttention} onClick={onOpenInbox} />
        <Stat label="Unread Messages" value={unread} onClick={() => onNavigate({ kind: "allChat" })} />
        <Stat label="Provider Health" value={provider.label} />
      </Box>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Box sx={{ mb: 1.5 }}><Typography variant="h6" fontWeight={800}>Create</Typography><Typography variant="body2" color="text.secondary">Start with the thing you want; Ponderosa will ask for its scope next.</Typography></Box>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" }, gap: 1 }}>
          <Button variant="contained" startIcon={<FolderOutlinedIcon />} onClick={onCreateProject}>Project</Button>
          <Button variant="outlined" startIcon={<ChatBubbleOutlineIcon />} disabled={!projects.length} onClick={onCreateChat}>Chat</Button>
          <Button variant="outlined" startIcon={<PersonOutlineIcon />} disabled={!projects.length} onClick={onCreateAgent}>Agent</Button>
          <Button variant="outlined" startIcon={<BoltOutlinedIcon />} disabled={!projects.length} onClick={onCreateTrigger}>Trigger</Button>
        </Box>
      </Paper>

      {needsAttention > 0 ? <Paper variant="outlined" sx={{ p: 2, borderColor: "warning.main" }}><Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}><WarningAmberOutlinedIcon color="warning" /><Box sx={{ flex: 1 }}><Typography fontWeight={800}>{needsAttention} {needsAttention === 1 ? "item needs" : "items need"} attention</Typography><Typography variant="body2" color="text.secondary">Review decisions, failures, and other operational issues.</Typography></Box><Button onClick={onOpenInbox}>Open Inbox</Button></Stack></Paper> : null}

      {starred.length ? <Box component="section"><Typography variant="h6" fontWeight={800} sx={{ mb: 1 }}>Starred</Typography><Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">{starred.map((item) => <Chip key={item.id} clickable icon={item.icon} deleteIcon={<StarRoundedIcon />} label={item.title} onClick={() => onNavigate(item.route)} onDelete={() => unstar(item)} onContextMenu={(event) => { event.preventDefault(); setTabMenu({ anchor: event.currentTarget, route: item.route }); }} />)}</Stack></Box> : null}

      <Box component="section">
        <Stack direction="row" sx={{ alignItems: "center", mb: 1 }}><Typography variant="h6" fontWeight={800} sx={{ flex: 1 }}>Recent</Typography><Button size="small" onClick={() => onNavigate({ kind: "allChats" })}>View All Chats</Button></Stack>
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" }, gap: 1 }}>
          {recent.map((item) => <Paper key={item.id} variant="outlined" draggable onDragStart={() => setDraggedResourceId(item.id)} onDragEnd={() => setDraggedResourceId(undefined)} onDragOver={(event) => { if (draggedResourceId) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (draggedResourceId) onPreferences({ homeSort: "custom", homeOrder: reorderHomeResources(preferences.homeOrder, orderedResources.map((entry) => entry.id), draggedResourceId, item.id) }); setDraggedResourceId(undefined); }} onContextMenu={(event) => { event.preventDefault(); setTabMenu({ anchor: event.currentTarget, route: item.route }); }}><ButtonBase onClick={() => onNavigate(item.route)} sx={{ width: "100%", p: 1.5, gap: 1.25, justifyContent: "flex-start", textAlign: "left" }}><Box sx={{ width: 34, height: 34, borderRadius: 1.5, bgcolor: "action.selected", display: "grid", placeItems: "center", flexShrink: 0 }}>{item.icon}</Box><Box sx={{ minWidth: 0 }}><Typography fontWeight={750} noWrap>{item.title}</Typography><Typography variant="caption" color="text.secondary" noWrap>{item.detail}</Typography></Box></ButtonBase></Paper>)}
          {!recent.length ? <Paper variant="outlined" sx={{ p: 3, textAlign: "center" }}><AddIcon color="disabled" /><Typography fontWeight={750}>Your recent work will appear here</Typography><Typography variant="body2" color="text.secondary">Create a Project to begin.</Typography></Paper> : null}
        </Box>
      </Box>
    </Stack>
    {tabMenu ? <Menu anchorEl={tabMenu.anchor} open onClose={() => setTabMenu(undefined)}><MenuItem onClick={() => { onOpenInNewTab(tabMenu.route); setTabMenu(undefined); }}>Open in New Ponderosa Tab</MenuItem></Menu> : null}
  </Box>;
}
