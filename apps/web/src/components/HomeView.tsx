import { HomeLayout, HomeFirstItem, HomeSection as Section, HomeSummaryCard as SummaryCard, HomeItemCard as ItemCard, homeItemsGridSx, homeSummaryGridSx } from "./HomeView.parts";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import {
  Alert,
  Box,
  Button,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import type {
  EngineDto,
  ProjectDto,
  WorkspaceAgentDirectoryItemDto,
  WorkspaceNotificationDto,
  WorkspaceNotificationPageDto,
} from "@ponderosa/core";
import { agentStatusPresentation } from "../agents";
import { isOpenAttention, notificationOpenActionCount } from "../attention";
import { engineAvailabilityPresentation } from "../conversationEngine";
import { notificationNavigationRoute } from "../notificationNavigation";
import {
  useWorkspaceDirectory,
} from "../hooks/useWorkspaceDirectory";
import type { Route } from "../routing";
import { useWorkspaceConnection } from "./WorkspaceConnectionContext";
import {
  semanticAgentStatus,
} from "./SemanticStatus";

function humanizeStatus(status: string): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase());
}

export function HomeView({
  projects,
  projectsLoaded,
  engines,
  enginesLoaded,
  notifications,
  notificationCounts,
  notificationsLoadFailed = false,
  onNavigate,
  onCreateProject,
  onOpenInbox,
}: {
  projects: ProjectDto[];
  projectsLoaded: boolean;
  engines: EngineDto[];
  enginesLoaded: boolean;
  notifications: WorkspaceNotificationDto[];
  notificationCounts?: Pick<WorkspaceNotificationPageDto, "openActionCount">;
  notificationsLoadFailed?: boolean;
  onNavigate(route: Route): void;
  onCreateProject(): void;
  onOpenInbox(): void;
}): JSX.Element {
  const workspaceConnection = useWorkspaceConnection();
  const outcomeQuery = useWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>("agent", {
    recentOutcomes: true,
  });
  const activeAgentQuery = useWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>("agent", {
    active: true,
  });
  const outcomeItems = outcomeQuery.data?.pages.flatMap(page => page.items) ?? [];
  const activeItems = activeAgentQuery.data?.pages.flatMap(page => page.items) ?? [];
  const agentNamesById = new Map(
    [...outcomeItems, ...activeItems].map(item => [item.agent.id, item.agent.title]),
  );
  const attention = notifications
    .filter(isOpenAttention)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const working = activeItems;
  const recentOutcomes = outcomeItems.slice(0, 6);
  const provider = engineAvailabilityPresentation(engines);
  const activeCount = activeAgentQuery.requestState.hasResolved
    ? activeAgentQuery.data?.pages.at(-1)?.activeCount ?? 0
    : activeAgentQuery.requestState.isInitialError ? "Unavailable" : "Loading";
  const attentionCount = notificationOpenActionCount(notifications, notificationCounts);
  const attentionLoading = !notificationCounts;
  const homeLoading = !projectsLoaded || !enginesLoaded ||
    activeAgentQuery.requestState.isInitialLoading ||
    outcomeQuery.requestState.isInitialLoading;
  const homeInitialError = activeAgentQuery.requestState.isInitialError || outcomeQuery.requestState.isInitialError;
  const homeRefreshError = activeAgentQuery.requestState.isRefreshError || outcomeQuery.requestState.isRefreshError;
  const homeRefreshing = activeAgentQuery.requestState.isRefreshing || outcomeQuery.requestState.isRefreshing;

  return (
    <HomeLayout context="Across your chats" loading={homeLoading} status={homeLoading ? "Loading Home summary" : homeInitialError ? "Home summary could not be fully loaded" :
      homeRefreshError ? "Home refresh failed. Last loaded results are still available." :
      homeRefreshing ? "Refreshing Home summary" : "Home summary loaded"}>
          <Box sx={homeSummaryGridSx}>
            <SummaryCard label="Active Agents" value={activeCount} />
            <SummaryCard label="Needs Attention" value={attentionLoading ? notificationsLoadFailed ? "Unavailable" : "Loading" : attentionCount} onClick={onOpenInbox} />
            <SummaryCard label="Provider Health" value={provider.label} compactValue={provider.label === "Engine ready" ? "Ready" : provider.label} onClick={() => onNavigate({ kind: "settings", section: "providers" })} />
          </Box>
          {enginesLoaded && provider.severity === "warning" ? <Alert severity="warning" action={<Button color="inherit" onClick={() => onNavigate({ kind: "settings", section: "providers" })}>Provider Settings</Button>}>
            Provider access needs attention. {provider.detail} This is separate from work waiting for your response.
          </Alert> : null}

          {projectsLoaded && projects.length === 0 ? (
            <HomeFirstItem icon={<FolderOutlinedIcon color="action" sx={{ fontSize: 42, mb: 1 }} />} title="Start Your First Chat" description="Chats bring your messages, agents, and files together.">
              <Button variant="contained" onClick={onCreateProject}>New Chat</Button>
            </HomeFirstItem>
          ) : null}

          <Section
            title="Needs Attention"
            description="Decisions, blockers, and failures that still need you."
            action={!attentionLoading && attentionCount ? <Button onClick={onOpenInbox}>View all</Button> : undefined}
          >
            {attention.length ? (
              <Box sx={homeItemsGridSx}>
                {attention.slice(0, 6).map(item => {
                  const route = notificationNavigationRoute(item);
                  return (
                    <ItemCard
                      key={item.id}
                      icon={<WarningAmberOutlinedIcon color="warning" />}
                      title={item.title}
                      detail={item.body}
                      status="needs_attention"
                      statusLabel={item.severity === "urgent" ? "Urgent" : "Review"}
                      multilineDetail
                      onClick={() => route ? onNavigate(route) : onOpenInbox()}
                    />
                  );
                })}
              </Box>
            ) : attentionLoading ? (
              <Paper variant="outlined" sx={{ p: 2 }}><Typography color="text.secondary">{notificationsLoadFailed ? "Notifications could not be loaded. Open the panel to retry." : "Loading notifications…"}</Typography></Paper>
            ) : attentionCount ? (
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <WarningAmberOutlinedIcon color="warning" />
                  <Typography color="text.secondary" sx={{ flex: 1 }}>
                    {`${attentionCount} item${attentionCount === 1 ? "" : "s"} need your attention.`}
                  </Typography>
                  <Button onClick={onOpenInbox}>Review</Button>
                </Stack>
              </Paper>
            ) : (
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <CheckCircleOutlineIcon color="success" />
                  <Typography color="text.secondary">Nothing currently needs your attention.</Typography>
                </Stack>
              </Paper>
            )}
          </Section>

          <Section
            title="Working Now"
            description="Active and waiting Agent work across the organization."
          >
            {activeAgentQuery.requestState.isRefreshError ? (
              <Alert severity="warning" action={<Button aria-label="Retry refresh of active Agents" aria-busy={activeAgentQuery.requestState.isRefreshing} onClick={() => void activeAgentQuery.requestState.retry()}>Retry</Button>}>
                Could not refresh active Agents. Last loaded results are still available.
              </Alert>
            ) : null}
            {working.length ? (
              <Box sx={homeItemsGridSx}>
                {working.slice(0, 8).map(item => {
                  const presentation = agentStatusPresentation(item.health, {
                    connectionStatus: workspaceConnection.status,
                    phaseEvidenceFresh: workspaceConnection.phaseEvidenceFresh,
                    agentNameForId: agentId => agentNamesById.get(agentId),
                  });
                  return (
                    <ItemCard
                      key={item.agent.id}
                      icon={<SmartToyOutlinedIcon />}
                      title={item.agent.title}
                      detail={`Chat: ${item.ownerConversation?.title ?? "Unavailable"}`}
                      status={presentation.status}
                      statusLabel={presentation.label}
                      statusAccessibleLabel={presentation.accessibleLabel}
                      statusDetail={presentation.detail}
                      onClick={() => onNavigate({ kind: "agent", projectId: item.project.id, agentId: item.agent.id })}
                    />
                  );
                })}
              </Box>
            ) : activeAgentQuery.requestState.isInitialError ? (
              <Alert severity="error" action={<Button onClick={() => void activeAgentQuery.requestState.retry()}>Retry</Button>}>
                Could not load active Agents.
              </Alert>
            ) : activeAgentQuery.requestState.isInitialLoading ? (
              <Paper variant="outlined" sx={{ p: 2 }}><Typography color="text.secondary">Loading active Agents…</Typography></Paper>
            ) : (
              <Paper variant="outlined" sx={{ p: 2 }}><Typography color="text.secondary">{activeAgentQuery.requestState.isRefreshError ? "No active Agents in the last loaded results." : "No Agents are active right now."}</Typography></Paper>
            )}
          </Section>

          <Section title="Recent Outcomes" description="Recently finished assigned work across chats.">
            {outcomeQuery.requestState.isRefreshError ? (
              <Alert severity="warning" action={<Button aria-label="Retry refresh of recent outcomes" aria-busy={outcomeQuery.requestState.isRefreshing} onClick={() => void outcomeQuery.requestState.retry()}>Retry</Button>}>
                Could not refresh recent outcomes. Last loaded results are still available.
              </Alert>
            ) : null}
            {recentOutcomes.length ? (
              <Box sx={homeItemsGridSx}>
                {recentOutcomes.map(item => (
                  <ItemCard
                    key={item.agent.id}
                    icon={<SmartToyOutlinedIcon />}
                    title={item.agent.title}
                    detail={`Chat: ${item.ownerConversation?.title ?? "Unavailable"}`}
                    status={semanticAgentStatus(item.health.assignedWorkOutcome!.status)}
                    statusLabel={humanizeStatus(item.health.assignedWorkOutcome!.status)}
                    onClick={() => onNavigate({ kind: "agent", projectId: item.project.id, agentId: item.agent.id })}
                  />
                ))}
              </Box>
            ) : outcomeQuery.requestState.isInitialError ? (
              <Alert severity="error" action={<Button onClick={() => void outcomeQuery.requestState.retry()}>Retry</Button>}>
                Could not load recent outcomes.
              </Alert>
            ) : outcomeQuery.requestState.isInitialLoading ? (
              <Paper variant="outlined" sx={{ p: 2 }}><Typography color="text.secondary">Loading recent outcomes…</Typography></Paper>
            ) : (
              <Paper variant="outlined" sx={{ p: 2 }}><Typography color="text.secondary">{outcomeQuery.requestState.isRefreshError ? "No recent outcomes in the last loaded results." : "Completed Agent work will appear here."}</Typography></Paper>
            )}
          </Section>
    </HomeLayout>
  );
}
