import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
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
  WorkspacePreferencesDto,
  WorkspaceTriggerDirectoryItemDto,
} from "@ponderosa/core";
import type { ReactNode } from "react";
import { agentStatusPresentation } from "../agents";
import { isOpenAttention, notificationOpenActionCount } from "../attention";
import { engineAvailabilityPresentation } from "../conversationEngine";
import {
  useWorkspaceDirectory,
  workspaceDirectoryItems,
} from "../hooks/useWorkspaceDirectory";
import type { Route } from "../routing";
import { CompactWorkspaceHeader } from "./WorkspaceFrame";
import { useWorkspaceConnection } from "./WorkspaceConnectionContext";
import {
  SemanticStatus,
  semanticAgentStatus,
  type SemanticStatusKind,
} from "./SemanticStatus";

function humanizeStatus(status: string): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase());
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: JSX.Element;
  children: ReactNode;
}): JSX.Element {
  return (
    <Box component="section">
      <Stack direction="row" spacing={2} sx={{ alignItems: "end", mb: 1.25 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" component="h2" fontWeight={800}>{title}</Typography>
          <Typography variant="body2" color="text.secondary">{description}</Typography>
        </Box>
        {action}
      </Stack>
      {children}
    </Box>
  );
}

function SummaryCard({
  label,
  value,
  compactLabel,
  compactValue,
  onClick,
}: {
  label: string;
  value: string | number;
  compactLabel?: string;
  compactValue?: string | number;
  onClick?(): void;
}): JSX.Element {
  const content = (
    <Stack spacing={0.25} sx={{ p: 1.5, minWidth: 0, textAlign: "left" }}>
      <Typography variant="h5" fontWeight={800} noWrap>
        {compactValue === undefined ? value : (
          <><Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>{compactValue}</Box><Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>{value}</Box></>
        )}
      </Typography>
      <Typography variant="body2" color="text.secondary" noWrap>
        {compactLabel === undefined ? label : (
          <><Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>{compactLabel}</Box><Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>{label}</Box></>
        )}
      </Typography>
    </Stack>
  );
  return (
    <Paper variant="outlined" sx={{ minWidth: 0, overflow: "hidden" }}>
      {onClick ? (
        <ButtonBase
          onClick={onClick}
          sx={{
            display: "block",
            width: "100%",
            transition: theme => theme.transitions.create("background-color", {
              duration: theme.transitions.duration.shortest,
            }),
            "&:hover": { bgcolor: "action.hover" },
            "&.Mui-focusVisible": { bgcolor: "action.selected" },
          }}
        >
          {content}
        </ButtonBase>
      ) : content}
    </Paper>
  );
}

function ItemCard({
  icon,
  title,
  detail,
  status,
  statusLabel,
  statusAccessibleLabel,
  statusDetail,
  multilineDetail = false,
  onClick,
}: {
  icon: JSX.Element;
  title: string;
  detail: string;
  status?: SemanticStatusKind;
  statusLabel?: string;
  statusAccessibleLabel?: string;
  statusDetail?: string;
  multilineDetail?: boolean;
  onClick(): void;
}): JSX.Element {
  return (
    <Paper
      variant="outlined"
      sx={{ minWidth: 0, height: "100%", overflow: "hidden" }}
    >
      <ButtonBase
        onClick={onClick}
        sx={{
          width: "100%",
          minHeight: multilineDetail ? 78 : undefined,
          height: "100%",
          p: 1.35,
          gap: 1.25,
          justifyContent: "flex-start",
          textAlign: "left",
          overflow: "hidden",
          transition: theme => theme.transitions.create("background-color", {
            duration: theme.transitions.duration.shortest,
          }),
          "&:hover": { bgcolor: "action.hover" },
          "&.Mui-focusVisible": { bgcolor: "action.selected" },
        }}
      >
        <Box sx={{ width: 36, height: 36, borderRadius: 1.25, bgcolor: "action.selected", color: "text.secondary", display: "grid", placeItems: "center", flexShrink: 0 }}>
          {icon}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography fontWeight={750} noWrap>{title}</Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap={!multilineDetail}
            sx={multilineDetail ? {
              display: "-webkit-box",
              minHeight: "2.7em",
              overflow: "hidden",
              overflowWrap: "anywhere",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2,
              lineHeight: 1.35,
            } : undefined}
          >
            {detail}
          </Typography>
        </Box>
        {status ? (
          <Box sx={{ flexShrink: 0 }}>
            <SemanticStatus
              status={status}
              label={statusLabel}
              detail={statusDetail ?? statusAccessibleLabel}
            />
          </Box>
        ) : null}
      </ButtonBase>
    </Paper>
  );
}

function notificationRoute(notification: WorkspaceNotificationDto): Route | undefined {
  if (!notification.projectId) return undefined;
  if (notification.action?.kind === "open_agent" && notification.action.targetId) {
    return { kind: "agent", projectId: notification.projectId, agentId: notification.action.targetId };
  }
  if (notification.conversationId) {
    return { kind: "conversation", projectId: notification.projectId, conversationId: notification.conversationId };
  }
  if (notification.agentId) {
    return { kind: "agent", projectId: notification.projectId, agentId: notification.agentId };
  }
  return { kind: "project", projectId: notification.projectId };
}

export function HomeView({
  projects,
  projectsLoaded,
  engines,
  notifications,
  notificationCounts,
  preferences,
  onNavigate,
  onCreateProject,
  onOpenInbox,
}: {
  projects: ProjectDto[];
  projectsLoaded: boolean;
  engines: EngineDto[];
  notifications: WorkspaceNotificationDto[];
  notificationCounts?: Pick<WorkspaceNotificationPageDto, "openActionCount">;
  preferences: WorkspacePreferencesDto;
  onNavigate(route: Route): void;
  onCreateProject(): void;
  onOpenInbox(): void;
}): JSX.Element {
  const workspaceConnection = useWorkspaceConnection();
  const directoryOptions = { sort: "last_used" as const };
  const outcomeQuery = useWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>("agent", {
    recentOutcomes: true,
  });
  const activeAgentQuery = useWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>("agent", {
    ...directoryOptions,
    active: true,
  });
  const triggerQuery = useWorkspaceDirectory<WorkspaceTriggerDirectoryItemDto>("trigger", {
    sort: "next_fire",
    onlyEnabled: true,
  });
  const activeAgentDirectory = workspaceDirectoryItems(activeAgentQuery.data?.pages, preferences);
  const outcomeItems = outcomeQuery.data?.pages.flatMap(page => page.items) ?? [];
  const activeItems = [...activeAgentDirectory.starredItems, ...activeAgentDirectory.items];
  const agentNamesById = new Map(
    [...outcomeItems, ...activeItems].map(item => [item.agent.id, item.agent.title]),
  );
  const triggerItems = triggerQuery.data?.pages.flatMap(page => page.items) ?? [];
  const attention = notifications
    .filter(isOpenAttention)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const working = activeItems
    .sort((left, right) => right.health.statusTimestamp.localeCompare(left.health.statusTimestamp));
  const automations = triggerItems;
  const recentOutcomes = outcomeItems.slice(0, 6);
  const provider = engineAvailabilityPresentation(engines);
  const activeCount = activeAgentQuery.requestState.hasResolved
    ? activeAgentQuery.data?.pages.at(-1)?.activeCount ?? 0
    : "—";
  const enabledAutomationCount = triggerQuery.requestState.hasResolved
    ? triggerQuery.data?.pages.at(-1)?.enabledCount ?? 0
    : "—";
  const attentionCount = notificationOpenActionCount(notifications, notificationCounts);

  return (
    <Box className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto" }}>
      <CompactWorkspaceHeader
        icon={<HomeOutlinedIcon />}
        title="Home"
        context="Across every Project"
      />
      <Box sx={{ p: { xs: 2, sm: 3, lg: 4 }, containerType: "inline-size" }}>
        <Stack spacing={3} sx={{ width: "100%", maxWidth: 1320, mx: "auto" }}>
          <Box sx={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 1.25,
            "@container (min-width: 760px)": {
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            },
          }}>
            <SummaryCard label="Active Agents" value={activeCount} onClick={() => onNavigate({ kind: "allAgents" })} />
            <SummaryCard label="Needs Attention" value={attentionCount} onClick={onOpenInbox} />
            <SummaryCard label="Enabled Automations" compactLabel="Automations" value={enabledAutomationCount} onClick={() => onNavigate({ kind: "allTriggers" })} />
            <SummaryCard label="Provider Health" value={provider.label} compactValue={provider.label === "Engine ready" ? "Ready" : provider.label} />
          </Box>

          {projectsLoaded && projects.length === 0 ? (
            <Paper variant="outlined" sx={{ p: 3, textAlign: "center" }}>
              <FolderOutlinedIcon color="action" sx={{ fontSize: 42, mb: 1 }} />
              <Typography variant="h6" fontWeight={800}>Create Your First Project</Typography>
              <Typography color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                Projects organize the Chats, Agents, files, and Automations for a workstream.
              </Typography>
              <Button variant="contained" onClick={onCreateProject}>Create Project</Button>
            </Paper>
          ) : null}

          <Section
            title="Needs Attention"
            description="Decisions, blockers, and failures that still need you."
            action={attentionCount ? <Button onClick={onOpenInbox}>View all</Button> : undefined}
          >
            {attention.length ? (
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" }, gap: 1 }}>
                {attention.slice(0, 6).map(item => {
                  const route = notificationRoute(item);
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
            action={<Button onClick={() => onNavigate({ kind: "allAgents" })}>View all Agents</Button>}
          >
            {working.length ? (
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" }, gap: 1 }}>
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
                      detail={item.project.label}
                      status={semanticAgentStatus(item.health.status)}
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
              <Paper variant="outlined" sx={{ p: 2 }}><Typography color="text.secondary">No Agents are active right now.</Typography></Paper>
            )}
          </Section>

          <Section
            title="Automations"
            description="Enabled schedules and events, ordered by what runs next."
            action={<Button onClick={() => onNavigate({ kind: "allTriggers" })}>View all Automations</Button>}
          >
            {automations.length ? (
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" }, gap: 1 }}>
                {automations.slice(0, 8).map(item => (
                  <ItemCard
                    key={item.trigger.id}
                    icon={<BoltOutlinedIcon />}
                    title={item.trigger.name}
                    detail={`${item.project.label} · ${item.targetAgent?.title ?? "Reassignment required"}`}
                    status={item.trigger.enabled ? "enabled" : "disabled"}
                    onClick={() => onNavigate({ kind: "automation", projectId: item.project.id, triggerId: item.trigger.id })}
                  />
                ))}
              </Box>
            ) : triggerQuery.requestState.isInitialError ? (
              <Alert severity="error" action={<Button onClick={() => void triggerQuery.requestState.retry()}>Retry</Button>}>
                Could not load Automations.
              </Alert>
            ) : triggerQuery.requestState.isInitialLoading ? (
              <Paper variant="outlined" sx={{ p: 2 }}><Typography color="text.secondary">Loading Automations…</Typography></Paper>
            ) : (
              <Paper variant="outlined" sx={{ p: 2 }}><Typography color="text.secondary">No Automations have been configured yet.</Typography></Paper>
            )}
          </Section>

          <Section title="Recent Outcomes" description="The latest finished assigned work across Projects.">
            {recentOutcomes.length ? (
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" }, gap: 1 }}>
                {recentOutcomes.map(item => (
                  <ItemCard
                    key={item.agent.id}
                    icon={<CheckCircleOutlineIcon />}
                    title={item.agent.title}
                    detail={item.project.label}
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
              <Paper variant="outlined" sx={{ p: 2 }}><Typography color="text.secondary">Completed Agent work will appear here.</Typography></Paper>
            )}
          </Section>
        </Stack>
      </Box>
    </Box>
  );
}
